import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMarginCore } from '../src/core/createMarginCore.js';

// End-to-end trace: one operation must be visible from the outside as a correlated, complete activity
// entry.
//
// This test exists because two coupled lookups used to drop information without raising anything:
//   * the event-to-audit join listed every command by name in a CASE, so a command missing from it kept
//     its event but lost its actor;
//   * the event-type map listed every entity/event/command triple, so an unlisted command produced no
//     envelope at all and vanished from the activity stream.
// Both were "add a contract type, forget a second list" failures. Asserting the actor AND the presence of
// the entry is what makes them loud; asserting only the count of events would miss the second one.
const runtimeControl = { async activate(run) { return { runtimeSessionId: `runtime-${run.id}` }; }, async halt() {} };
const SESSION = 'codex:codex-source:01a077ec-bd2c-78a1-8581-c7440c9bda66';

test('a bridge write is traceable as a complete activity entry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-trace-'));
  let number = 0;
  const core = await createMarginCore({
    enabled: true,
    dbPath: path.join(directory, 'core.sqlite'),
    clock: () => '2026-09-26T00:00:00.000Z',
    idFactory: (kind = 'id') => `${kind}-${++number}`
  });
  try {
    const gateway = core.createApplicationContract({ runtimeControl });
    const trusted = (requestId, capabilities) => core.bindHostContext({
      actor: { type: 'user', subjectId: 'owner-1' }, surface: { kind: 'cli', instanceId: 'terminal-1' },
      requestId, correlationId: 'correlation-1', capabilities
    });
    const execute = (type, requestId, payload, expectedVersion) => gateway.execute(
      { type, requestId, idempotencyKey: requestId, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) },
      trusted(requestId, ['workstream:write', 'run:control'])
    );
    const query = (type, requestId, payload) => gateway.query({ type, requestId, payload }, trusted(requestId, ['activity:read', 'run:read']));

    const workstream = (await execute('workstream.create', 'ws-1', { title: 'Trace', goal: 'Be observable', scenario: 'career_project', currentPlan: [] })).data;
    const run = (await execute('run.create', 'run-1', { workstreamId: workstream.id, workerKind: 'codex', scope: 'trace' })).data;
    await execute('run.bind_session', 'bind-1', { runId: run.id, sessionCanonicalId: SESSION }, run.version);

    const activity = (await query('activity.list', 'act-1', { workstreamId: workstream.id })).data;
    // A skipped event is the silent failure this test is about: the diagnostics counter is the only place
    // it would otherwise show up, and nothing reads a counter.
    assert.equal(activity.diagnostics.skippedUnknownEvents, 0, 'no event may be dropped from the activity stream');

    const binding = activity.items.find((item) => item.type === 'run.session_bound');
    assert.ok(binding, `the bridge write is missing from activity: ${JSON.stringify(activity.items.map((item) => item.type))}`);
    assert.equal(binding.title, 'Agent session bound');
    assert.equal(binding.runId, run.id, 'the activity entry is attributed to the Run it changed');
    assert.equal(binding.workstreamId, workstream.id);
    assert.equal(binding.occurredAt, '2026-09-26T00:00:00.000Z');

    // The envelope is built from a join back to the audit log, so an actor is proof the join matched. A
    // broken command list would leave it null while the event itself still looked fine.
    const envelope = (await query('run.get', 'get-1', { runId: run.id })).meta;
    assert.equal(envelope.requestId, 'get-1');
    const events = await gateway.events({ type: 'event.list', requestId: 'events-1', payload: { workstreamId: workstream.id } }, trusted('events-1', ['event:read']));
    const traced = events.data.items.find((item) => item.eventType === 'run.session_bound');
    assert.ok(traced, 'the same fact is available on the event stream, not only in its activity projection');
    assert.deepEqual(traced.actor, { type: 'user', subjectId: 'owner-1' });
    assert.equal(traced.source.correlationId, 'correlation-1', 'the operation carries its correlation through to the stream');

    // Cursors are the ordering contract: monotonic, and usable as an incremental read position.
    const cursors = activity.items.map((item) => item.cursor);
    assert.deepEqual(cursors, [...cursors].sort((left, right) => left - right));
    assert.equal(new Set(cursors).size, cursors.length);
    const afterBinding = (await query('activity.list', 'act-2', { workstreamId: workstream.id, afterCursor: binding.cursor })).data;
    assert.equal(afterBinding.items.some((item) => item.cursor === binding.cursor), false);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
