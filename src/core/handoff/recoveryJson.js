// Gate 1 of the Phase 0/1 PoC Review (docs/validation/margin_poc_review_conclusion.md):
// force + fall back to a STRUCTURED resumption output so a handoff is no longer scored as a total
// loss when the resuming model does not hand back machine-readable JSON.
//
// This module is deliberately transport-free and browser-safe (no imports): it does not call any
// model. It supplies the three reusable pieces a resumption runner needs:
//   1. extractRecoveryObject — a string-aware, tolerant JSON extractor over arbitrary final text;
//   2. validateRecoveryObject — a closed-schema check/normaliser for the resumption state;
//   3. buildStructuredRecoveryRequest — the response_format contract and the no-tool recovery turn
//      used when a run stops on a tool call with no final answer.
//
// Why a tolerant extractor is necessary (evidence: continuation-ab-deepseek-r7-runs/formal):
// two of twelve R7 B-runs were scored 0/5 as "NO-JSON", but for different reasons:
//   - case-09-B emitted valid JSON preceded by ~1KB of prose with no code fence — a naive
//     "whole text is JSON / fenced block only" parser rejected it even though the object was intact;
//   - case-02-B stopped after ~55 exploration tool calls with an EMPTY final text — no parser can
//     recover content that was never emitted; that case needs the structured request + recovery turn.
// Several other runs (04/05/06/08/11) appended a trailing ``` fence after an otherwise valid object.

// The five fields the frozen ground truth scores (see margin_poc_review_conclusion.md §2). Each must
// be present and non-empty for a resumption result to count as fully recovered.
export const RECOVERY_REQUIRED_FIELDS = Object.freeze([
  'goal',
  'progress',
  'pending',
  'historicalValidation',
  'recommendedFollowUp'
]);

// The full closed object the resuming model is asked to emit. The two extra fields carry useful,
// non-graded honesty metadata and are optional for scoring.
export const RECOVERY_OPTIONAL_FIELDS = Object.freeze(['currentApplicability', 'unsafeAssumptions']);
export const RECOVERY_ALL_FIELDS = Object.freeze([...RECOVERY_REQUIRED_FIELDS, ...RECOVERY_OPTIONAL_FIELDS]);

const TEXT_FIELDS = Object.freeze([
  'goal',
  'progress',
  'pending',
  'historicalValidation',
  'recommendedFollowUp',
  'currentApplicability'
]);

const MAX_REASONABLE_DEPTH = 200;

// Escape raw control characters that may appear literally inside JSON strings in model output
// (legal JSON requires \n/\t escapes). Only applied on the repair path; clean output is parsed
// verbatim so we never silently accept malformed JSON when well-formed JSON is available.
function escapeRawStringControls(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (code === 0x0a) { out += '\\n'; continue; }
      if (code === 0x0d) { out += '\\r'; continue; }
      if (code === 0x09) { out += '\\t'; continue; }
      if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

// Return the index just past the matching close bracket for the opening bracket at `start`, honoring
// JSON strings and escapes. Returns -1 if the text ends before the bracket closes (truncated).
function balancedEnd(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1; // mismatched bracket: this span cannot be a JSON object/array
      if (stack.length === 0) return i + 1;
      if (stack.length > MAX_REASONABLE_DEPTH) return -1;
    }
  }
  return -1;
}

// Close a JSON text truncated mid-value by appending the still-open brackets (strings too). This
// recovers JSON cut off by an output-token cap; it never fabricates field content.
function closeTruncated(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let closed = text;
  if (inString) closed += '"';
  while (stack.length) closed += stack.pop();
  return closed;
}

function tryParse(candidate) {
  try { return { value: JSON.parse(candidate) }; }
  catch (error) {
    // One repair attempt only: tolerate raw control chars, then tolerate a truncated tail.
    const sanitised = escapeRawStringControls(candidate);
    for (const repaired of [sanitised, closeTruncated(sanitised)]) {
      if (repaired === candidate) continue;
      try { return { value: JSON.parse(repaired), repaired: true }; }
      catch { /* try next repair */ }
    }
    return { error };
  }
}

// Tolerant extraction of the first balanced JSON object in arbitrary final text.
// Returns { ok, value, mode } or { ok:false, code } where code is one of:
//   empty_final_text | no_json_object | json_not_object | invalid_json
export function extractRecoveryObject(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text.trim()) return { ok: false, code: 'empty_final_text' };

  // Try every top-level opening brace in order; accept the first balanced span that parses to an
  // object. This handles prose prefixes/suffixes, fenced blocks, and trailing fences uniformly.
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    // The balanced scanner is string-aware: a '{' inside prose quotes simply fails to balance, so we
    // move on to the next candidate rather than rejecting the whole text.
    const end = balancedEnd(text, i);
    const truncated = end === -1;
    const candidate = truncated ? closeTruncated(text.slice(i)) : text.slice(i, end);
    const parsed = tryParse(candidate);
    if (parsed.value !== undefined) {
      if (typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
        const mode = (parsed.repaired || truncated) ? 'repaired' : (i === 0 && end === text.length ? 'clean' : 'embedded');
        return { ok: true, value: parsed.value, mode };
      }
      // Balanced JSON but not an object (e.g. a bare array) — keep looking for the state object.
      continue;
    }
    if (truncated) break; // only one unbalanced (truncated) object can start at or after this point
  }
  return { ok: false, code: text.includes('{') ? 'invalid_json' : 'no_json_object' };
}

function normaliseTextField(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((part) => (typeof part === 'string' ? part : (part == null ? '' : String(part))).trim())
      .filter(Boolean)
      .join('\n');
    return joined.length ? joined : null;
  }
  if (value == null) return null;
  const coerced = String(value).trim();
  return coerced.length ? coerced : null;
}

function normaliseAssumptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : (item == null ? '' : String(item))).trim())
    .filter(Boolean);
}

// Validate/normalise an extracted value against the closed resumption schema. Does not throw.
// Missing/empty required fields and type problems are reported rather than invented.
export function validateRecoveryObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, missingRequired: [...RECOVERY_REQUIRED_FIELDS], typeIssues: ['recovery payload is not an object'], normalized: null };
  }
  const normalized = {};
  const missingRequired = [];
  const typeIssues = [];

  for (const field of TEXT_FIELDS) {
    if (field === 'currentApplicability' && !(field in value)) continue; // optional
    const text = normaliseTextField(value[field]);
    if (text === null) {
      if (RECOVERY_REQUIRED_FIELDS.includes(field)) missingRequired.push(field);
      continue;
    }
    normalized[field] = text;
  }

  if ('unsafeAssumptions' in value && value.unsafeAssumptions != null) {
    if (!Array.isArray(value.unsafeAssumptions)) typeIssues.push('unsafeAssumptions must be an array of strings');
    else normalized.unsafeAssumptions = normaliseAssumptions(value.unsafeAssumptions);
  }

  const allowed = new Set(RECOVERY_ALL_FIELDS);
  const extraFields = Object.keys(value).filter((key) => !allowed.has(key));

  return {
    valid: missingRequired.length === 0 && typeIssues.length === 0,
    missingRequired,
    typeIssues,
    extraFields,
    normalized
  };
}

// One-call convenience: raw final text -> a discriminated resumption verdict.
//   status: 'ready'        — object parsed, schema complete; `value` is the normalised state.
//   status: 'recoverable'  — parsed but missing required keys / wrong types; one focused retry may fix.
//   status: 'needs_recovery'— no usable object (empty text / no JSON); invoke the recovery turn.
export function parseRecovery(rawText) {
  const extracted = extractRecoveryObject(rawText);
  if (!extracted.ok) {
    return {
      status: 'needs_recovery',
      reason: extracted.code,
      // An empty final text means the model spent its turn on tools; unparseable text may still be
      // salvageable by asking the model to re-emit JSON, but both flow through the recovery turn.
      retryWithoutTools: extracted.code === 'empty_final_text'
    };
  }
  const validation = validateRecoveryObject(extracted.value);
  if (validation.valid) {
    return { status: 'ready', value: validation.normalized, parseMode: extracted.mode, extraFields: validation.extraFields };
  }
  return {
    status: 'recoverable',
    reason: validation.missingRequired.length ? 'missing_required_fields' : 'schema_type_error',
    missingRequired: validation.missingRequired,
    typeIssues: validation.typeIssues,
    partial: validation.normalized
  };
}

// JSON Schema (OpenAI/DeepSeek-compatible, strict) for the resumption state.
export const RECOVERY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: { type: 'string', description: 'The interrupted task goal, carried over faithfully.' },
    progress: { type: 'string', description: 'Completed, evidence-backed work, in order.' },
    pending: { type: 'string', description: 'Open questions, undone work, and unresolved blockers.' },
    historicalValidation: { type: 'string', description: 'Historical test/build/verification results and their provenance.' },
    recommendedFollowUp: { type: 'string', description: 'The concrete next action for the resuming agent.' },
    currentApplicability: { type: 'string', description: 'How applicable the historical state is to the current checkout.' },
    unsafeAssumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions made without direct evidence.' }
  },
  required: [...RECOVERY_REQUIRED_FIELDS, 'currentApplicability', 'unsafeAssumptions']
});

const OUTPUT_CONTRACT_INSTRUCTION = [
  'You are resuming an interrupted development task from the provided handoff.',
  'Respond with ONE JSON object and no prose, no markdown, and no code fence.',
  'Use exactly these keys:',
  `  ${RECOVERY_ALL_FIELDS.join(', ')}.`,
  `The required text fields are: ${RECOVERY_REQUIRED_FIELDS.join(', ')}.`,
  'currentApplicability is a string; unsafeAssumptions is an array of strings (use [] if none).',
  'Do not call any tools while producing this final JSON.'
].join('\n');

// Assemble the structured-output request a resumption runner passes to its model.
// `mode` selects native json_schema when the provider supports it, else the json_object fallback
// (still paired with the explicit text instruction). Callers that cannot use either should append
// `instruction` to the prompt and rely on extractRecoveryObject as the last line of defence.
export function buildStructuredRecoveryRequest({ mode = 'json_schema', signal = 'recovery_state' } = {}) {
  if (mode === 'json_schema') {
    return {
      instruction: OUTPUT_CONTRACT_INSTRUCTION,
      responseFormat: { type: 'json_schema', json_schema: { name: signal, strict: true, schema: RECOVERY_JSON_SCHEMA } }
    };
  }
  if (mode === 'json_object') {
    return { instruction: OUTPUT_CONTRACT_INSTRUCTION, responseFormat: { type: 'json_object' } };
  }
  return { instruction: OUTPUT_CONTRACT_INSTRUCTION, responseFormat: undefined };
}

// The follow-up turn used when a run produced no parseable object. For a tool-only stop it MUST be a
// fresh turn with tool use disabled, since the model already finished exploring and merely failed to
// write its answer; for malformed text it asks for a strict re-emit of the same state.
export function buildRecoveryTurnMessage(reason) {
  if (reason === 'empty_final_text') {
    return [
      'You finished exploring but did not return the resumption result.',
      'Do not call any more tools. Based ONLY on the evidence already gathered and the handoff,',
      'output the single JSON object now with the keys',
      `${RECOVERY_ALL_FIELDS.join(', ')}.`,
      'No prose, no code fence.'
    ].join(' ');
  }
  return [
    'Your previous answer was not machine-readable JSON.',
    'Re-output the same resumption state as ONE JSON object with the keys',
    `${RECOVERY_ALL_FIELDS.join(', ')}, with required fields ${RECOVERY_REQUIRED_FIELDS.join(', ')}.`,
    'No prose, no markdown, no code fence, no tool calls.'
  ].join(' ');
}
