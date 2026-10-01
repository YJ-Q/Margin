import { parse } from 'acorn';

const unwrap = n => n?.type === 'AwaitExpression' ? n.argument : n;
const member = n => n?.type === 'MemberExpression' && !n.computed
  && n.object.type === 'Identifier' ? `${n.object.name}.${n.property.name}` : '';

function literal(n) {
  if (n?.type === 'Literal' && !n.regex && !n.bigint) return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  if (n?.type === 'UnaryExpression' && n.operator === '-' && typeof literal(n.argument) === 'number') return -literal(n.argument);
  if (n?.type === 'ArrayExpression') return n.elements.map(literal);
  if (n?.type === 'ObjectExpression') {
    const value = Object.create(null);
    for (const p of n.properties) {
      if (p.type !== 'Property' || p.computed || p.method || p.kind !== 'init') throw Error('Dynamic object');
      value[p.key.name ?? p.key.value] = literal(p.value);
    }
    return value;
  }
  throw Error('Nonliteral argument');
}

function tool(n, source) {
  n = unwrap(n);
  const name = member(n?.callee);
  if (n?.type !== 'CallExpression' || !name.startsWith('tools.')) return null;
  let args, unresolved;
  try { args = literal(n.arguments[0]); } catch { unresolved = 'Arguments are dynamic; not evaluated'; }
  return { name: name.slice(6), args, unresolved, codeRange: [n.start, n.end], code: source.slice(n.start, n.end) };
}

// Recognize only emitted, unconditional top-level calls. Never eval/Function/vm.
// Branches, arbitrary callbacks, aliasing and dynamic code are not execution evidence.
export function unwrapExec(source) {
  const slots = [], variables = new Map(), warnings = [];
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch (e) { return { slots, warnings: [`JavaScript parse failed at ${e.pos}`], reliable: false }; }
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const d of statement.declarations) {
        const init = unwrap(d.init);
        if (d.id.type === 'Identifier' && init?.type === 'CallExpression'
          && ['Promise.all', 'Promise.allSettled'].includes(member(init.callee))
          && init.arguments[0]?.type === 'ArrayExpression') {
          const ops = init.arguments[0].elements.map(n => tool(n, source));
          if (ops.every(Boolean)) variables.set(d.id.name, ops);
          else warnings.push('Unsupported parallel expression');
        } else warnings.push('Unsupported variable declaration');
      }
    } else if (statement.type === 'ExpressionStatement') {
      const e = unwrap(statement.expression);
      if (e?.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === 'text') {
        slots.push(tool(e.arguments[0], source)); // null preserves non-tool output position
      } else if (e?.type === 'CallExpression' && e.callee.type === 'MemberExpression'
        && member(e.callee).endsWith('.forEach') && e.arguments[0]?.name === 'text'
        && variables.has(e.callee.object.name)) slots.push(...variables.get(e.callee.object.name));
      else warnings.push('Unsupported execution/emission shape');
    } else warnings.push(`Unsupported statement ${statement.type}`);
  }
  return { slots, warnings, reliable: warnings.length === 0 };
}

// Parse concatenated JSON values ONLY at the start of tool-emitted text.
// Never search arbitrary stdout for a convenient success object.
function jsonValues(text) {
  const values = [];
  let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] || '') && i < text.length) i++;
    if (i === text.length) break;
    if (!['{', '['].includes(text[i])) throw Error('Non-JSON or truncated emitted output');
    const start = i, stack = [];
    let quoted = false, escaped = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') { stack.pop(); if (!stack.length) { i++; break; } }
    }
    if (stack.length || quoted) throw Error('Truncated JSON value');
    values.push(JSON.parse(text.slice(start, i)));
  }
  return values;
}

export function decodeOutput(output) {
  const blocks = Array.isArray(output) ? output.filter(x => typeof x.text === 'string').map(x => x.text)
    : [typeof output === 'string' ? output : JSON.stringify(output)];
  const values = [], warnings = [];
  let cellId = null, completed = false;
  for (let block of blocks) {
    if (/^Script (?:completed|running|failed)/.test(block)) {
      const id = block.match(/^Script running with cell ID (\S+)/);
      if (id) cellId = id[1];
      if (/^Script completed/.test(block)) completed = true;
      const start = block.indexOf('Output:\n');
      block = start >= 0 ? block.slice(start + 8) : '';
    }
    if (!block.trim()) continue;
    try { values.push(...jsonValues(block)); }
    catch (e) { warnings.push(e.message); }
  }
  return { values, warnings, cellId, completed };
}

export function patchEdits(patch) {
  const edits = [];
  let current;
  for (const line of patch.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) { current = { action: m[1].toLowerCase(), path: m[2], added: [], removed: [], context: [] }; edits.push(current); }
    else if (current && line.startsWith('*** Move to: ')) current.moveTo = line.slice(13);
    else if (current && !line.startsWith('***')) {
      if (line.startsWith('+')) current.added.push(line.slice(1));
      else if (line.startsWith('-')) current.removed.push(line.slice(1));
      else if (line.startsWith(' ')) current.context.push(line.slice(1));
    }
  }
  return edits;
}

export function commandKinds(command) {
  // A bounded, anchored recognizer; quoted command text inside `node -e` is not a test run.
  const c = command.trim();
  const test = /^(?:&\s*)?(?:"[^"]*(?:node|npm|pnpm|npx|pytest)[^"]*"|[^\s]*(?:node(?:\.exe)?|npm(?:\.cmd)?|pnpm|npx|pytest))\s+(?:--test(?:\s|$)|(?:run\s+)?test(?:\s|$)|vitest\b|jest\b)/i.test(c)
    || /^(?:pytest|cargo\s+test|go\s+test)(?:\s|$)/i.test(c);
  return { shell: true, test, git: /^(?:git)(?:\s|$)/i.test(c),
    possibleWrite: /(?:Set-Content|Add-Content|Out-File|writeFile(?:Sync)?|\bsed\s+-i\b|\btee\b)/i.test(c) };
}

function outcome(value, name) {
  if (value?.status === 'fulfilled') value = value.value;
  else if (value?.status === 'rejected') return { status: 'failed', confidence: 'Confirmed', reason: 'Promise rejected', value };
  if (value?.isError === true) return { status: 'failed', confidence: 'Confirmed', reason: 'Explicit tool error', value };
  if (typeof value?.exit_code === 'number') return { status: value.exit_code === 0 ? 'succeeded' : 'failed',
    confidence: 'Confirmed', reason: `exit_code=${value.exit_code}`, value };
  if (value?.session_id !== undefined) return { status: 'running', confidence: 'Confirmed', reason: 'Process handle returned', value };
  if (name === 'apply_patch' && typeof value === 'string' && /^Success\. Updated the following files:/m.test(value))
    return { status: 'succeeded', confidence: 'Confirmed', reason: 'Explicit patch success result', value };
  return { status: 'unknown', confidence: 'Uncertain', reason: 'No explicit success/failure in result', value };
}

export function buildEvidence(context) {
  const source = context.phase0Evidence;
  if (!source?.records || !source.capture?.sha256) throw Error('Phase 0 evidence envelope required');
  const nodes = [], operations = [], warnings = [];
  const calls = source.records.filter(r => r.event?.type === 'response_item'
    && ['function_call', 'custom_tool_call'].includes(r.event.payload?.type));
  const results = source.records.filter(r => r.event?.type === 'response_item'
    && ['function_call_output', 'custom_tool_call_output'].includes(r.event.payload?.type));
  const pointer = (line, extra = {}) => ({ path: source.capture.snapshotPath, sha256: source.capture.sha256, line, ...extra });
  for (const r of source.records) {
    const p = r.event?.payload;
    if (r.event?.type !== 'response_item' || p?.type !== 'message') continue;
    const text = p.content?.filter(c => typeof c.text === 'string').map(c => c.text).join('\n') || '';
    if (p.role === 'user' && !/^\s*(?:<recommended_plugins>|<environment_context>|<permissions|# AGENTS\.md)/.test(text))
      nodes.push({ id: `requirement:L${r.line}`, kind: 'User requirement', confidence: 'Confirmed',
        scope: 'The request was made, not that it was completed', text, evidence: [pointer(r.line)] });
    else if (p.role === 'assistant') nodes.push({ id: `claim:L${r.line}`, kind: 'Assistant claim', confidence: 'Inferred',
      scope: 'Unverified narrative; not completion evidence', text, evidence: [pointer(r.line)] });
  }
  const waitCalls = calls.filter(r => r.event.payload.name === 'wait');
  for (const call of calls) {
    const p = call.event.payload, id = `call:L${call.line}`;
    const matches = p.call_id ? results.filter(r => r.line > call.line && r.event.payload.call_id === p.call_id) : [];
    const duplicateId = calls.filter(r => r.event.payload.call_id === p.call_id).length > 1;
    const matched = matches.length === 1 && !duplicateId ? matches : [];
    nodes.push({ id, kind: 'Tool call', confidence: 'Confirmed', name: p.name, callId: p.call_id,
      evidence: [pointer(call.line)], resultIds: matched.map(r => `result:L${r.line}`) });
    for (const r of matched) nodes.push({ id: `result:L${r.line}`, kind: 'Tool result', confidence: 'Confirmed',
      callId: p.call_id, evidence: [pointer(r.line)], scope: 'Output observed; success evaluated per nested operation' });
    if (p.name === 'wait') continue; // linked to the originating exec below
    let args;
    try { args = JSON.parse(p.arguments); } catch { args = p.input; }
    const plan = p.name === 'exec' && typeof p.input === 'string' ? unwrapExec(p.input)
      : { slots: [{ name: p.name, args }], reliable: true, warnings: [] };
    const emitted = [], resultLines = matched.map(r => r.line);
    let decodeWarnings = [], pendingCell;
    for (const r of matched) {
      if (p.name === 'exec') {
        const decoded = decodeOutput(r.event.payload.output);
        emitted.push(...decoded.values); decodeWarnings.push(...decoded.warnings); pendingCell = decoded.cellId;
      } else {
        const value = r.event.payload.output;
        try { emitted.push(typeof value === 'string' ? JSON.parse(value) : value); } catch { emitted.push(value); }
      }
    }
    // Continuation waits may deliver the remaining emitted values of one exec cell.
    if (pendingCell) {
      for (const w of waitCalls.filter(w => w.line > call.line)) {
        let wa; try { wa = JSON.parse(w.event.payload.arguments); } catch { continue; }
        if (String(wa.cell_id) !== String(pendingCell)) continue;
        const wr = results.filter(r => r.line > w.line && r.event.payload.call_id === w.event.payload.call_id);
        if (wr.length !== 1) { decodeWarnings.push('Missing/ambiguous exec wait result'); continue; }
        const d = decodeOutput(wr[0].event.payload.output);
        emitted.push(...d.values); resultLines.push(wr[0].line); decodeWarnings.push(...d.warnings);
        if (d.completed) break;
      }
    }
    const canMap = plan.reliable && !decodeWarnings.length && emitted.length === plan.slots.length && matched.length === 1;
    const localWarnings = [...plan.warnings, ...decodeWarnings];
    if (!canMap) localWarnings.push('No reliable one-to-one ordered mapping for emitted slots');
    if (!plan.slots.filter(Boolean).length) operations.push({ id: `${id}/opaque`, name: p.name,
      status: 'unknown', confidence: 'Uncertain', reason: 'Unsupported exec shape; inspect original evidence',
      evidence: [pointer(call.line), ...resultLines.map(l => pointer(l))] });
    plan.slots.forEach((slot, i) => {
      if (!slot) return;
      const state = canMap ? outcome(emitted[i], slot.name)
        : { status: 'unknown', confidence: 'Uncertain', reason: 'Missing, partial, ambiguous or unmappable output' };
      const operation = { id: `${id}/op${i + 1}`, parentCallId: id, name: slot.name,
        args: slot.args, ...state, mapping: canMap ? 'static ordered emission' : 'unresolved',
        evidence: [pointer(call.line, { codeRange: slot.codeRange }), ...resultLines.map(l => pointer(l, { outputSlot: canMap ? i : null }))],
        warnings: [...localWarnings, ...(slot.unresolved ? [slot.unresolved] : [])] };
      if (['exec_command', 'shell_command', 'shell'].includes(slot.name)) {
        operation.command = slot.args?.cmd ?? slot.args?.command;
        if (Array.isArray(operation.command)) operation.command = operation.command.join(' ');
        if (typeof operation.command === 'string') {
          operation.kinds = commandKinds(operation.command);
          operation.cwd = slot.args?.workdir ?? slot.args?.cwd ?? context.session.cwd;
          nodes.push({ id: `${operation.id}/shell`, kind: 'Shell command', confidence: 'Confirmed',
            scope: 'Literal call intent, execution outcome tracked separately', operationId: operation.id, evidence: operation.evidence });
          if (operation.kinds.possibleWrite) nodes.push({ id: `${operation.id}/possible-write`, kind: 'File edit/write', confidence: 'Uncertain',
            scope: 'Shell text suggests writes; individual writes and their outcomes are not parsed/proven',
            operationId: operation.id, evidence: operation.evidence });
          if (operation.kinds.test) nodes.push({ id: `${operation.id}/test`, kind: 'Test execution', confidence: operation.confidence,
            operationId: operation.id, status: operation.status, evidence: operation.evidence });
        }
      }
      if (slot.name === 'apply_patch' && typeof slot.args === 'string') operation.edits = patchEdits(slot.args);
      if (['edit_file', 'write_file'].includes(slot.name) && typeof slot.args === 'object') operation.edits = [{
        action: slot.name === 'write_file' ? 'write' : 'edit', path: slot.args.path ?? slot.args.file_path,
        added: typeof slot.args.content === 'string' ? slot.args.content.split('\n') : [], removed: [], context: [],
      }].filter(e => e.path);
      for (const [j, edit] of (operation.edits || []).entries()) nodes.push({ id: `${operation.id}/edit${j + 1}`,
        kind: 'File edit/write', confidence: operation.confidence, status: operation.status,
        path: edit.path, operationId: operation.id, evidence: operation.evidence });
      operations.push(operation);
    });
    warnings.push(...localWarnings.map(message => ({ callId: id, message })));
  }
  // A PTY handle joins later write_stdin completions; do not equate initial yield with success.
  for (const op of operations.filter(o => o.status === 'running' && o.name === 'exec_command')) {
    const polls = operations.filter(o => o.name === 'write_stdin' && o.args?.session_id === op.value.session_id
      && o.evidence[0].line > op.evidence[0].line);
    const end = polls.find(p => ['succeeded', 'failed'].includes(p.status));
    if (end) { op.initialOutcome = { status: op.status, value: op.value }; op.status = end.status;
      op.confidence = end.confidence; op.value = end.value; op.reason = `PTY completion via ${end.id}: ${end.reason}`;
      op.completionOperationId = end.id; op.evidence.push(...end.evidence); }
  }
  for (const op of operations.filter(o => o.kinds?.test)) nodes.push({ id: `${op.id}/test-result`, kind: 'Test result',
    confidence: op.confidence, status: op.status, operationId: op.id,
    scope: 'Process exit result, not proof of any named assertion unless reported', evidence: op.evidence });
  for (const node of nodes.filter(n => n.kind === 'Test execution')) {
    const op = operations.find(o => o.id === node.operationId);
    node.status = op.status; node.confidence = op.confidence; node.evidence = op.evidence;
  }
  return { schemaVersion: 'margin.evidence.v1', source: source.capture, nodes, operations, warnings,
    coverage: { rawRecords: source.records.length, toolCalls: calls.length, toolResults: results.length,
      matchedCalls: nodes.filter(n => n.kind === 'Tool call' && n.resultIds.length).length } };
}
