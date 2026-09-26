import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMarginCore } from '../src/core/createMarginCore.js';
import { createHandoffHttpAdapter } from '../src/core/handoff/httpAdapter.js';
import { runRunBridgeCli } from '../src/cli/runBridgeCli.js';

// The Session ↔ Run bridge (ADR 003). These tests are the acceptance criterion recorded in that ADR:
// a session can be bound to a Run, the binding survives a real restart, and the Board reports it.
//
// `sessionCanonicalId` is the Board's `canonicalId` (`agent:source:native`), which is the only id that
// identifies a session across two sources that may share a native id.

const runtimeControl = {
  async activate(run) { return { runtimeSessionId: `runtime-${run.id}` }; },
  async halt() {}
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-run-bridge-'));
  let number = 0;
  const core = await createMarginCore({
    enabled: true,
    dbPath: path.join(directory, 'core.sqlite'),
    clock: () => '2026-09-26T00:00:00.000Z',
    idFactory: (kind = 'id') => `${kind}-${++number}`
  });
  let closed = false;
  // Closing is made idempotent here because one test deliberately closes the Core mid-way to prove the
  // binding is read back from storage rather than memory, and the shared cleanup must not close twice.
  const closeCore = async () => { if (closed) return; closed = true; await core.close(); };
  const gateway = core.createApplicationContract({ runtimeControl });
  const context = (requestId, capabilities) => ({
    actor: { type: 'user', subjectId: 'owner-1' },
    surface: { kind: 'cli', instanceId: 'terminal-1' },
    requestId, correlationId: 'correlation-1', capabilities
  });
  const call = async (method, request, capabilities) => gateway[method](request, core.bindHostContext(context(request.requestId, capabilities)));
  const command = (type, requestId, payload, expectedVersion) => call('execute', { type, requestId, idempotencyKey: requestId, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) }, ['run:control', 'workstream:write']);
  const query = (type, requestId, payload) => call('query', { type, requestId, payload }, ['run:read']);

  const created = await command('workstream.create', 'ws-1', { title: 'Bridge', goal: 'Join the contexts', scenario: 'career_project', currentPlan: [] });
  const run = (await command('run.create', 'run-1', { workstreamId: created.data.id, workerKind: 'codex', scope: 'bind a session' })).data;
  return {
    core, gateway, directory, workstreamId: created.data.id, runId: run.id,
    command, query, closeCore,
    async cleanup() { await closeCore(); await rm(directory, { recursive: true, force: true }); }
  };
}

const SESSION = 'codex:codex-source:01a077ec-bd2c-78a1-8581-c7440c9bda66';

test('a session binds to a Run and resolves back from it', async () => {
  const f = await fixture();
  try {
    const bound = await f.command('run.bind_session', 'bind-1', { runId: f.runId, sessionCanonicalId: SESSION }, 1);
    assert.equal(bound.ok, true);
    // The bridge is reported through the Run DTO the caller already reads, not a parallel shape.
    assert.deepEqual(bound.data.runtimeReference, { kind: 'codex', id: null, canonicalSessionId: SESSION });
    assert.equal(bound.data.version, 2);

    const resolved = await f.query('session.resolve_runs', 'resolve-1', { canonicalSessionIds: [SESSION] });
    assert.deepEqual(resolved.data.items, [{
      canonicalSessionId: SESSION, runId: f.runId, workstreamId: f.workstreamId, status: 'queued', version: 2, updatedAt: '2026-09-26T00:00:00.000Z'
    }]);

    // An unknown session is simply absent — never a fabricated binding.
    const missing = await f.query('session.resolve_runs', 'resolve-2', { canonicalSessionIds: ['codex:nope:unknown'] });
    assert.deepEqual(missing.data.items, []);
  } finally { await f.cleanup(); }
});

test('the binding survives a real close and reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-run-bridge-restart-'));
  const dbPath = path.join(directory, 'core.sqlite');
  const open = async () => {
    let number = 0;
    const core = await createMarginCore({ enabled: true, dbPath, clock: () => '2026-09-26T00:00:00.000Z', idFactory: (kind = 'id') => `${kind}-${++number}` });
    const gateway = core.createApplicationContract({ runtimeControl });
    const trusted = (requestId, capabilities) => core.bindHostContext({
      actor: { type: 'user', subjectId: 'owner-1' }, surface: { kind: 'cli', instanceId: 'terminal-1' },
      requestId, correlationId: 'correlation-1', capabilities
    });
    return { core, gateway, trusted };
  };
  try {
    const first = await open();
    const created = await first.gateway.execute({ type: 'workstream.create', requestId: 'ws', idempotencyKey: 'ws', payload: { title: 'Restart', goal: 'persist', scenario: 'career_project', currentPlan: [] } }, first.trusted('ws', ['workstream:write']));
    const run = (await first.gateway.execute({ type: 'run.create', requestId: 'run', idempotencyKey: 'run', payload: { workstreamId: created.data.id, workerKind: 'codex', scope: 'persist' } }, first.trusted('run', ['run:control']))).data;
    await first.gateway.execute({ type: 'run.bind_session', requestId: 'bind', idempotencyKey: 'bind', expectedVersion: run.version, payload: { runId: run.id, sessionCanonicalId: SESSION } }, first.trusted('bind', ['run:control']));
    await first.core.close();

    // Same file, new process-equivalent: the binding must come back from storage, not from memory.
    const second = await open();
    const resolved = await second.gateway.query({ type: 'session.resolve_runs', requestId: 'resolve', payload: { canonicalSessionIds: [SESSION] } }, second.trusted('resolve', ['run:read']));
    assert.equal(resolved.data.items.length, 1);
    assert.equal(resolved.data.items[0].runId, run.id);
    assert.equal(resolved.data.items[0].canonicalSessionId, SESSION);
    const reopenedRun = await second.gateway.query({ type: 'run.get', requestId: 'get', payload: { runId: run.id } }, second.trusted('get', ['run:read']));
    assert.equal(reopenedRun.data.runtimeReference.canonicalSessionId, SESSION);
    await second.core.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one session belongs to at most one Run, and unbinding releases it', async () => {
  const f = await fixture();
  try {
    // A second Run has to live in a second Workstream: one Workstream may only hold one open Run.
    const otherWorkstream = (await f.command('workstream.create', 'ws-2', { title: 'Other', goal: 'Hold the other run', scenario: 'career_project', currentPlan: [] })).data;
    const other = (await f.command('run.create', 'run-2', { workstreamId: otherWorkstream.id, workerKind: 'codex', scope: 'other' })).data;
    await f.command('run.bind_session', 'bind-a', { runId: f.runId, sessionCanonicalId: SESSION }, 1);

    // The invariant is enforced in the schema (partial unique index) and reported as an actionable
    // error naming the owner, so "which Run is this session?" never has two answers.
    const conflict = await f.command('run.bind_session', 'bind-b', { runId: other.id, sessionCanonicalId: SESSION }, other.version);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'session_already_bound');
    // The envelope carries no message text by design, so the owner is reported structurally.
    assert.equal(conflict.error.details.runId, f.runId);
    assert.equal(conflict.error.details.workstreamId, f.workstreamId);

    // Rebinding the same Run to the same session is a no-op in effect, but still a versioned write.
    const again = await f.command('run.bind_session', 'bind-again', { runId: f.runId, sessionCanonicalId: SESSION }, 2);
    assert.equal(again.ok, true);
    assert.equal(again.data.version, 3);

    const unbound = await f.command('run.bind_session', 'unbind', { runId: f.runId, sessionCanonicalId: null }, 3);
    assert.equal(unbound.ok, true);
    // Back to exactly the pre-bridge shape: this Run never started, so it has no runtime session, and
    // an unbound Run with no runtime session has no runtime reference at all — not an empty one.
    assert.equal(unbound.data.runtimeReference, null);
    assert.equal((await f.query('session.resolve_runs', 'resolve-after', { canonicalSessionIds: [SESSION] })).data.items.length, 0);

    // ...and the freed session can now be claimed by the other Run.
    const reclaimed = await f.command('run.bind_session', 'bind-c', { runId: other.id, sessionCanonicalId: SESSION }, other.version);
    assert.equal(reclaimed.ok, true);
  } finally { await f.cleanup(); }
});

test('binding is idempotent under the same request id and rejects a stale version', async () => {
  const f = await fixture();
  try {
    const first = await f.command('run.bind_session', 'same-request', { runId: f.runId, sessionCanonicalId: SESSION }, 1);
    assert.equal(first.data.version, 2);
    const replay = await f.command('run.bind_session', 'same-request', { runId: f.runId, sessionCanonicalId: SESSION }, 1);
    assert.equal(replay.ok, true);
    assert.equal(replay.data.version, 2, 'a replay must not advance the version again');
    assert.equal(replay.meta.auditId, first.meta.auditId);

    const stale = await f.command('run.bind_session', 'stale', { runId: f.runId, sessionCanonicalId: 'codex:x:y' }, 1);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'version_conflict');
  } finally { await f.cleanup(); }
});

test('the resolve query is closed, bounded, and batch-only', async () => {
  const f = await fixture();
  try {
    const empty = await f.query('session.resolve_runs', 'q-empty', { canonicalSessionIds: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, 'invalid_request');
    const oversized = await f.query('session.resolve_runs', 'q-big', { canonicalSessionIds: Array.from({ length: 101 }, (_, index) => `s-${index}`) });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, 'invalid_request');
    const extra = await f.query('session.resolve_runs', 'q-extra', { canonicalSessionIds: [SESSION], limit: 5 });
    assert.equal(extra.ok, false, 'an unlisted payload key must be rejected, not ignored');
  } finally { await f.cleanup(); }
});

const withServer = async (app, run) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const boardApp = (env, extra) => createHandoffHttpAdapter({
  rootDir: os.tmpdir(),
  env,
  readRegistry: () => ({ version: 1, sources: [] }),
  writeRegistry: (registry) => registry,
  getAgentResourceStatus: () => ({ agents: [] }),
  ...extra
});

test('the Board reports the bound Run, and degrades to null when it cannot', async (t) => {
  const env = { USERPROFILE: await mkdtemp(path.join(os.tmpdir(), 'margin-board-bridge-')), HOME: '' };
  env.HOME = env.USERPROFILE;
  t.after(() => rm(env.USERPROFILE, { recursive: true, force: true }));
  const session = { id: 'native-1', nativeSessionId: 'native-1', canonicalId: SESSION, sourceId: 'codex-source', agentType: 'codex', cwd: os.tmpdir(), createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' };
  const sources = [{ id: 'codex-source', sourceId: 'codex-source', type: 'codex', agentType: 'codex', path: os.tmpdir(), enabled: true }];
  const withAdapter = (resolveRuns) => createHandoffHttpAdapter({
    rootDir: os.tmpdir(), env,
    readRegistry: () => ({ version: 1, sources }),
    writeRegistry: (registry) => registry,
    getAgentResourceStatus: () => ({ agents: [] }),
    adapterResolver: () => ({ agentType: 'codex', getSessionRevision: () => 'r', readSessionSnapshots: async () => ({ ok: true, snapshots: [session] }), collectResourceSnapshot: async () => ({ agents: [] }) }),
    resolveRuns
  });
  const sessionsOf = async (app) => {
    const body = await withServer(app, async (origin) => (await fetch(`${origin}/api/sessions`)).json());
    assert.equal(body.ok, true);
    return body.data.sessions;
  };

  // Bound: the Board labels the session with its Run without reading the Core itself.
  const bound = await sessionsOf(withAdapter(async (ids) => {
    assert.deepEqual(ids, [SESSION], 'the resolver receives canonical ids, not native ones');
    return [{ canonicalSessionId: SESSION, runId: 'run-1', workstreamId: 'ws-1' }];
  }));
  assert.equal(bound[0].runId, 'run-1');
  assert.equal(bound[0].workstreamId, 'ws-1');

  // No resolver configured is the normal case for a host that owns no Core: the field exists and is
  // null, so the shape never changes and a caller cannot mistake absence for "not loaded yet".
  const unconfigured = await sessionsOf(withAdapter(null));
  assert.equal(unconfigured[0].runId, null);
  assert.equal(unconfigured[0].workstreamId, null);

  // A bridge read failure must not take the Board down.
  const failing = await sessionsOf(withAdapter(async () => { throw new Error('core unavailable'); }));
  assert.equal(failing.length, 1);
  assert.equal(failing[0].runId, null);
});

test('the CLI binds and resolves against a real database', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  await f.closeCore();
  const sink = () => { const parts = []; return { write: (value) => parts.push(String(value)), text: () => parts.join('') }; };
  const dbPath = path.join(f.directory, 'core.sqlite');

  const bindOut = sink(); const err = sink();
  assert.equal(await runRunBridgeCli(['bind', f.runId, SESSION], { dbPath, stdout: bindOut, stderr: err }), 0, err.text());
  assert.match(bindOut.text(), /^Bound codex:codex-source:.* -> run-\d+ \(workstream workstream-\d+, version 2\)/);

  const resolveOut = sink();
  assert.equal(await runRunBridgeCli(['resolve', SESSION], { dbPath, stdout: resolveOut, stderr: err }), 0, err.text());
  const resolvedLine = resolveOut.text().trim();
  assert.ok(resolvedLine.startsWith(`${SESSION}\trun-`), resolvedLine);
  assert.ok(resolvedLine.endsWith('\tqueued'), resolvedLine);

  const unboundOut = sink();
  assert.equal(await runRunBridgeCli(['resolve', 'codex:nope:missing'], { dbPath, stdout: unboundOut, stderr: err }), 0, err.text());
  assert.ok(unboundOut.text().trim().endsWith('\tunbound'), unboundOut.text());

  const unbindOut = sink();
  assert.equal(await runRunBridgeCli(['unbind', f.runId], { dbPath, stdout: unbindOut, stderr: err }), 0, err.text());
  assert.equal(unbindOut.text().trim().startsWith('Unbound run-'), true, unbindOut.text());

  assert.equal(await runRunBridgeCli(['nonsense'], { dbPath, stdout: sink(), stderr: err }), 1);
  assert.match(err.text(), /Usage: margin run/);
});
