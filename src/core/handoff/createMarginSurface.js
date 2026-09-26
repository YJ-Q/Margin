import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHandoffHttpAdapter } from './httpAdapter.js';
import { createMarginTelemetryService } from '../../telemetry/marginTelemetryService.js';
import { telemetryProfileDir } from '../../telemetry/paths.js';

const DEFAULT_HOST = '127.0.0.1';

function portNumber(value) {
  const port = Number(value ?? 3100);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('invalid_margin_surface_port');
  return port;
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
  if (!address || typeof address === 'string') throw new Error('margin_surface_listen_address_unavailable');
  return { host, port: address.port, origin: `http://${host}:${address.port}` };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// Standalone server for the Margin Board (agent sessions, resources, Smart Handoff).
//
// This is the Runtime Context's host (ADR 003): it owns no persistent Margin state and reads external
// agent facts only. `resolveRuns` is the optional Session ↔ Run bridge — a caller that also owns a
// Core injects a reader, and every other caller gets sessions with no Run attached.
export async function createMarginSurface({
  rootDir = path.resolve('.'),
  staticDir,
  host,
  port,
  dev = false,
  env = process.env,
  resolveRuns = null,
  dependencies = {}
} = {}) {
  const deps = {
    createViteServer: async (options) => (await import('vite')).createServer(options),
    fileExists: existsSync,
    ...dependencies
  };
  const resolvedStaticDir = path.resolve(rootDir, staticDir ?? path.join('web', 'dist'));
  const listenHost = host ?? (env.MARGIN_SURFACE_HOST?.trim() || DEFAULT_HOST);
  const listenPort = portNumber(port ?? env.MARGIN_SURFACE_PORT);
  if (!dev && !deps.fileExists(path.join(resolvedStaticDir, 'margin.html'))) {
    throw new Error('margin_surface_assets_missing: run npm run build before starting');
  }

  let vite;
  let server;
  let telemetry = null;
  let startPromise;
  let closePromise;

  try {
    if (dev) {
      vite = await deps.createViteServer({
        configFile: path.join(rootDir, 'web', 'vite.config.js'),
        server: { middlewareMode: true }, appType: 'spa'
      });
    }
    const app = createHandoffHttpAdapter({
      rootDir,
      env,
      resolveRuns,
      // This server only ever serves the margin page, so root requests are
      // rewritten to margin.html before Vite's SPA fallback (which otherwise
      // defaults to index.html — the old Workbench entry, not this one).
      ...(dev ? { viteMiddleware: rewriteToMarginHtml(vite.middlewares) } : { staticDir: resolvedStaticDir })
    });

    // S4 Cost Telemetry (main-process): additive, error-isolated, deliberately independent of the
    // renderer's visibility/expansion gating so usage is captured even while the window is hidden or
    // collapsed. Optional because the surface must never fail if telemetry cannot initialize.
    const telemetryEnabled = env.MARGIN_TELEMETRY_DISABLED ? env.MARGIN_TELEMETRY_DISABLED.trim().toLowerCase() !== '1' && env.MARGIN_TELEMETRY_DISABLED.trim().toLowerCase() !== 'true' : true;
    telemetry = telemetryEnabled ? createMarginTelemetryService({
      dir: dependencies.telemetryDir ?? telemetryProfileDir({ env }),
      env,
    }) : null;

    async function start() {
      if (closePromise) throw new Error('margin_surface_closed');
      if (startPromise) return startPromise;
      startPromise = (async () => {
        server = http.createServer(app);
        const origin = await listen(server, listenPort, listenHost);
        telemetry?.start();
        return origin;
      })();
      return startPromise;
    }

    async function close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        telemetry?.stop();
        await closeServer(server);
        await vite?.close?.();
      })();
      return closePromise;
    }

    return Object.freeze({ app, start, close, telemetryStatus: () => telemetry?.status?.() ?? { enabled: false } });
  } catch (error) {
    await vite?.close?.().catch(() => {});
    throw error;
  }
}

function rewriteToMarginHtml(middlewares) {
  return (request, response, next) => {
    if (request.url === '/' || request.url === '/index.html') request.url = '/margin.html';
    return middlewares(request, response, next);
  };
}
