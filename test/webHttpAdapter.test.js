import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMarginCore } from '../src/core/createMarginCore.js';
import { createWebHttpAdapter } from '../src/http/createWebHttpAdapter.js';
import { createWebGateway } from '../src/http/webGateway.js';
import { CONTRACT_VERSION } from '../src/contracts/contractTypes.js';

async function withServer(app, action) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function envelope(requestId, code = null) {
  return code
    ? { ok: false, error: { code, retryable: code === 'runtime_unavailable' || code === 'storage_failure' }, meta: { contractVersion: CONTRACT_VERSION, requestId, correlationId: 'web-correlation' } }
    : { ok: true, data: { requestId }, meta: { contractVersion: CONTRACT_VERSION, requestId, correlationId: 'web-correlation' } };
}

function gatewayFixture({ resultFor = () => null } = {}) {
  const calls = [];
  return {
    calls,
    gateway: {
      async execute(request) { calls.push(['execute', request]); return resultFor(request) ?? envelope(request.requestId); },
      async query(request) { calls.push(['query', request]); return resultFor(request) ?? envelope(request.requestId); },
      async events(request) { calls.push(['events', request]); return resultFor(request) ?? envelope(request.requestId); }
    }
  };
}

test('HTTP adapter exposes a bounded readiness response without touching the Gateway', async () => {
  const f = gatewayFixture();
  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: 'ready', name: 'Margin', surface: 'workbench-gateway', contractVersion: CONTRACT_VERSION });
  });
  assert.equal(f.calls.length, 0);
});

test('HTTP adapter routes native fetch command, query, and event requests through its injected gateway', async () => {
  const f = gatewayFixture();
  const app = createWebHttpAdapter({ webGateway: f.gateway });

  await withServer(app, async (origin) => {
    const commandResponse = await fetch(`${origin}/api/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.create', requestId: 'command-1', idempotencyKey: 'key-1', payload: {} }) });
    const queryResponse = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.list', requestId: 'query-1', payload: {} }) });
    const eventResponse = await fetch(`${origin}/api/events?type=event.list&requestId=event-1&payload=%7B%7D`);

    assert.equal(commandResponse.status, 200);
    assert.equal(queryResponse.status, 200);
    assert.equal(eventResponse.status, 200);
  });
  assert.deepEqual(f.calls.map(([method, request]) => [method, request.requestId]), [
    ['execute', 'command-1'], ['query', 'query-1'], ['events', 'event-1']
  ]);
});

test('HTTP adapter maps stable contract errors, preserves version metadata, and hides private error details', async () => {
  const expectedStatuses = {
    invalid_request: 400, permission_denied: 403, capability_required: 403, not_found: 404,
    workstream_not_found: 404, run_not_found: 404, version_conflict: 409,
    idempotency_conflict: 409, invalid_transition: 409, invalid_workstream_transition: 409,
    open_run_conflict: 409, open_run_exists: 409, run_not_running: 409,
    cross_workstream_reference: 400, runtime_unavailable: 503, runtime_control_required: 503,
    storage_failure: 503
  };
  const f = gatewayFixture({ resultFor: (request) => envelope(request.requestId, request.payload.code) });
  const app = createWebHttpAdapter({ webGateway: f.gateway });

  await withServer(app, async (origin) => {
    for (const [code, status] of Object.entries(expectedStatuses)) {
      const response = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.list', requestId: code, payload: { code } }) });
      assert.equal(response.status, status, code);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.equal(body.meta.contractVersion, CONTRACT_VERSION);
      assert.equal(JSON.stringify(body).includes('stack'), false);
    }
  });
});

test('HTTP adapter preserves only safe application error fields and original retryability', async () => {
  const f = gatewayFixture({ resultFor: (request) => ({
    ok: false,
    error: {
      code: 'version_conflict', retryable: true, message: 'private conflict detail',
      details: { currentVersion: 7, expectedVersion: 6, sql: 'private sql' }
    },
    meta: { contractVersion: CONTRACT_VERSION, requestId: request.requestId, correlationId: 'web-correlation' }
  }) });

  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/queries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'workstream.list', requestId: 'safe-error', payload: {} })
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual(body.error, { code: 'version_conflict', retryable: true, details: { currentVersion: 7 } });
    assert.equal(JSON.stringify(body).includes('private'), false);
    assert.equal(JSON.stringify(body).includes('expectedVersion'), false);
  });
});

test('real Core conflicts retain their stable semantics through Web Gateway and HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-web-http-conflicts-'));
  const core = await createMarginCore({ enabled: true, dbPath: path.join(directory, 'core.sqlite') });
  let sequence = 0;
  const webGateway = createWebGateway({
    core, instanceId: 'real-http-conflicts', idFactory: (prefix) => `${prefix}-${++sequence}`
  });
  const app = createWebHttpAdapter({ webGateway });

  try {
    await withServer(app, async (origin) => {
      const command = async (type, payload, { expectedVersion, idempotencyKey } = {}) => {
        const requestId = `request-${++sequence}`;
        const response = await fetch(`${origin}/api/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type, requestId, idempotencyKey: idempotencyKey ?? `intent-${sequence}`,
            ...(expectedVersion === undefined ? {} : { expectedVersion }), payload
          })
        });
        return { status: response.status, body: await response.json() };
      };
      const query = async (type, payload) => {
        const requestId = `query-${++sequence}`;
        const response = await fetch(`${origin}/api/queries`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type, requestId, payload })
        });
        return { status: response.status, body: await response.json() };
      };

      const created = await command('workstream.create', {
        title: 'Conflict source', goal: 'Exercise safe errors', scenario: 'career_project'
      }, { idempotencyKey: 'shared-create-intent' });
      assert.equal(created.status, 200);
      const workstream = created.body.data;

      const idempotency = await command('workstream.create', {
        title: 'Different input', goal: 'Exercise safe errors', scenario: 'career_project'
      }, { idempotencyKey: 'shared-create-intent' });
      assert.equal(idempotency.status, 409);
      assert.deepEqual(idempotency.body.error, { code: 'idempotency_conflict', retryable: false });

      const version = await command('workstream.update', {
        workstreamId: workstream.id, changes: { nextAction: 'fresh authority' }
      }, { expectedVersion: workstream.version + 10 });
      assert.equal(version.status, 409);
      assert.deepEqual(version.body.error, {
        code: 'version_conflict', retryable: false, details: { currentVersion: workstream.version }
      });

      const run = await command('run.create', {
        workstreamId: workstream.id, workerKind: 'pi', scope: 'Conflict coverage'
      });
      assert.equal(run.status, 200);
      const openRunExists = await command('run.create', {
        workstreamId: workstream.id, workerKind: 'pi', scope: 'Second open Run'
      });
      assert.equal(openRunExists.status, 409);
      assert.equal(openRunExists.body.error.code, 'open_run_exists');

      const currentWorkstream = await query('workstream.get', { workstreamId: workstream.id });
      const openRunConflict = await command('workstream.update', {
        workstreamId: workstream.id, changes: { status: 'completed' }
      }, { expectedVersion: currentWorkstream.body.data.version });
      assert.equal(openRunConflict.status, 409);
      assert.equal(openRunConflict.body.error.code, 'open_run_conflict');

      const need = await command('needs_owner.create', {
        workstreamId: workstream.id, runId: run.body.data.id, type: 'approval',
        reason: 'Approve once', options: [{ id: 'approve', label: 'Approve' }]
      });
      const resolved = await command('needs_owner.resolve', {
        needsOwnerId: need.body.data.id, optionId: 'approve'
      }, { expectedVersion: need.body.data.version });
      assert.equal(resolved.status, 200);
      const transition = await command('needs_owner.resolve', {
        needsOwnerId: need.body.data.id, optionId: 'approve'
      }, { expectedVersion: resolved.body.data.version });
      assert.equal(transition.status, 409);
      assert.equal(transition.body.error.code, 'invalid_transition');

      for (const result of [idempotency, version, openRunExists, openRunConflict, transition]) {
        assert.equal(JSON.stringify(result.body).includes('SQL'), false);
        assert.equal(JSON.stringify(result.body).includes('stack'), false);
        assert.equal(JSON.stringify(result.body).includes('private'), false);
      }
    });
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP adapter requires the closed interaction request before service availability and submits when injected', async () => {
  const f = gatewayFixture();
  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_request');
  });

  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/interactions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workstreamId: 'ws-1', runId: 'run-1', requestId: 'interaction-1', message: 'hello' })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'runtime_unavailable');
  });

  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: { type: 'user' }, requestId: 'forged-interaction', message: 'hello' }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_request');
  });

  const interactions = [];
  await withServer(createWebHttpAdapter({ webGateway: f.gateway, interactionService: { async submit(input) { interactions.push(input); return { message: 'safe', toolResults: [] }; } } }), async (origin) => {
    const response = await fetch(`${origin}/api/interactions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workstreamId: 'ws-1', runId: 'run-1', requestId: 'interaction-1', message: 'hello' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.message, 'safe');
  });
  assert.deepEqual(interactions, [{ workstreamId: 'ws-1', runId: 'run-1', requestId: 'interaction-1', message: 'hello' }]);
});

test('HTTP adapter converts injected middleware errors to sanitized storage failures', async () => {
  const f = gatewayFixture();
  const assertFailure = async (app) => withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.list', requestId: 'middleware-request', payload: {} }) });
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.deepEqual(body.error, { code: 'storage_failure', retryable: true });
    assert.equal(JSON.stringify(body).includes('middleware private detail'), false);
  });

  await assertFailure(createWebHttpAdapter({ webGateway: f.gateway, staticDir: (request, response, next) => {
    response.write('middleware private detail');
    response.end('middleware private detail');
    next(new Error('middleware private detail'));
  } }));
  await assertFailure(createWebHttpAdapter({ webGateway: f.gateway, staticDir: () => { throw new Error('middleware private detail'); } }));
});

test('injected middleware retains native response methods while buffered headers are recoverable', async () => {
  const f = gatewayFixture();
  const app = createWebHttpAdapter({
    webGateway: f.gateway,
    staticDir: (request, response, next) => {
      assert.equal(typeof response.on, 'function');
      assert.equal(typeof response.once, 'function');
      assert.equal(typeof response.getHeaders, 'function');
      assert.equal(typeof response.flushHeaders, 'function');
      assert.equal(typeof response.locals, 'object');
      response.locals.middlewareChecked = true;
      response.on('finish', () => {});
      response.once('close', () => {});
      assert.equal(response.writeHead(201, 'Created', { 'x-buffered-middleware': 'yes' }), response);
      assert.equal(response.statusCode, 201);
      assert.equal(response.getHeaders()['x-buffered-middleware'], 'yes');
      response.flushHeaders();
      next();
    }
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.list', requestId: 'native-response', payload: {} }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-buffered-middleware'), null);
    assert.equal((await response.json()).data.requestId, 'native-response');
  });
});

test('buffered middleware observes native sent and ended state without leaking a later failure', async () => {
  const f = gatewayFixture();
  const observed = [];
  const app = createWebHttpAdapter({
    webGateway: f.gateway,
    staticDir: (request, response, next) => {
      const operation = request.headers['x-buffer-operation'];
      if (operation === 'writeHead') response.writeHead(202, { 'x-private-middleware': 'yes' });
      if (operation === 'write') response.write('middleware private detail');
      if (operation === 'end') response.end('middleware private detail');
      observed.push([operation, response.headersSent, response.writableEnded, response.finished]);
      next(new Error('middleware private detail'));
    }
  });

  await withServer(app, async (origin) => {
    for (const operation of ['writeHead', 'write', 'end']) {
      const response = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-buffer-operation': operation }, body: JSON.stringify({ type: 'workstream.list', requestId: `middleware-${operation}`, payload: {} }) });
      assert.equal(response.status, 503, operation);
      const body = await response.json();
      assert.deepEqual(body.error, { code: 'storage_failure', retryable: true }, operation);
      assert.equal(response.headers.get('x-private-middleware'), null, operation);
      assert.equal(JSON.stringify(body).includes('middleware private detail'), false, operation);
    }
  });

  assert.deepEqual(observed, [
    ['writeHead', true, false, false],
    ['write', true, false, false],
    ['end', true, true, true]
  ]);
});

test('buffered middleware does not commit before an async post-end failure settles', async () => {
  const f = gatewayFixture();
  const app = createWebHttpAdapter({
    webGateway: f.gateway,
    staticDir: async (request, response, next) => {
      response.writeHead(202, { 'x-private-middleware': 'yes' });
      response.end('middleware private detail');
      await Promise.resolve();
      await Promise.resolve();
      next(new Error('middleware private detail'));
    }
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.list', requestId: 'async-middleware-state', payload: {} }) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-private-middleware'), null);
    const body = await response.json();
    assert.deepEqual(body.error, { code: 'storage_failure', retryable: true });
    assert.equal(JSON.stringify(body).includes('middleware private detail'), false);
  });
});

test('GET events rejects forbidden and unknown URL query parameters before dispatch', async () => {
  const f = gatewayFixture();
  const app = createWebHttpAdapter({ webGateway: f.gateway });
  await withServer(app, async (origin) => {
    for (const key of ['actor', 'capabilities', 'databasePath', 'hostAuthority', 'unexpected']) {
      const response = await fetch(`${origin}/api/events?type=event.list&requestId=event-${key}&payload=%7B%7D&${key}=forged`);
      assert.equal(response.status, 400, key);
      assert.equal((await response.json()).error.code, 'invalid_request', key);
    }
  });
  assert.equal(f.calls.length, 0);
});

test('HTTP adapter removes nested Pi and reasoning internals from browser output', async () => {
  const f = gatewayFixture({ resultFor: (request) => request.payload.leak
    ? { ok: true, data: { safe: 'visible', nested: { piSession: 'secret', piConfig: { token: 'secret' }, piCredentials: 'secret', piEnvironment: 'secret', piRequest: 'secret', reasoningTrace: 'secret' } }, meta: { contractVersion: CONTRACT_VERSION, requestId: request.requestId, correlationId: 'web-correlation' } }
    : null });
  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/queries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'workstream.list', requestId: 'private-output', payload: { leak: true } }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, { safe: 'visible', nested: {} });
    assert.equal(JSON.stringify(body).includes('secret'), false);
  });
});

test('GET events malformed payload returns invalid_request without a fabricated stack field', async () => {
  const f = gatewayFixture();
  await withServer(createWebHttpAdapter({ webGateway: f.gateway }), async (origin) => {
    const response = await fetch(`${origin}/api/events?type=event.list&requestId=malformed-event&payload=%7B`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_request');
  });
  assert.equal(f.calls.length, 0);
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/http/createWebHttpAdapter.js', import.meta.url), 'utf8'));
  assert.equal(source.includes("payload: { stack: 'invalid' }"), false);
});

test('HTTP adapter source boundary keeps web files free of Core, storage, Pi, and legacy dependencies', async () => {
  const forbidden = /(?:repositories|sqlite|(?:^|[^a-z])pi(?:[^a-z]|$)|\.\.\/app\.js|legacy|\.\.\/storage\/memoryStore\.js)/i;
  const files = ['webCapabilities.js', 'webGateway.js', 'httpErrors.js', 'createWebHttpAdapter.js'];
  for (const file of files) {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL(`../src/http/${file}`, import.meta.url), 'utf8'));
    const imports = [...source.matchAll(/import(?:[\s\S]*?from\s*)?['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.equal(imports.some((specifier) => forbidden.test(specifier)), false, file);
  }
});
