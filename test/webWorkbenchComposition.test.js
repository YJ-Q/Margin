import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMarginCore } from '../src/core/createMarginCore.js';
import { createWebWorkbench } from '../src/web/createWebWorkbench.js';

const pinnedNode = path.resolve('.runtime/node-v22.23.1-win-x64/node.exe');

function fakeRuntime(calls) {
  let sequence = 0;
  return {
    async createSession() {
      const id = `fake-pi-${++sequence}`;
      return { id, async send() { return { text: '', toolResults: [] }; }, async close() { calls.push(['session.close', id]); } };
    },
    async haltSession(id) { calls.push(['runtime.haltSession', id]); return { halted: true }; },
    async close() { calls.push(['runtime.close']); }
  };
}

async function fixture({ dev = false } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'margin-web-composition-'));
  const staticDir = path.join(rootDir, 'web', 'dist');
  await mkdir(staticDir, { recursive: true });
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Margin Workbench</title>', 'utf8');
  const dbPath = path.join(rootDir, 'configured', 'core.sqlite');
  const calls = [];
  let coreOpenCount = 0;
  let coreCloseCount = 0;
  let viteCloseCount = 0;
  const dependencies = {
    async createMarginCore(options) {
      coreOpenCount += 1;
      calls.push(['core.open', options.dbPath]);
      const core = await createMarginCore(options);
      const close = core.close;
      core.close = async () => { coreCloseCount += 1; await close(); };
      return core;
    },
    async createPiTerminalPilotRuntime(options) {
      calls.push(['runtime.config', options.provider, options.modelId, options.customProvider.baseUrl, options.customProvider.api, Boolean(options.customProvider.apiKey)]);
      return fakeRuntime(calls);
    },
    async createViteServer() {
      return {
        middlewares(request, response, next) {
          if (request.url === '/__vite_probe') return response.end('vite-ok');
          if (request.url.startsWith('/api/')) return response.end('<!doctype html><main>vite-spa</main>');
          return next();
        },
        async close() { viteCloseCount += 1; }
      };
    }
  };
  const workbench = await createWebWorkbench({
    rootDir, dbPath, staticDir, dev, host: '127.0.0.1', port: 0,
    env: { YAPI_API_KEY: 'present-for-test' }, dependencies
  });
  return {
    rootDir, staticDir, dbPath, calls, workbench,
    get coreOpenCount() { return coreOpenCount; },
    get coreCloseCount() { return coreCloseCount; },
    get viteCloseCount() { return viteCloseCount; },
    async cleanup() { await workbench.close().catch(() => {}); await rm(rootDir, { recursive: true, force: true }); }
  };
}

test('composition opens exactly one configured Core, uses terminal-safe Pi defaults, binds loopback, and closes once', async () => {
  const f = await fixture();
  try {
    const started = await f.workbench.start();
    assert.equal(f.coreOpenCount, 1);
    assert.deepEqual(f.calls.find(([kind]) => kind === 'core.open'), ['core.open', f.dbPath]);
    assert.deepEqual(f.calls.find(([kind]) => kind === 'runtime.config'), [
      'runtime.config', 'yapi', 'gpt-5.6-terra', 'https://yapi.click/v1', 'openai-responses', true
    ]);
    assert.equal(started.host, '127.0.0.1');
    assert.ok(started.port > 0);
    const health = await fetch(`${started.origin}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, status: 'ready', name: 'Margin', surface: 'workbench-gateway', contractVersion: '1.1' });

    await f.workbench.close();
    await f.workbench.close();
    assert.equal(f.coreCloseCount, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'runtime.close').length, 1);
  } finally { await f.cleanup(); }
});

test('development uses injected Vite middleware and closes it once', async () => {
  const f = await fixture({ dev: true });
  try {
    const started = await f.workbench.start();
    assert.equal(await fetch(`${started.origin}/__vite_probe`).then((response) => response.text()), 'vite-ok');
    await f.workbench.close();
    await f.workbench.close();
    assert.equal(f.viteCloseCount, 1);
  } finally { await f.cleanup(); }
});

test('development routes health, commands, queries, and events before the Vite SPA fallback', async () => {
  const f = await fixture({ dev: true });
  try {
    const started = await f.workbench.start();
    const api = async (route, options) => {
      const response = await fetch(`${started.origin}${route}`, options);
      return { status: response.status, body: await response.json() };
    };
    const health = await api('/api/health');
    assert.deepEqual(health, { status: 200, body: { ok: true, status: 'ready', name: 'Margin', surface: 'workbench-gateway', contractVersion: '1.1' } });

    const query = await api('/api/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'workstream.list', requestId: 'dev-query', payload: { limit: 10 } })
    });
    assert.equal(query.body.ok, true);
    assert.deepEqual(query.body.data.items, []);

    const command = await api('/api/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'workstream.create', requestId: 'dev-command', idempotencyKey: 'dev-command-intent',
        payload: {
          title: 'Development API route', goal: 'Exercise the adapter before Vite', scenario: 'career_project',
          currentPlan: ['call the API'], nextAction: 'verify the event route'
        }
      })
    });
    assert.equal(command.body.ok, true);

    const eventPayload = encodeURIComponent(JSON.stringify({ workstreamId: command.body.data.id, afterCursor: 0, limit: 10 }));
    const events = await api(`/api/events?type=event.list&requestId=dev-events&payload=${eventPayload}`);
    assert.equal(events.body.ok, true);
    assert.ok(events.body.data.items.length > 0);
  } finally { await f.cleanup(); }
});

test('production composition starts API-only when no web assets are present', async () => {
  // The Workbench UI was removed with the surface consolidation (ADR 003). This server is now the
  // Application Contract's transport, so an absent front end is the NORMAL case and must not stop Core
  // from opening. The previous behaviour refused to start, which is the coupling this change removes.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'margin-web-api-only-'));
  const workbench = await createWebWorkbench({ rootDir, port: 0, dbPath: path.join(rootDir, 'core.sqlite') });
  try {
    const started = await workbench.start();
    assert.ok(started.port > 0);
    const health = await fetch(`${started.origin}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, status: 'ready', name: 'Margin', surface: 'workbench-gateway', contractVersion: '1.1' });
    // The API answers; nothing is served for a browser path because no static app is mounted.
    const page = await fetch(`${started.origin}/`);
    assert.equal(page.status, 404);
  } finally {
    await workbench.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('web composition and entrypoint have no legacy application, route, store, or echo database imports', async () => {
  for (const relative of ['src/web/createWebWorkbench.js', 'scripts/run-web-workbench.js']) {
    const source = await readFile(path.resolve(relative), 'utf8');
    const imports = [...source.matchAll(/import(?:[\s\S]*?from\s*)?['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.equal(imports.some((specifier) => /(?:^|\/)app\.js$|routes\/|storage\/memoryStore|echo\.sqlite/iu.test(specifier)), false, relative);
  }
});

test('environment selects the configured Core path and ephemeral listen port', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'margin-web-env-config-'));
  const staticDir = path.join(rootDir, 'web', 'dist');
  const configured = path.join('isolated', 'configured.sqlite');
  let openedPath;
  let workbench;
  try {
    await mkdir(staticDir, { recursive: true });
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html>', 'utf8');
    workbench = await createWebWorkbench({
      rootDir, staticDir,
      env: { MARGIN_CORE_DB_PATH: configured, MARGIN_WEB_HOST: '127.0.0.1', PORT: '0' },
      dependencies: {
        async createMarginCore(options) { openedPath = options.dbPath; return createMarginCore(options); }
      }
    });
    const started = await workbench.start();
    assert.equal(openedPath, path.resolve(rootDir, configured));
    assert.equal(started.host, '127.0.0.1');
    assert.ok(started.port > 0);
  } finally {
    await workbench?.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('package, Docker, environment example, and launchers expose exact Phase 2B entrypoint semantics', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  assert.equal(packageJson.scripts.build, 'vite build --config web/vite.config.js');
  assert.equal(packageJson.scripts['legacy:workbench'], '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-web-workbench.js');
  assert.equal(packageJson.scripts['pilot:terminal'], '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-terminal-pilot.js');
  assert.equal(packageJson.scripts['legacy:api'], '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-legacy-api.js');
  assert.doesNotMatch(packageJson.scripts.start, /build/u);

  const [dockerfile, compose, marginLauncher, echoLauncher, envExample] = await Promise.all([
    readFile(path.resolve('Dockerfile'), 'utf8'), readFile(path.resolve('docker-compose.yml'), 'utf8'),
    readFile(path.resolve('run-margin-local.cmd'), 'utf8'), readFile(path.resolve('run-echo-local.cmd'), 'utf8'),
    readFile(path.resolve('.env.example'), 'utf8')
  ]);
  assert.match(dockerfile, /npm run build/u);
  assert.match(dockerfile, /scripts\/run-margin-surface\.js/u);
  assert.match(dockerfile, /MARGIN_SURFACE_HOST=0\.0\.0\.0/u);
  assert.match(dockerfile, /MARGIN_SURFACE_PORT=3000/u);
  assert.match(compose, /MARGIN_SURFACE_HOST=0\.0\.0\.0/u);
  assert.match(compose, /MARGIN_SURFACE_PORT=3000/u);
  assert.match(compose, /['"]127\.0\.0\.1:3000:3000['"]/u);
  assert.doesNotMatch(compose, /['"]3000:3000['"]/u);
  assert.match(marginLauncher, /scripts\\run-margin-surface\.js/u);
  assert.doesNotMatch(marginLauncher, /src\\server\.js/u);
  assert.match(echoLauncher, /deprecated/iu);
  assert.match(echoLauncher, /scripts\\run-legacy-api\.js/u);
  assert.match(envExample, /MARGIN_SURFACE_HOST=127\.0\.0\.1/u);
});

test('legacy server direct launch is gated and the deliberate wrapper owns the opt-in flag', async () => {
  const env = { ...process.env };
  delete env.MARGIN_ENABLE_LEGACY_API;
  const blocked = spawnSync(pinnedNode, ['src/server.js'], { cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 2_000 });
  assert.equal(blocked.status, 1, blocked.error?.message ?? blocked.stderr);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /legacy_api_disabled/u);

  const wrapper = await readFile(path.resolve('scripts/run-legacy-api.js'), 'utf8');
  assert.match(wrapper, /MARGIN_ENABLE_LEGACY_API\s*=\s*['"]true['"]/u);
  assert.match(wrapper, /deprecated/iu);
});
