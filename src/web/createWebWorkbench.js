import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createInteractionService } from '../application/interactionService.js';
import { createMarginCore } from '../core/createMarginCore.js';
import { createWebHttpAdapter } from '../http/createWebHttpAdapter.js';
import { createWebGateway } from '../http/webGateway.js';
import { createPiTerminalPilotRuntime } from '../runtime/pi/piTerminalPilotRuntime.js';
import { createPiWebRuntimeCoordinator } from '../runtime/pi/piWebRuntimeCoordinator.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_CORE_PATH = path.join('data', 'terminal-pilot', 'margin-core.sqlite');

function stableRuntimeFailure() {
  return Object.freeze({ code: 'runtime_unavailable' });
}

function unavailableRuntimeCoordinator() {
  let reconcilePromise;
  let closed = false;
  return Object.freeze({
    async activate() { throw stableRuntimeFailure(); },
    async halt() { return { halted: true, noOp: true }; },
    async interact() { return { error: { code: 'runtime_unavailable', retryable: true } }; },
    async reconcile(runningRuns, pause) {
      if (reconcilePromise) return reconcilePromise;
      reconcilePromise = (async () => {
        if (!Array.isArray(runningRuns) || typeof pause !== 'function') throw new TypeError('invalid_runtime_reconciliation');
        for (const run of runningRuns) await pause(run);
      })();
      return reconcilePromise;
    },
    async close() { closed = true; },
    get closed() { return closed; }
  });
}

function providerConfig(env) {
  const provider = env.MARGIN_PI_PROVIDER ?? 'yapi';
  const modelId = env.MARGIN_PI_MODEL ?? 'gpt-5.6-terra';
  const baseUrl = env.MARGIN_PI_BASE_URL ?? (provider === 'yapi' ? 'https://yapi.click/v1' : undefined);
  const api = env.MARGIN_PI_API ?? (provider === 'yapi' ? 'openai-responses' : undefined);
  const keyName = env.MARGIN_PI_API_KEY_ENV ?? (provider === 'yapi' ? 'YAPI_API_KEY' : undefined);
  const apiKey = keyName ? env[keyName] : undefined;
  if (![provider, modelId, baseUrl, api, apiKey].every((value) => typeof value === 'string' && value.trim())) return null;
  return { provider, modelId, customProvider: { baseUrl, api, apiKey } };
}

function portNumber(value) {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('invalid_web_port');
  return port;
}

function dataOf(result) {
  if (result?.ok === true) return result.data;
  throw Object.assign(new Error(result?.error?.code ?? 'web_composition_failure'), { code: result?.error?.code ?? 'storage_failure' });
}

async function runningRuns(gateway) {
  const results = [];
  let workstreamCursor;
  do {
    const page = dataOf(await gateway.internalQuery('workstream.list', {
      limit: 100, ...(workstreamCursor ? { cursor: workstreamCursor } : {})
    }));
    for (const workstream of page.items) {
      let runCursor;
      do {
        const runs = dataOf(await gateway.internalQuery('run.list', {
          workstreamId: workstream.id, statuses: ['running'], limit: 100,
          ...(runCursor ? { cursor: runCursor } : {})
        }));
        results.push(...runs.items);
        runCursor = runs.nextCursor;
      } while (runCursor);
    }
    workstreamCursor = page.nextCursor;
  } while (workstreamCursor);
  return results;
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('web_listen_address_unavailable');
  return { host, port: address.port, origin: `http://${host}:${address.port}` };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function createWebWorkbench({
  rootDir = path.resolve('.'),
  dbPath,
  staticDir,
  agentDir,
  host,
  port,
  dev = false,
  env = process.env,
  clock = () => new Date().toISOString(),
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
  dependencies = {}
} = {}) {
  const deps = {
    createMarginCore,
    createPiTerminalPilotRuntime,
    createPiWebRuntimeCoordinator,
    createWebGateway,
    createInteractionService,
    createWebHttpAdapter,
    createHttpServer: (app) => http.createServer(app),
    createViteServer: async (options) => (await import('vite')).createServer(options),
    fileExists: existsSync,
    ...dependencies
  };
  const resolvedDbPath = path.resolve(rootDir, dbPath ?? env.MARGIN_CORE_DB_PATH ?? DEFAULT_CORE_PATH);
  const resolvedStaticDir = path.resolve(rootDir, staticDir ?? path.join('web', 'dist'));
  const resolvedAgentDir = path.resolve(rootDir, agentDir ?? path.join('data', 'terminal-pilot', 'web-agent'));
  const listenHost = host ?? (env.MARGIN_WEB_HOST?.trim() || DEFAULT_HOST);
  const listenPort = portNumber(port ?? env.PORT);
  if (typeof listenHost !== 'string' || !listenHost.trim()) throw new TypeError('invalid_web_host');
  // The Workbench UI was removed with the surface consolidation (ADR 003). This server is now the
  // Application Contract's transport only: it starts API-only and never requires a built front end.
  // A caller that supplies assets still gets them mounted.
  const hasStaticApp = !dev && deps.fileExists(path.join(resolvedStaticDir, 'index.html'));

  await mkdir(path.dirname(resolvedDbPath), { recursive: true });
  await mkdir(resolvedAgentDir, { recursive: true });
  let core;
  let runtimeCoordinator;
  let vite;
  let server;
  let startPromise;
  let closePromise;
  let started;

  try {
    core = await deps.createMarginCore({ enabled: true, dbPath: resolvedDbPath, clock, idFactory });
    const piConfig = providerConfig(env);
    if (piConfig) {
      const runtime = await deps.createPiTerminalPilotRuntime({
        repositoryRoot: rootDir, agentDir: resolvedAgentDir, ...piConfig, tools: core.v1Tools
      });
      runtimeCoordinator = deps.createPiWebRuntimeCoordinator({
        runtime, tools: core.v1Tools,
        invocationContextFactory: async ({ run, workstreamId, toolCallId }) => ({
          actorType: 'agent', subjectId: 'local-web-runtime',
          permissions: { memoryRead: true, memoryPropose: true, stateWrite: true, actionWrite: true },
          confirmations: [], sourceSessionId: run?.runtimeReference?.id ?? run?.runtime_session_id ?? run?.id,
          sourceEventId: toolCallId, projectId: workstreamId
        })
      });
    } else {
      runtimeCoordinator = unavailableRuntimeCoordinator();
    }
    const gateway = deps.createWebGateway({
      core, runtimeControl: runtimeCoordinator,
      instanceId: idFactory('web_instance'), idFactory
    });
    const interactionService = deps.createInteractionService({
      webGateway: gateway, continuity: core.continuity, runtimeCoordinator, clock
    });
    if (dev) {
      vite = await deps.createViteServer({
        configFile: path.join(rootDir, 'web', 'vite.config.js'),
        server: { middlewareMode: true }, appType: 'spa'
      });
    }
    const app = deps.createWebHttpAdapter({
      webGateway: gateway, interactionService,
      ...(dev ? { viteMiddleware: vite.middlewares } : (hasStaticApp ? { staticDir: resolvedStaticDir } : {}))
    });

    async function reconcile() {
      const durableRunningRuns = await runningRuns(gateway);
      await runtimeCoordinator.reconcile(durableRunningRuns, async (run) => {
        const requestId = idFactory('web_reconcile_pause');
        dataOf(await gateway.execute({
          type: 'run.pause', requestId, idempotencyKey: requestId,
          expectedVersion: run.version, payload: { runId: run.id }
        }));
      });
    }

    async function start() {
      if (closePromise) throw new Error('web_workbench_closed');
      if (startPromise) return startPromise;
      startPromise = (async () => {
        await reconcile();
        server = deps.createHttpServer(app);
        started = await listen(server, listenPort, listenHost);
        return Object.freeze({ ...started, dbPath: resolvedDbPath });
      })();
      return startPromise;
    }

    async function close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const failures = [];
        for (const operation of [
          () => closeServer(server),
          () => runtimeCoordinator?.close?.(),
          () => vite?.close?.(),
          () => core?.close?.()
        ]) {
          try { await operation(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw failures[0];
      })();
      return closePromise;
    }

    return Object.freeze({ app, gateway, core, runtimeCoordinator, start, close, dbPath: resolvedDbPath, host: listenHost });
  } catch (error) {
    await Promise.allSettled([runtimeCoordinator?.close?.(), vite?.close?.(), core?.close?.()]);
    throw error;
  }
}
