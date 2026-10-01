import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidence, unwrapExec, commandKinds } from './evidence.mjs';
import { distill, observeFile, refreshRepoTruth, sha256 } from './distiller.mjs';

const fixture = entries => ({ session: { cwd: 'D:\\fixture' }, phase0Evidence: {
  capture: { snapshotPath: 'fixture.jsonl', sha256: 'fixture', capturedAt: '2026-01-01T00:00:00Z' },
  records: entries.map((payload, i) => ({ line: i + 1, event: { type: 'response_item', payload } })),
} });
const call = (id, input) => ({ type: 'custom_tool_call', name: 'exec', call_id: id, input });
const result = (id, ...values) => ({ type: 'custom_tool_call_output', call_id: id,
  output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
    ...values.map(v => ({ type: 'input_text', text: JSON.stringify(v) }))] });
const truth = () => ({ capturedAt: 'now', workspace: 'D:\\fixture', stableDuringObservation: true,
  git: { status: 'available', branch: 'main', head: 'abc', changes: [] }, files: [], patchChecks: [], artifactReports: [] });

test('mixed patch {} and failed shell do not inherit outer Script completed success', () => {
  const e = buildEvidence(fixture([call('a', 'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: a.js\\n+x\\n*** End Patch")); text(await tools.exec_command({cmd:"npm test"}));'),
    result('a', {}, { exit_code: 1, output: 'failed' })]));
  assert.equal(e.operations[0].status, 'unknown');
  assert.equal(e.operations[1].status, 'failed');
  assert.ok(e.nodes.some(n => n.kind === 'Test result' && n.status === 'failed'));
});

test('missing result and duplicate call IDs never get guessed associations', () => {
  const missing = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"npm test"}));')]));
  assert.equal(missing.operations[0].confidence, 'Uncertain');
  const duplicate = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"npm test"}));'),
    call('a', 'text(await tools.exec_command({cmd:"npm test"}));'), result('a', { exit_code: 0 })]));
  assert.equal(duplicate.coverage.matchedCalls, 0);
  assert.ok(duplicate.operations.every(o => o.status === 'unknown'));
});

test('JSON with braces and escaped quotes retains output pairing', () => {
  const e = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"one"})); text(await tools.exec_command({cmd:"two"}));'),
    result('a', { exit_code: 0, output: 'hello { \\" }' }, { exit_code: 2, output: 'next' })]));
  assert.deepEqual(e.operations.map(o => o.status), ['succeeded', 'failed']);
});

test('parallel allSettled results are associated by emission order, not completion order', () => {
  const e = buildEvidence(fixture([call('a', 'const r=await Promise.allSettled([tools.exec_command({cmd:"first"}),tools.exec_command({cmd:"second"})]); r.forEach(text);'),
    result('a', { status: 'fulfilled', value: { exit_code: 1 } }, { status: 'fulfilled', value: { exit_code: 0 } })]));
  assert.deepEqual(e.operations.map(o => [o.command, o.status]), [['first', 'failed'], ['second', 'succeeded']]);
});

test('truncated output cannot be repaired by borrowing a later success', () => {
  const r = result('a', { exit_code: 0 });
  r.output.splice(1, 0, { type: 'input_text', text: 'Warning: truncated output\n{"exit_code":' });
  const e = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"first"})); text(await tools.exec_command({cmd:"second"}));'), r]));
  assert.ok(e.operations.every(o => o.status === 'unknown'));
});

test('dynamic code and unexecuted branches never run during static extraction', () => {
  globalThis.phase1Executed = false;
  const p = unwrapExec('globalThis.phase1Executed=true; if(false){text(await tools.exec_command({cmd:"danger"}));}');
  assert.equal(globalThis.phase1Executed, false);
  assert.equal(p.reliable, false);
  assert.equal(p.slots.length, 0);
  const q = unwrapExec('text(await tools.exec_command({cmd:process.env.SECRET}));');
  assert.equal(q.slots[0].args, undefined);
  assert.ok(q.slots[0].unresolved);
  delete globalThis.phase1Executed;
});

test('tool-looking text inside a shell string is not promoted to a real nested call', () => {
  const p = unwrapExec('text(await tools.exec_command({cmd:"echo tools.apply_patch(123)"}));');
  assert.equal(p.slots.length, 1);
  assert.equal(p.slots[0].name, 'exec_command');
});

test('PTY execution joins a later write_stdin result, initial yield is not success', () => {
  const e = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"npm test"}));'), result('a', { session_id: 42, output: '' }),
    call('b', 'text(await tools.write_stdin({session_id:42,chars:""}));'), result('b', { exit_code: 0, output: 'passed' })]));
  assert.equal(e.operations[0].initialOutcome.status, 'running');
  assert.equal(e.operations[0].status, 'succeeded');
  assert.equal(e.operations[0].completionOperationId, 'call:L3/op1');
  assert.equal(e.nodes.find(n => n.kind === 'Test execution').status, 'succeeded');
});

test('PTY completion for a different handle cannot confirm a pending operation', () => {
  const e = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"npm test"}));'), result('a', { session_id: 42 }),
    call('b', 'text(await tools.write_stdin({session_id:43,chars:""}));'), result('b', { exit_code: 0 })]));
  assert.equal(e.operations[0].status, 'running');
  assert.equal(e.operations[0].completionOperationId, undefined);
});

test('test recognizer rejects documentation mentions in node -e and preserves real test commands', () => {
  assert.equal(commandKinds('node -e \'console.log("npm test")\'').test, false);
  for (const c of ['npm test', 'npm.cmd run test', 'node --test test/a.test.mjs', 'pytest -q']) assert.equal(commandKinds(c).test, true, c);
});

test('assistant success claim conflicts with actual failed test and never enters Completed', () => {
  const e = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"npm test"}));'), result('a', { exit_code: 1 }),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '所有测试全部通过，任务已完成。' }] }]));
  const s = distill(e, truth());
  assert.equal(s.completed.length, 0);
  assert.ok(s.openIssues.some(i => i.confidence === 'Uncertain' && i.text.includes('Assistant')));
});

test('failed attempt followed by same-command success is a resolved retry, not a forbidden approach', () => {
  const e = buildEvidence(fixture([call('a', 'text(await tools.exec_command({cmd:"npm install"}));'), result('a', { exit_code: 1 }),
    call('b', 'text(await tools.exec_command({cmd:"npm install"}));'), result('b', { exit_code: 0 })]));
  const s = distill(e, truth());
  assert.equal(s.failed[0].resolvedBy, 'call:L3/op1');
  assert.equal(s.completed.length, 1);
});

test('missing file contradicts creation claim; stored test report does not become a fresh passing test', () => {
  const e = buildEvidence(fixture([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a.js 已创建成功。' }] }]));
  const t = truth();
  t.files.push({ id: 'file:a', path: path.resolve('a.js'), status: 'missing', confidence: 'Confirmed' },
    { id: 'file:report', path: path.resolve('report.json'), status: 'exists', bytes: 100, confidence: 'Confirmed' });
  t.artifactReports.push({ fileEvidenceId: 'file:report', reportedPasses: 15, reportedAt: 'old', sourceHashMatches: false });
  const s = distill(e, t);
  assert.ok(s.openIssues.some(i => i.text.includes('文件当前缺失')));
  assert.equal(s.tests.find(t => t.confidence === 'Inferred').status, undefined);
  assert.equal(s.completed.length, 0);
});

test('workspace refresh observes changed/deleted files; proposed patch does not overwrite repo truth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-phase1-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'current\n');
  const e = { operations: [{ id: 'edit', status: 'unknown', edits: [{ action: 'add', path: file, added: ['old'], removed: [], context: [] }] }], source: { sha256: 'x' } };
  const first = refreshRepoTruth(dir, e);
  assert.equal(first.patchChecks[0].exactAdd, false);
  const firstHash = first.files[0].sha256;
  fs.writeFileSync(file, 'new\n');
  const second = refreshRepoTruth(dir, e);
  assert.notEqual(second.files[0].sha256, firstHash);
  fs.unlinkSync(file); // exactly this fixture file; no recursive cleanup
  assert.equal(refreshRepoTruth(dir, e).files[0].status, 'missing');
  assert.equal(observeFile(dir, path.resolve(dir, '../outside')).status, 'out-of-scope');
});

test('real Phase 0 regression: nested edits, failed install, delayed success, missing boundary remain distinguishable', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const c = JSON.parse(fs.readFileSync(path.resolve(root, '../phase0-continues/output/baseline-context.json'), 'utf8'));
  const e = buildEvidence(c);
  assert.equal(e.coverage.toolCalls, 25);
  assert.equal(e.coverage.matchedCalls, 24);
  assert.equal(e.operations.find(o => o.id === 'call:L65/op2').status, 'failed');
  assert.equal(e.operations.find(o => o.id === 'call:L71/op1').status, 'succeeded');
  assert.equal(e.operations.find(o => o.id === 'call:L65/op1').status, 'unknown');
  assert.equal(e.operations.find(o => o.id === 'call:L190/op1').status, 'unknown');
  assert.equal(new Set(e.operations.flatMap(o => (o.edits || []).map(e => e.path))).size, 3);
  assert.equal(sha256(fs.readFileSync(c.phase0Evidence.capture.snapshotPath)), c.phase0Evidence.capture.sha256);
});
