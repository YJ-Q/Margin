import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMarginCore } from '../src/core/createMarginCore.js';
import { CONTRACT_VERSION } from '../src/contracts/contractTypes.js';

const runtimeControl = {
  calls: [],
  async activate(run) { this.calls.push(`activate:${run.id}`); return { runtimeSessionId: `runtime-${run.id}` }; },
  async halt(run) { this.calls.push(`halt:${run.id}`); }
};

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-contract-commands-'));
  let number = 0;
  const core = await createMarginCore({
    enabled: true,
    dbPath: path.join(directory, 'core.sqlite'),
    clock: () => '2026-08-24T00:00:00.000Z',
    idFactory: (kind = 'id') => `${kind}-${++number}`,
    ...options
  });
  runtimeControl.calls = [];
  const gateway = core.createApplicationContract({ runtimeControl });
  return { core, gateway, directory, async cleanup() { await core.close(); await rm(directory, { recursive: true, force: true }); } };
}

function context(requestId, capabilities, overrides = {}) {
  return {
    actor: { type: 'user', subjectId: 'owner-1' },
    surface: { kind: 'cli', instanceId: 'terminal-1' },
    requestId,
    correlationId: 'correlation-1',
    capabilities,
    ...overrides
  };
}

function command(type, requestId, idempotencyKey, payload, expectedVersion) {
  return { type, requestId, idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload };
}

async function executeHost(f, value, capabilities) {
  const trusted = f.core.bindHostContext(context(value.requestId, capabilities));
  return f.gateway.execute(value, trusted);
}

test('all command routes return frozen stable envelopes and NeedsOwner resolve creates no Decision', async () => {
  const f = await fixture();
  try {
    let response = await f.gateway.execute(
      command('workstream.create', 'call-w', 'business-w', {
        title: 'Phase 2A', goal: 'Ship the gateway', scenario: 'career_project', currentPlan: ['test first'],
        workspaceReference: { kind: 'local_path', path: 'D:/Echo' }
      }),
      context('call-w', ['workstream:write'])
    );
    assert.equal(response.ok, true);
    assert.equal(response.meta.requestId, 'call-w');
    assert.equal(response.meta.correlationId, 'correlation-1');
    assert.equal(response.meta.contractVersion, CONTRACT_VERSION);
    assert.equal(Object.isFrozen(response), true);
    const workstream = response.data;

    response = await f.gateway.execute(
      command('workstream.update', 'call-update', 'business-update', { workstreamId: workstream.id, changes: { currentState: 'green' } }, workstream.version),
      context('call-update', ['workstream:write'])
    );
    assert.equal(response.data.version, 2);
    let updated = response.data;

    response = await executeHost(f,
      command('run.create', 'call-run', 'business-run', { workstreamId: workstream.id, workerKind: 'pi', scope: 'Implement Task 3' }),
      ['run:control']
    );
    let run = response.data;
    assert.equal(run.workerKind, 'pi');

    response = await f.gateway.execute(
      command('workstream.update', 'call-update-active', 'business-update-active', { workstreamId: workstream.id, changes: { currentState: 'run queued' } }, updated.version),
      context('call-update-active', ['workstream:write'])
    );
    assert.equal(response.data.activeRun.id, run.id);
    updated = response.data;

    response = await executeHost(f, command('run.start', 'call-start', 'business-start', { runId: run.id }, run.version), ['run:control']);
    run = response.data;
    assert.equal(run.status, 'running');
    const invalidStart = await executeHost(f,
      command('run.start', 'call-start-again', 'business-start-again', { runId: run.id }, run.version),
      ['run:control']
    );
    assert.equal(invalidStart.error.code, 'invalid_transition');
    assert.equal(invalidStart.error.retryable, false);

    response = await f.gateway.execute(
      command('artifact.create', 'call-artifact', 'business-artifact', {
        workstreamId: workstream.id, runId: run.id, type: 'report', title: 'Task 3 report',
        resourceReference: { uri: 'margin://artifact/task-3', contentHash: 'hash-1' }, metadata: { format: 'markdown' }
      }),
      context('call-artifact', ['artifact:write'])
    );
    assert.equal(response.data.resourceReference.contentHash, 'hash-1');

    response = await f.gateway.execute(
      command('checkpoint.create', 'call-checkpoint', 'business-checkpoint', {
        workstreamId: workstream.id, runId: run.id, runVersion: run.version,
        stateVersion: updated.version, stateDigest: 'digest-1', note: 'safe point'
      }),
      context('call-checkpoint', ['checkpoint:write'])
    );
    assert.equal(response.data.runVersion, run.version);

    response = await f.gateway.execute(
      command('needs_owner.create', 'call-need', 'business-need', {
        workstreamId: workstream.id, runId: run.id, type: 'approval', reason: 'Choose release path',
        options: [{ id: 'approve', label: 'Approve' }]
      }),
      context('call-need', ['needs_owner:write'])
    );
    const needsOwner = response.data;
    response = await f.gateway.execute(
      command('needs_owner.resolve', 'call-resolve', 'business-resolve', {
        needsOwnerId: needsOwner.id, optionId: 'approve', resolutionSummary: 'Approved'
      }, needsOwner.version),
      context('call-resolve', ['needs_owner:resolve'])
    );
    assert.equal(response.data.status, 'resolved');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_decisions')).count, 0);

    response = await executeHost(f, command('run.pause', 'call-pause', 'business-pause', { runId: run.id }, run.version), ['run:control']);
    run = response.data;
    assert.ok(run.checkpoint);
    response = await executeHost(f, command('run.resume', 'call-resume', 'business-resume', { runId: run.id }, run.version), ['run:control']);
    run = response.data;
    response = await executeHost(f, command('run.stop', 'call-stop', 'business-stop', { runId: run.id }, run.version), ['run:control']);
    assert.equal(response.data.status, 'cancelled');
  } finally { await f.cleanup(); }
});

test('same idempotencyKey replays run.create without a second Run or event when Gateway requestId changes', async () => {
  const f = await fixture();
  try {
    const created = await f.gateway.execute(
      command('workstream.create', 'w-call', 'w-key', { title: 'Replay', goal: 'One side effect', scenario: 'learning_research' }),
      context('w-call', ['workstream:write'])
    );
    const firstCommand = command('run.create', 'call-1', 'stable-run-key', { workstreamId: created.data.id, workerKind: 'pi', scope: 'One run' });
    const firstContext = f.core.bindHostContext(context('call-1', ['run:control']));
    const first = await f.gateway.execute(firstCommand, firstContext);
    const retryCommand = { ...firstCommand, requestId: 'call-2' };
    const retry = await f.gateway.execute(retryCommand, { ...firstContext, requestId: 'call-2' });
    assert.equal(retry.data.id, first.data.id);
    assert.equal(retry.meta.requestId, 'call-2');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_runs')).count, 1);
    const started = await f.gateway.execute(
      command('run.start', 'call-start', 'stable-start-key', { runId: first.data.id }, first.data.version),
      { ...firstContext, requestId: 'call-start' }
    );
    assert.equal(started.data.status, 'running');
    const paused = await f.gateway.execute(
      command('run.pause', 'call-pause', 'stable-pause-key', { runId: first.data.id }, started.data.version),
      { ...firstContext, requestId: 'call-pause' }
    );
    assert.ok(paused.data.checkpoint);
    const lateRetry = await f.gateway.execute(
      { ...firstCommand, requestId: 'call-3' },
      { ...firstContext, requestId: 'call-3' }
    );
    assert.deepEqual(lateRetry.data, first.data);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events WHERE entity_id=?', first.data.id)).count, 3);
    const audit = await f.core.store.db.get("SELECT request_id,metadata FROM margin_audit_log WHERE entity_id=? AND operation='run_create'", first.data.id);
    const event = await f.core.store.db.get('SELECT source_event_id FROM margin_events WHERE entity_id=?', first.data.id);
    assert.equal(audit.request_id, 'stable-run-key');
    const { replayData, replayRelated, ...auditMetadata } = JSON.parse(audit.metadata);
    assert.deepEqual(auditMetadata, {
      actorSubjectId: 'owner-1', correlationId: 'correlation-1', surfaceKind: 'cli', gatewayRequestId: 'call-1'
    });
    assert.equal(replayData.id, first.data.id);
    assert.equal(replayData.version, first.data.version);
    assert.deepEqual(replayRelated, { checkpoint: null });
    assert.equal(event.source_event_id, 'call-1');
  } finally { await f.cleanup(); }
});

test('stale workstream update and stale checkpoint tokens return version_conflict without state or event writes', async () => {
  const f = await fixture();
  try {
    const created = await f.gateway.execute(
      command('workstream.create', 'create', 'create-key', { title: 'Versions', goal: 'Reject stale writes', scenario: 'career_project' }),
      context('create', ['workstream:write'])
    );
    const current = await f.gateway.execute(
      command('workstream.update', 'advance', 'advance-key', { workstreamId: created.data.id, changes: { currentState: 'v2' } }, created.data.version),
      context('advance', ['workstream:write'])
    );
    const beforeEvents = (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count;
    const conflict = await f.gateway.execute(
      command('workstream.update', 'stale', 'stale-key', { workstreamId: created.data.id, changes: { goal: 'Must not persist' } }, created.data.version),
      context('stale', ['workstream:write'])
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'version_conflict');
    assert.equal((await f.core.repository.getWorkstream(created.data.id)).goal, created.data.goal);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count, beforeEvents);

    const staleCheckpoint = await f.gateway.execute(
      command('checkpoint.create', 'checkpoint-stale', 'checkpoint-stale-key', {
        workstreamId: created.data.id, stateVersion: 0, stateDigest: 'digest'
      }),
      context('checkpoint-stale', ['checkpoint:write'])
    );
    assert.equal(staleCheckpoint.error.code, 'version_conflict');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_checkpoints')).count, 0);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count, beforeEvents);
    assert.equal(current.data.version, 2);
  } finally { await f.cleanup(); }
});

test('Run control rejects missing capability, serializable authority forgeries, and scheduler-shaped callers', async () => {
  const f = await fixture();
  try {
    const created = await f.gateway.execute(
      command('workstream.create', 'w', 'w-key', { title: 'Authority', goal: 'Keep private', scenario: 'career_project' }),
      context('w', ['workstream:write'])
    );
    const runCommand = command('run.create', 'run', 'run-key', { workstreamId: created.data.id, workerKind: 'pi', scope: 'Private control' });
    const missing = await f.gateway.execute(runCommand, context('run', []));
    assert.equal(missing.error.code, 'capability_required');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_runs')).count, 0);

    for (const forged of [
      context('run', ['run:control'], { hostAuthority: true }),
      context('run', ['run:control']),
      JSON.parse(JSON.stringify(f.core.bindHostContext(context('run', ['run:control'])))),
      context('run', ['run:control'], { actor: { type: 'user', subjectId: 'owner-1', actorType: 'user' } })
    ]) {
      const result = await f.gateway.execute(runCommand, forged);
      assert.equal(result.error.code, forged.actor.actorType ? 'invalid_request' : 'permission_denied');
    }

    const trustedRun = await executeHost(f, { ...runCommand, requestId: 'trusted-run', idempotencyKey: 'trusted-run-key' }, ['run:control']);
    const scheduler = context('scheduler-start', ['run:control'], {
      actor: { type: 'system', subjectId: 'scheduler-1' }, surface: { kind: 'scheduler', instanceId: 'daily' }
    });
    const denied = await f.gateway.execute(
      command('run.start', 'scheduler-start', 'scheduler-key', { runId: trustedRun.data.id }, trustedRun.data.version),
      scheduler
    );
    assert.equal(denied.error.code, 'permission_denied');
    assert.equal((await f.core.repository.getRun(trustedRun.data.id)).status, 'queued');
    assert.deepEqual(runtimeControl.calls, []);
  } finally { await f.cleanup(); }
});

test('stale checkpoint runVersion is transactionally rejected without checkpoint or event writes', async () => {
  const f = await fixture();
  try {
    const workstream = (await f.gateway.execute(
      command('workstream.create', 'run-version-w', 'run-version-w-key', { title: 'Run token', goal: 'Verify both tokens', scenario: 'career_project' }),
      context('run-version-w', ['workstream:write'])
    )).data;
    let run = (await executeHost(f,
      command('run.create', 'run-version-r', 'run-version-r-key', { workstreamId: workstream.id, workerKind: 'pi', scope: 'Advance version' }),
      ['run:control']
    )).data;
    const staleVersion = run.version;
    run = (await executeHost(f,
      command('run.start', 'run-version-start', 'run-version-start-key', { runId: run.id }, run.version),
      ['run:control']
    )).data;
    const eventsBefore = (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count;
    const conflict = await f.gateway.execute(
      command('checkpoint.create', 'run-version-c', 'run-version-c-key', {
        workstreamId: workstream.id, runId: run.id, runVersion: staleVersion,
        stateVersion: workstream.version, stateDigest: 'digest'
      }),
      context('run-version-c', ['checkpoint:write'])
    );
    assert.equal(conflict.error.code, 'version_conflict');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_checkpoints')).count, 0);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count, eventsBefore);
  } finally { await f.cleanup(); }
});

test('unknown command type and unexpected storage errors use safe stable envelopes', async () => {
  const f = await fixture();
  try {
    const unknown = await f.gateway.execute(
      command('run.launch', 'unknown', 'unknown-key', { runId: 'run-1' }),
      context('unknown', ['run:control'])
    );
    assert.equal(unknown.error.code, 'invalid_request');
    assert.equal(unknown.error.retryable, false);

    const original = f.core.repository.createArtifact;
    f.core.repository.createArtifact = async () => { throw new Error('SQL secret at D:/private.sqlite'); };
    const failed = await f.gateway.execute(
      command('artifact.create', 'storage', 'storage-key', {
        workstreamId: 'w-1', type: 'report', title: 'Report',
        resourceReference: { uri: 'margin://report', contentHash: 'hash' }
      }),
      context('storage', ['artifact:write'])
    );
    f.core.repository.createArtifact = original;
    assert.deepEqual(failed.error, { code: 'storage_failure', retryable: true });
    assert.equal(JSON.stringify(failed).includes('private.sqlite'), false);
  } finally { await f.cleanup(); }
});

test('NeedsOwner service rejects malformed options before any state or evidence write', async () => {
  const f = await fixture();
  try {
    const workstream = (await f.core.workstreams.create({
      requestId: 'direct-workstream', title: 'NeedsOwner', goal: 'Validate service input', scenario: 'career_project'
    }, { actorType: 'user', subjectId: 'owner-1', sourceSessionId: 'host', sourceEventId: 'call' })).data;
    const before = (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count;
    await assert.rejects(
      f.core.needsOwner.create({
        requestId: 'bad-needs-owner', workstreamId: workstream.id, type: 'approval', reason: 'Choose',
        options: [{ id: '', label: 'Broken' }]
      }, { actorType: 'user', subjectId: 'owner-1', sourceSessionId: 'host', sourceEventId: 'call' }),
      (error) => error.code === 'invalid_request'
    );
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_needs_owner')).count, 0);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count, before);
  } finally { await f.cleanup(); }
});

test('one business idempotency key cannot be reused for a different command type', async () => {
  const f = await fixture();
  try {
    const workstream = await f.gateway.execute(
      command('workstream.create', 'create-call', 'shared-business-key', { title: 'Key scope', goal: 'Reject command drift', scenario: 'career_project' }),
      context('create-call', ['workstream:write'])
    );
    const conflict = await f.gateway.execute(
      command('needs_owner.create', 'needs-call', 'shared-business-key', {
        workstreamId: workstream.data.id, type: 'input', reason: 'Different command', options: []
      }),
      context('needs-call', ['needs_owner:write'])
    );
    assert.equal(conflict.error.code, 'idempotency_conflict');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_needs_owner')).count, 0);
  } finally { await f.cleanup(); }
});

test('concurrent run.start replay invokes runtime activate only once', async () => {
  const f = await fixture();
  let peer;
  try {
    const workstream = (await f.gateway.execute(
      command('workstream.create', 'concurrent-w', 'concurrent-w-key', { title: 'Concurrent start', goal: 'One activation', scenario: 'career_project' }),
      context('concurrent-w', ['workstream:write'])
    )).data;
    const run = (await executeHost(f,
      command('run.create', 'concurrent-r', 'concurrent-r-key', { workstreamId: workstream.id, workerKind: 'pi', scope: 'Start once' }),
      ['run:control']
    )).data;
    let activations = 0;
    const concurrentRuntime = {
      async activate(value) {
        activations += 1;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { runtimeSessionId: `runtime-${value.id}` };
      },
      async halt() {}
    };
    peer = await createMarginCore({ enabled: true, dbPath: path.join(f.directory, 'core.sqlite') });
    const firstGateway = f.core.createApplicationContract({ runtimeControl: concurrentRuntime });
    const peerGateway = peer.createApplicationContract({ runtimeControl: concurrentRuntime });
    const firstCommand = command('run.start', 'concurrent-call-1', 'concurrent-start-key', { runId: run.id }, run.version);
    const firstTrusted = f.core.bindHostContext(context('concurrent-call-1', ['run:control']));
    const peerTrusted = peer.bindHostContext(context('concurrent-call-2', ['run:control']));
    const [first, retry] = await Promise.all([
      firstGateway.execute(firstCommand, firstTrusted),
      peerGateway.execute({ ...firstCommand, requestId: 'concurrent-call-2' }, peerTrusted)
    ]);
    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.data, first.data);
    assert.equal(activations, 1);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events WHERE entity_id=?', run.id)).count, 2);
  } finally {
    if (peer) await peer.close();
    await f.cleanup();
  }
});

test('concurrent conflicting run.start input is rejected before a second runtime side effect', async () => {
  const f = await fixture();
  let peer;
  try {
    const workstream1 = (await f.gateway.execute(
      command('workstream.create', 'conflict-w1', 'conflict-w1-key', { title: 'First', goal: 'One activation', scenario: 'career_project' }),
      context('conflict-w1', ['workstream:write'])
    )).data;
    const workstream2 = (await f.gateway.execute(
      command('workstream.create', 'conflict-w2', 'conflict-w2-key', { title: 'Second', goal: 'No activation', scenario: 'career_project' }),
      context('conflict-w2', ['workstream:write'])
    )).data;
    const run1 = (await executeHost(f,
      command('run.create', 'conflict-r1', 'conflict-r1-key', { workstreamId: workstream1.id, workerKind: 'pi', scope: 'First run' }),
      ['run:control']
    )).data;
    const run2 = (await executeHost(f,
      command('run.create', 'conflict-r2', 'conflict-r2-key', { workstreamId: workstream2.id, workerKind: 'pi', scope: 'Second run' }),
      ['run:control']
    )).data;
    let activations = 0;
    const concurrentRuntime = {
      async activate(value) {
        activations += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { runtimeSessionId: `runtime-${value.id}` };
      },
      async halt() {}
    };
    peer = await createMarginCore({ enabled: true, dbPath: path.join(f.directory, 'core.sqlite') });
    const firstGateway = f.core.createApplicationContract({ runtimeControl: concurrentRuntime });
    const peerGateway = peer.createApplicationContract({ runtimeControl: concurrentRuntime });
    const firstTrusted = f.core.bindHostContext(context('conflict-call-1', ['run:control']));
    const peerTrusted = peer.bindHostContext(context('conflict-call-2', ['run:control']));
    const [left, right] = await Promise.all([
      firstGateway.execute(command('run.start', 'conflict-call-1', 'shared-conflict-key', { runId: run1.id }, run1.version), firstTrusted),
      peerGateway.execute(command('run.start', 'conflict-call-2', 'shared-conflict-key', { runId: run2.id }, run2.version), peerTrusted)
    ]);
    const results = [left, right];
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error?.code === 'idempotency_conflict').length, 1);
    assert.equal(activations, 1);
  } finally {
    if (peer) await peer.close();
    await f.cleanup();
  }
});

test('durable run replay succeeds without runtime control and matches the first transaction snapshot', async () => {
  const f = await fixture();
  try {
    const workstream = (await f.gateway.execute(
      command('workstream.create', 'replay-runtime-w', 'replay-runtime-w-key', { title: 'Replay runtime', goal: 'Replay first', scenario: 'career_project' }),
      context('replay-runtime-w', ['workstream:write'])
    )).data;
    const run = (await executeHost(f,
      command('run.create', 'replay-runtime-r', 'replay-runtime-r-key', { workstreamId: workstream.id, workerKind: 'pi', scope: 'Replay without runtime' }),
      ['run:control']
    )).data;
    const firstCommand = command('run.start', 'replay-runtime-call-1', 'replay-runtime-key', { runId: run.id }, run.version);
    const trusted = f.core.bindHostContext(context('replay-runtime-call-1', ['run:control']));
    const first = await f.gateway.execute(firstCommand, trusted);
    const gatewayWithoutRuntime = f.core.createApplicationContract();
    const retry = await gatewayWithoutRuntime.execute(
      { ...firstCommand, requestId: 'replay-runtime-call-2' },
      { ...trusted, requestId: 'replay-runtime-call-2' }
    );
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.data, first.data);
  } finally { await f.cleanup(); }
});

test('fresh run.create and its replay use the same transaction-captured related snapshot', async () => {
  const f = await fixture();
  try {
    const workstream = (await f.gateway.execute(
      command('workstream.create', 'snapshot-w-call', 'snapshot-w-key', { title: 'Snapshot', goal: 'Stable DTO', scenario: 'career_project' }),
      context('snapshot-w-call', ['workstream:write'])
    )).data;
    const originalCreateRun = f.core.repository.createRun;
    f.core.repository.createRun = async (input, actor) => {
      const result = await originalCreateRun(input, actor);
      await f.core.repository.createCheckpoint({
        requestId: 'snapshot-after-commit', workstreamId: workstream.id, runId: result.data.id,
        runVersion: result.data.version, stateVersion: workstream.version, stateDigest: 'after-commit'
      }, actor);
      return result;
    };
    const createRunCommand = command('run.create', 'snapshot-run-call-1', 'snapshot-run-key', {
      workstreamId: workstream.id, workerKind: 'pi', scope: 'Capture relation'
    });
    const trusted = f.core.bindHostContext(context('snapshot-run-call-1', ['run:control']));
    const first = await f.gateway.execute(createRunCommand, trusted);
    f.core.repository.createRun = originalCreateRun;
    const retry = await f.gateway.execute(
      { ...createRunCommand, requestId: 'snapshot-run-call-2' },
      { ...trusted, requestId: 'snapshot-run-call-2' }
    );
    assert.equal(first.ok, true);
    assert.equal(first.data.checkpoint, null);
    assert.deepEqual(retry.data, first.data);
  } finally { await f.cleanup(); }
});

test('checkpoint.create rejects runVersion without runId before state or evidence writes', async () => {
  const f = await fixture();
  try {
    const workstream = (await f.gateway.execute(
      command('workstream.create', 'orphan-token-w', 'orphan-token-w-key', { title: 'Tokens', goal: 'Pair tokens', scenario: 'career_project' }),
      context('orphan-token-w', ['workstream:write'])
    )).data;
    const eventsBefore = (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count;
    const rejected = await f.gateway.execute(
      command('checkpoint.create', 'orphan-token-call', 'orphan-token-key', {
        workstreamId: workstream.id, stateVersion: workstream.version, runVersion: 1, stateDigest: 'orphan'
      }),
      context('orphan-token-call', ['checkpoint:write'])
    );
    assert.equal(rejected.error.code, 'invalid_request');
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_checkpoints')).count, 0);
    assert.equal((await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count, eventsBefore);
  } finally { await f.cleanup(); }
});

test('pause and stop retries reuse the Runtime operation key after post-halt persistence failure', async (t) => {
  for (const operation of ['pause', 'stop']) {
    await t.test(operation, async () => {
      let failNextRunEvidence = false;
      const f = await fixture({
        beforeEvidenceWrite({ entityType }) {
          if (failNextRunEvidence && entityType === 'run') {
            failNextRunEvidence = false;
            throw new Error('post-halt evidence failure');
          }
        }
      });
      try {
        const workstream = (await f.gateway.execute(
          command('workstream.create', `${operation}-w-call`, `${operation}-w-key`, {
            title: `${operation} retry`, goal: 'Deduplicate Runtime halt', scenario: 'career_project'
          }),
          context(`${operation}-w-call`, ['workstream:write'])
        )).data;
        const created = (await executeHost(f,
          command('run.create', `${operation}-r-call`, `${operation}-r-key`, {
            workstreamId: workstream.id, workerKind: 'pi', scope: `${operation} once`
          }),
          ['run:control']
        )).data;
        const started = (await executeHost(f,
          command('run.start', `${operation}-start-call`, `${operation}-start-key`, { runId: created.id }, created.version),
          ['run:control']
        )).data;

        const invocations = [];
        const effectiveHalts = [];
        const completed = new Set();
        const idempotentRuntime = {
          async activate() { throw new Error('activate is not expected'); },
          async halt(run, descriptor) {
            invocations.push({ runId: run.id, descriptor });
            const identity = descriptor
              ? JSON.stringify([descriptor.operation, descriptor.key, descriptor.runtimeReference])
              : `missing-descriptor-${invocations.length}`;
            if (!completed.has(identity)) {
              completed.add(identity);
              effectiveHalts.push({ runId: run.id, descriptor });
            }
          }
        };
        const gateway = f.core.createApplicationContract({ runtimeControl: idempotentRuntime });
        const businessKey = `${operation}-stable-runtime-key`;
        const firstCommand = command(
          `run.${operation}`, `${operation}-retry-call-1`, businessKey, { runId: started.id }, started.version
        );
        failNextRunEvidence = true;
        const first = await gateway.execute(
          firstCommand,
          f.core.bindHostContext(context(`${operation}-retry-call-1`, ['run:control']))
        );
        assert.deepEqual(first.error, { code: 'storage_failure', retryable: true });
        assert.equal((await f.core.repository.getRun(started.id)).status, 'running');

        const retry = await gateway.execute(
          { ...firstCommand, requestId: `${operation}-retry-call-2` },
          f.core.bindHostContext(context(`${operation}-retry-call-2`, ['run:control']))
        );
        assert.equal(retry.ok, true);
        assert.equal(retry.data.status, operation === 'pause' ? 'paused' : 'cancelled');
        assert.equal(invocations.length, 2);
        assert.equal(effectiveHalts.length, 1);
        const expectedDescriptor = {
          operation: `run.${operation}`,
          key: businessKey,
          runtimeReference: { kind: 'pi', id: started.runtimeReference.id }
        };
        assert.deepEqual(invocations.map((call) => call.descriptor), [expectedDescriptor, expectedDescriptor]);
        assert.equal((await f.core.store.db.get(
          'SELECT COUNT(*) count FROM margin_audit_log WHERE operation=? AND entity_id=?',
          `run_${operation}`, started.id
        )).count, 1);
      } finally { await f.cleanup(); }
    });
  }
});

test('start retry reuses one effective Runtime activation after post-activation persistence failure', async () => {
  let failNextRunEvidence = false;
  const f = await fixture({
    beforeEvidenceWrite({ entityType }) {
      if (failNextRunEvidence && entityType === 'run') {
        failNextRunEvidence = false;
        throw new Error('post-activation evidence failure');
      }
    }
  });
  try {
    const workstream = (await f.gateway.execute(
      command('workstream.create', 'activate-w-call', 'activate-w-key', {
        title: 'Activate retry', goal: 'Deduplicate Runtime activation', scenario: 'career_project'
      }),
      context('activate-w-call', ['workstream:write'])
    )).data;
    const created = (await executeHost(f,
      command('run.create', 'activate-r-call', 'activate-r-key', {
        workstreamId: workstream.id, workerKind: 'pi', scope: 'Activate once'
      }),
      ['run:control']
    )).data;

    const invocations = [];
    const effectiveActivations = [];
    const results = new Map();
    const halts = [];
    const idempotentRuntime = {
      async activate(run, descriptor) {
        invocations.push({ runId: run.id, descriptor });
        const identity = descriptor
          ? JSON.stringify([descriptor.operation, descriptor.key, descriptor.runtimeReference])
          : `missing-descriptor-${invocations.length}`;
        if (!results.has(identity)) {
          effectiveActivations.push({ runId: run.id, descriptor });
          results.set(identity, { runtimeSessionId: `idempotent-${run.id}` });
        }
        return results.get(identity);
      },
      async halt(run, descriptor) { halts.push({ runId: run.id, descriptor }); }
    };
    const gateway = f.core.createApplicationContract({ runtimeControl: idempotentRuntime });
    const firstCommand = command('run.start', 'activate-retry-call-1', 'activate-stable-runtime-key', {
      runId: created.id
    }, created.version);
    failNextRunEvidence = true;
    const first = await gateway.execute(
      firstCommand,
      f.core.bindHostContext(context('activate-retry-call-1', ['run:control']))
    );
    assert.deepEqual(first.error, { code: 'storage_failure', retryable: true });
    assert.equal((await f.core.repository.getRun(created.id)).status, 'queued');

    const retry = await gateway.execute(
      { ...firstCommand, requestId: 'activate-retry-call-2' },
      f.core.bindHostContext(context('activate-retry-call-2', ['run:control']))
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.data.status, 'running');
    assert.equal(retry.data.runtimeReference.id, `idempotent-${created.id}`);
    assert.equal(invocations.length, 2);
    assert.equal(effectiveActivations.length, 1);
    const expectedDescriptor = {
      operation: 'run.start', key: 'activate-stable-runtime-key', runtimeReference: null
    };
    assert.deepEqual(invocations.map((call) => call.descriptor), [expectedDescriptor, expectedDescriptor]);
    assert.deepEqual(halts, []);
  } finally { await f.cleanup(); }
});

test('artifact.create without runId returns workstream_not_found before foreign-key write', async () => {
  const f = await fixture();
  try {
    const before = {
      artifacts: (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_artifacts')).count,
      events: (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count,
      audits: (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_audit_log')).count
    };
    const response = await f.gateway.execute(
      command('artifact.create', 'missing-artifact-call', 'missing-artifact-key', {
        workstreamId: 'missing-workstream', type: 'report', title: 'Missing owner',
        resourceReference: { uri: 'margin://artifact/missing', contentHash: 'missing-hash' }
      }),
      context('missing-artifact-call', ['artifact:write'])
    );
    assert.deepEqual(response.error, { code: 'workstream_not_found', retryable: false });
    assert.deepEqual({
      artifacts: (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_artifacts')).count,
      events: (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_events')).count,
      audits: (await f.core.store.db.get('SELECT COUNT(*) count FROM margin_audit_log')).count
    }, before);
  } finally { await f.cleanup(); }
});
