import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { adapterFor } from '../src/agents/adapters.js';
import { discoverSessions as discoverCodexSessions } from '../src/core/handoff/session-source.js';
import { childRuntimeEnv, readClaudeArchiveState } from '../src/agents/claude/claudeArchiveState.js';

test('Claude archive helper runs the bundled Electron executable in Node mode only when needed', () => {
  assert.deepEqual(childRuntimeEnv({ env: { SAFE: 'value' }, electron: true }), { SAFE: 'value', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(childRuntimeEnv({ env: { SAFE: 'value' }, electron: false }), { SAFE: 'value' });
});

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-external-session-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function jsonl(records, partial = '') { return `${records.map(JSON.stringify).join('\n')}\n${partial}`; }

test('Claude discovers only top-level recoverable sessions and ignores partial/internal files', async (t) => {
  const home = fixture(t); const dir = path.join(home, 'projects', 'D--repo'); fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc.jsonl'), jsonl([
    { type: 'user', sessionId: 'claude-id', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z' },
    { type: 'assistant', timestamp: '2026-09-01T01:00:00Z', message: { role: 'assistant', model: 'claude-sonnet' } },
  ], '{"type":"assistant"'));
  fs.writeFileSync(path.join(dir, 'subagents', 'hidden.jsonl'), jsonl([{ sessionId: 'hidden', cwd: 'D:/repo', timestamp: '2026-09-02T00:00:00Z' }]));
  fs.writeFileSync(path.join(dir, 'internal.jsonl'), jsonl([{ sessionId: 'internal', agentId: 'agent-x', cwd: 'D:/repo', timestamp: '2026-09-02T00:00:00Z' }]));
  const sessions = await adapterFor('claude').collectSessionSnapshots({ type: 'claude', path: home, sourceId: 'claude-source' });
  assert.equal(sessions.length, 1); assert.equal(sessions[0].nativeSessionId, 'claude-id'); assert.equal(sessions[0].updatedAt, '2026-09-01T01:00:00.000Z');
  assert.equal(sessions[0].model, 'claude-sonnet'); assert.equal(sessions[0].executionStatus, 'unknown'); assert.equal(sessions[0].attentionStatus, 'none'); assert.equal(sessions[0].canonicalId, 'claude:claude-source:claude-id');
  assert.equal(sessions[0].capabilities.executionStatus, true); assert.equal(sessions[0].capabilities.attentionStatus, false);
  assert.equal(sessions[0].displayTitle, 'Untitled session · claude-i'); assert.equal(sessions[0].titleSource, 'fallback-id');
});

test('Claude discovery filters native programmatic and daemon sessions before projection', async (t) => {
  const home = fixture(t); const dir = path.join(home, 'projects', 'D--other-workspace'); fs.mkdirSync(dir, { recursive: true });
  const cases = [
    ['sdk-cli', { entrypoint: 'sdk-cli' }],
    ['sdk-ts', { entrypoint: 'sdk-ts' }],
    ['sdk-py', { entrypoint: 'sdk-py' }],
    ['daemon', { sessionKind: 'daemon' }],
    ['daemon-worker', { sessionKind: 'daemon-worker' }],
  ];
  for (const [id, marker] of cases) {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), jsonl([
      { type: 'user', sessionId: id, cwd: 'D:/other-workspace', timestamp: '2026-09-01T00:00:00Z', ...marker, message: { content: [{ type: 'text', text: id }] } },
      { type: 'assistant', sessionId: id, timestamp: '2026-09-01T01:00:00Z', message: { role: 'assistant', model: 'claude-sonnet' } },
    ]));
  }
  fs.writeFileSync(path.join(dir, 'normal-vscode.jsonl'), jsonl([
    { type: 'user', sessionId: 'normal-vscode', cwd: 'D:/other-workspace', timestamp: '2026-09-01T00:00:00Z', entrypoint: 'claude-vscode', message: { content: [{ type: 'text', text: 'normal' }] } },
    { type: 'assistant', sessionId: 'normal-vscode', timestamp: '2026-09-01T01:00:00Z', message: { role: 'assistant', model: 'claude-sonnet' } },
  ]));
  const sessions = await adapterFor('claude').collectSessionSnapshots({ type: 'claude', path: home, sourceId: 'claude-source' });
  assert.deepEqual(sessions.map((session) => session.nativeSessionId), ['normal-vscode']);
  assert.equal(sessions[0].cwd, 'D:/other-workspace', 'normal Claude sessions remain global across workspaces');
});

test('Claude discovery preserves normal foreground CLI/native sessions', async (t) => {
  const home = fixture(t); const dir = path.join(home, 'projects', 'D--cli-workspace'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'normal-cli.jsonl'), jsonl([
    { type: 'user', sessionId: 'normal-cli', cwd: 'D:/cli-workspace', timestamp: '2026-09-01T00:00:00Z', entrypoint: 'claude', message: { content: [{ type: 'text', text: 'continue this foreground session' }] } },
    { type: 'assistant', sessionId: 'normal-cli', timestamp: '2026-09-01T01:00:00Z', message: { role: 'assistant', model: 'claude-sonnet' } },
  ]));
  const [session] = await adapterFor('claude').collectSessionSnapshots({ type: 'claude', path: home, sourceId: 'claude-source' });
  assert.equal(session.nativeSessionId, 'normal-cli');
});

function claudeFixture(home, id = 'claude-id') {
  const dir = path.join(home, 'projects', 'D--repo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), jsonl([
    { type: 'user', sessionId: id, cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant', sessionId: id, timestamp: '2026-09-01T01:00:00Z', message: { role: 'assistant', model: 'claude-sonnet' } },
  ]));
  return dir;
}

test('Claude archive truth filters an archived native session before projection', async (t) => {
  const home = fixture(t); claudeFixture(home);
  const source = { type: 'claude', path: home, sourceId: 'claude-source' };
  const archived = () => ({ ok: true, authoritative: true, status: 'ok', archivedIds: ['claude-id'] });
  assert.deepEqual(await adapterFor('claude').collectSessionSnapshots(source, { archiveReader: archived }), []);
});

test('Claude archive truth retains an active native session and canonical identity', async (t) => {
  const home = fixture(t); claudeFixture(home);
  const source = { type: 'claude', path: home, sourceId: 'claude-source' };
  const active = () => ({ ok: true, authoritative: true, status: 'ok', archivedIds: [] });
  const [session] = await adapterFor('claude').collectSessionSnapshots(source, { archiveReader: active });
  assert.equal(session.canonicalId, 'claude:claude-source:claude-id');
});

test('Claude archive registry unavailable leaves JSONL discovery authoritative', async (t) => {
  const home = fixture(t); claudeFixture(home);
  const source = { type: 'claude', path: home, sourceId: 'claude-source' };
  const unavailable = () => ({ ok: true, authoritative: false, status: 'unavailable', archivedIds: [], reason: 'archive_registry_missing' });
  const [session] = await adapterFor('claude').collectSessionSnapshots(source, { archiveReader: unavailable });
  assert.equal(session.nativeSessionId, 'claude-id');
});

test('Claude archive registry read failure is not interpreted as an empty archive set', async (t) => {
  const home = fixture(t); claudeFixture(home);
  const source = { type: 'claude', path: home, sourceId: 'claude-source' };
  const failure = () => ({ ok: false, authoritative: false, status: 'read-error', archivedIds: [], reason: 'claude_archive_registry_read_failed' });
  const result = await adapterFor('claude').readSessionSnapshots(source, { archiveReader: failure });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'source_read_failed');
});

test('Claude archive and unarchive change revision without changing native identity', (t) => {
  const home = fixture(t); claudeFixture(home);
  const source = { type: 'claude', path: home, sourceId: 'claude-source', enabled: true };
  let archivedIds = [];
  const archiveReader = () => ({ ok: true, authoritative: true, status: 'ok', archivedIds });
  const adapter = adapterFor('claude');
  const activeRevision = adapter.getSessionRevision(source, { archiveReader });
  archivedIds = ['claude-id'];
  const archivedRevision = adapter.getSessionRevision(source, { archiveReader });
  archivedIds = [];
  const unarchivedRevision = adapter.getSessionRevision(source, { archiveReader });
  assert.notEqual(activeRevision, archivedRevision);
  assert.equal(unarchivedRevision, activeRevision);
});

test('Claude archive reader reads only the VS Code extension state object', async (t) => {
  const home = fixture(t); const dbPath = path.join(home, 'state.vscdb');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  await db.run('INSERT INTO ItemTable(key,value) VALUES (?,?)', 'Anthropic.claude-code', JSON.stringify({ hiddenSessionIds: ['archived-id'] }));
  await db.close();
  const state = readClaudeArchiveState({ dbPath });
  assert.deepEqual(state, { ok: true, authoritative: true, status: 'ok', archivedIds: ['archived-id'] });
});

test('Claude archive reader distinguishes a real registry read error', (t) => {
  const home = fixture(t); const dbPath = path.join(home, 'state.vscdb'); fs.writeFileSync(dbPath, 'not sqlite');
  const state = readClaudeArchiveState({ dbPath, readState: () => { throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }); } });
  assert.equal(state.ok, false); assert.equal(state.status, 'read-error'); assert.equal(state.reason, 'SQLITE_BUSY');
});

test('Pi uses session.id and latest model_change while ignoring trailing partial data', async (t) => {
  const home = fixture(t); const dir = path.join(home, 'agent', 'sessions', 'D--repo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pi.jsonl'), jsonl([
    { type: 'session', id: 'pi-id', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z' },
    { type: 'model_change', provider: 'openai', model: 'gpt-x', timestamp: '2026-09-01T00:01:00Z' },
    { type: 'message', timestamp: '2026-09-01T00:02:00Z' },
  ], '{"type":"message"'));
  const [session] = await adapterFor('pi').collectSessionSnapshots({ type: 'pi', path: home, sourceId: 'pi-source' });
  assert.equal(session.nativeSessionId, 'pi-id'); assert.equal(session.cwd, 'D:/repo'); assert.equal(session.createdAt, '2026-09-01T00:00:00.000Z'); assert.equal(session.updatedAt, '2026-09-01T00:02:00.000Z');
  assert.equal(session.provider, 'openai'); assert.equal(session.model, 'gpt-x'); assert.equal(session.executionStatus, 'unknown'); assert.equal(session.attentionStatus, 'none'); assert.equal(session.canonicalId, 'pi:pi-source:pi-id');
  assert.equal(session.titleSource, 'fallback-id');
});

test('external titles prefer native metadata then the first real user text', async (t) => {
  const home = fixture(t); const claude = path.join(home, 'projects', 'x'); const pi = path.join(home, 'agent', 'sessions', 'x'); fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(pi, { recursive: true });
  fs.writeFileSync(path.join(claude, 'c.jsonl'), jsonl([{ type: 'user', sessionId: 'c', cwd: 'D:/repo', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: '# fallback ignored' }] } }, { type: 'ai-title', sessionId: 'c', aiTitle: 'Native Claude title' }]));
  fs.writeFileSync(path.join(pi, 'p.jsonl'), jsonl([{ type: 'session', id: 'p', cwd: 'D:/repo', timestamp: '2026-01-01T00:00:00Z' }, { type: 'message', timestamp: '2026-01-01T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: '\\# Pi prompt title\nmore detail' }] } }]));
  const [c] = await adapterFor('claude').collectSessionSnapshots({ type: 'claude', path: home, sourceId: 'c' }); const [p] = await adapterFor('pi').collectSessionSnapshots({ type: 'pi', path: home, sourceId: 'p' });
  assert.deepEqual([c.displayTitle, c.titleSource], ['Native Claude title', 'native']); assert.deepEqual([p.displayTitle, p.titleSource], ['Pi prompt title more detail', 'first-user-message']);
});

test('each adapter owns a revision that changes with its native session source', async (t) => {
  const home = fixture(t); const source = { type: 'claude', path: home, sourceId: 'claude-revision', enabled: true };
  fs.mkdirSync(path.join(home, 'projects', 'x'), { recursive: true });
  const adapter = adapterFor('claude'); const before = adapter.getSessionRevision(source);
  fs.writeFileSync(path.join(home, 'projects', 'x', 'session.jsonl'), jsonl([{ type: 'user', sessionId: 'c', cwd: 'D:/repo', timestamp: '2026-01-01T00:00:00Z' }]));
  assert.notEqual(adapter.getSessionRevision(source), before);
});

test('Codex reconciles the separately indexed native thread name without changing session identity', async (t) => {
  const home = fixture(t); const dir = path.join(home, 'sessions', '2026', '01', '01'); fs.mkdirSync(dir, { recursive: true }); const id = '11111111-1111-1111-1111-111111111111';
  fs.writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`), jsonl([{ type: 'session_meta', payload: { session_id: id, thread_source: 'user', cwd: 'D:/repo' } }, { type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '\\# fallback prompt' }] } }]));
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Native Codex title', updated_at: '2026-01-01T00:01:00Z' })}\n`);
  let [session] = await discoverCodexSessions(home, { sourceId: 'codex-test' }); assert.equal(session.displayTitle, 'Native Codex title'); assert.equal(session.titleSource, 'native'); const canonical = session.canonicalId;
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Renamed by Codex', updated_at: '2026-01-01T00:02:00Z' })}\n`);
  [session] = await discoverCodexSessions(home, { sourceId: 'codex-test' }); assert.equal(session.displayTitle, 'Renamed by Codex'); assert.equal(session.canonicalId, canonical); assert.equal(session.updatedAt, '2026-01-01T00:00:00.000Z');
});

// ---- Transcript-derived execution status -----------------------------------------------------

const claudeTurn = (stopReason, { content = [{ type: 'text', text: 'done' }], isApiErrorMessage = false } = {}) => ({
  type: 'assistant', sessionId: 'c', timestamp: '2026-09-01T01:00:00Z', isApiErrorMessage: isApiErrorMessage || undefined,
  message: { role: 'assistant', model: 'claude-sonnet', stop_reason: stopReason, content },
});
async function claudeStatus(records) {
  const home = fixture({ after: () => {} });
  // tests need t for cleanup; emulate via mkdtemp + register finally on process
  const dir = path.join(home, 'projects', 'D--repo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c.jsonl'), jsonl(records));
  try {
    const [session] = await adapterFor('claude').collectSessionSnapshots({ type: 'claude', path: home, sourceId: 'src' });
    return session.executionStatus;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('Claude executionStatus maps the last turn stop_reason to working/idle/error', async () => {
  const base = (turn) => [
    { type: 'user', sessionId: 'c', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: 'go' } },
    turn,
  ];
  assert.equal(await claudeStatus(base(claudeTurn('tool_use', { content: [{ type: 'tool_use', name: 'Bash' }] }))), 'working');
  assert.equal(await claudeStatus(base(claudeTurn('end_turn'))), 'idle');
  assert.equal(await claudeStatus(base(claudeTurn('stop_sequence'))), 'idle', 'a stop_sequence answer is still a finished turn');
  assert.equal(await claudeStatus(base(claudeTurn('end_turn', { isApiErrorMessage: true }))), 'error', 'native API error outranks the stop reason');
});

test('Claude executionStatus always reflects the LAST assistant turn, not an earlier tool call', async () => {
  const records = [
    { type: 'user', sessionId: 'c', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: 'go' } },
    claudeTurn('tool_use', { content: [{ type: 'tool_use', name: 'Read' }] }),
    { type: 'user', sessionId: 'c', cwd: 'D:/repo', timestamp: '2026-09-01T00:05:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'file text' }] } },
    claudeTurn('end_turn', { content: [{ type: 'text', text: 'all done' }] }),
  ];
  assert.equal(await claudeStatus(records), 'idle');
});

const piTurn = (stopReason, { types = ['text'] } = {}) => ({
  type: 'message', timestamp: '2026-09-01T01:00:00Z',
  message: { role: 'assistant', stopReason: stopReason, content: types.map((t) => (t === 'toolCall' ? { type: 'toolCall', toolName: 'Bash' } : { type: 'text', text: 'ok' })) },
});
async function piStatus(records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-pi-status-'));
  const dir = path.join(home, 'agent', 'sessions', 'D--repo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p.jsonl'), jsonl(records));
  try {
    const [session] = await adapterFor('pi').collectSessionSnapshots({ type: 'pi', path: home, sourceId: 'src' });
    return session.executionStatus;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('Pi executionStatus maps the last assistant message stopReason to working/idle/error', async () => {
  const base = (turn) => [{ type: 'session', id: 'p', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z' }, turn];
  assert.equal(await piStatus(base(piTurn('toolUse', { types: ['toolCall'] }))), 'working');
  assert.equal(await piStatus(base(piTurn('stop'))), 'idle');
  assert.equal(await piStatus(base(piTurn('aborted'))), 'idle', 'a user interrupt is stopped work, not an Agent error');
  assert.equal(await piStatus(base(piTurn('error'))), 'error');
});

test('Pi executionStatus does not treat a failed tool RESULT as an Agent error', async () => {
  const records = [
    { type: 'session', id: 'p', cwd: 'D:/repo', timestamp: '2026-09-01T00:00:00Z' },
    piTurn('toolUse', { types: ['toolCall'] }),
    { type: 'message', timestamp: '2026-09-01T00:05:00Z', message: { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'fatal: not a git repository' }] } },
    piTurn('stop', { types: ['text'] }),
  ];
  assert.equal(await piStatus(records), 'idle');
});

