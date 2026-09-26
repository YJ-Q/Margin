import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_TYPES, CONTRACT_VERSION, EVENT_QUERY_TYPES, QUERY_TYPES } from '../src/contracts/contractTypes.js';
import {
  WEB_COMMAND_CAPABILITIES,
  WEB_EVENT_CAPABILITIES,
  WEB_QUERY_CAPABILITIES,
  createWebGateway
} from '../src/http/webGateway.js';

const command = {
  type: 'workstream.create', requestId: 'browser-request-1', idempotencyKey: 'browser-command-1',
  payload: { title: 'Web Workstream', goal: 'Exercise the web gateway', scenario: 'career_project' }
};

function fixture({ response, throws } = {}) {
  const calls = [];
  const hostBindings = [];
  let receivedRuntimeControl;
  const contract = Object.freeze({
    async execute(request, context) {
      calls.push({ method: 'execute', request, context });
      if (throws) throw new Error('private storage failure');
      return response ?? { ok: true, data: { id: 'workstream-1' }, meta: { contractVersion: CONTRACT_VERSION, requestId: request.requestId, correlationId: context.correlationId } };
    },
    async query(request, context) {
      calls.push({ method: 'query', request, context });
      return { ok: true, data: { items: [] }, meta: { contractVersion: CONTRACT_VERSION, requestId: request.requestId, correlationId: context.correlationId } };
    },
    async events(request, context) {
      calls.push({ method: 'events', request, context });
      return { ok: true, data: { items: [] }, meta: { contractVersion: CONTRACT_VERSION, requestId: request.requestId, correlationId: context.correlationId } };
    }
  });
  return {
    core: {
      createApplicationContract({ runtimeControl }) { receivedRuntimeControl = runtimeControl; return contract; },
      bindHostContext(context) { const trusted = Object.freeze({ ...context, hostBound: true }); hostBindings.push(trusted); return trusted; }
    },
    calls,
    hostBindings,
    get receivedRuntimeControl() { return receivedRuntimeControl; }
  };
}

test('web gateway derives browser identity, capability, surface, and host-bound mutation context', async () => {
  const f = fixture();
  const runtimeControl = { activate() {}, halt() {} };
  const gateway = createWebGateway({ core: f.core, runtimeControl, instanceId: 'web-1', idFactory: (prefix) => `${prefix}-generated` });

  const result = await gateway.execute(command);

  assert.equal(result.ok, true);
  assert.equal(f.receivedRuntimeControl, runtimeControl);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].context.actor, { type: 'user', subjectId: 'local-web-user' });
  assert.deepEqual(f.calls[0].context.surface, { kind: 'web', instanceId: 'web-1' });
  assert.deepEqual(f.calls[0].context.capabilities, ['workstream:write']);
  assert.equal(f.calls[0].context.hostBound, true);
  assert.equal(f.hostBindings.length, 1);
  assert.equal(Object.isFrozen(gateway), true);
});

test('web gateway rejects caller-supplied trust fields before dispatch', async () => {
  const f = fixture();
  const gateway = createWebGateway({ core: f.core, instanceId: 'web-1', idFactory: (prefix) => `${prefix}-generated` });

  for (const forbidden of ['actor', 'capabilities', 'databasePath', 'hostAuthority']) {
    const result = await gateway.execute({ ...command, [forbidden]: 'forged' });
    assert.deepEqual(result.error.code, 'invalid_request');
  }
  assert.equal(f.calls.length, 0);
});

test('web gateway rejects malformed browser request identities before host binding', async () => {
  const f = fixture();
  const gateway = createWebGateway({ core: f.core, instanceId: 'web-1', idFactory: (prefix) => `${prefix}-generated` });

  const result = await gateway.execute({ ...command, requestId: null });

  assert.equal(result.error.code, 'invalid_request');
  assert.equal(f.calls.length, 0);
  assert.equal(f.hostBindings.length, 0);
});

test('web capability maps are frozen, closed, and cover every contract type exactly once', () => {
  for (const [types, capabilities] of [
    [COMMAND_TYPES, WEB_COMMAND_CAPABILITIES],
    [QUERY_TYPES, WEB_QUERY_CAPABILITIES],
    [EVENT_QUERY_TYPES, WEB_EVENT_CAPABILITIES]
  ]) {
    assert.equal(Object.isFrozen(capabilities), true);
    assert.deepEqual(Object.keys(capabilities).sort(), [...types].sort());
    assert.equal(new Set(Object.keys(capabilities)).size, types.length);
  }
});

test('web internal query and event helpers create request IDs and follow the trusted gateway path', async () => {
  const f = fixture();
  let sequence = 0;
  const gateway = createWebGateway({ core: f.core, instanceId: 'web-1', idFactory: (prefix) => `${prefix}-${++sequence}` });

  await gateway.internalQuery('workstream.list', {});
  await gateway.internalEvents('event.list', {});

  assert.deepEqual(f.calls.map((call) => [call.method, call.request.requestId]), [
    ['query', 'web_query_request-2'], ['events', 'web_event_request-3']
  ]);
  assert.equal(f.calls.every((call) => call.request.requestId === call.context.requestId && call.context.hostBound), true);
  assert.deepEqual(f.calls.map((call) => call.context.capabilities), [['workstream:read'], ['event:read']]);
});

test('web gateway sanitizes thrown failures and private response values', async () => {
  const failed = fixture({ throws: true });
  const failedGateway = createWebGateway({ core: failed.core, instanceId: 'web-1', idFactory: (prefix) => `${prefix}-generated` });
  const failedResult = await failedGateway.execute(command);
  assert.deepEqual(failedResult, {
    ok: false,
    error: { code: 'storage_failure', retryable: true },
    meta: { contractVersion: CONTRACT_VERSION, requestId: 'browser-request-1', correlationId: 'web_correlation-generated' }
  });

  const unsafe = fixture({ response: { ok: true, data: { stack: 'secret' }, meta: { contractVersion: CONTRACT_VERSION, requestId: 'browser-request-1', correlationId: 'x' } } });
  const unsafeGateway = createWebGateway({ core: unsafe.core, instanceId: 'web-1', idFactory: (prefix) => `${prefix}-generated` });
  const unsafeResult = await unsafeGateway.execute(command);
  assert.deepEqual(unsafeResult.data, {});
  assert.equal(JSON.stringify(unsafeResult).includes('secret'), false);
});
