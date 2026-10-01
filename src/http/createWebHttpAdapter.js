import express from 'express';
import { failureEnvelope, hasForbiddenBrowserField, httpStatusFor, sanitizeBrowserEnvelope } from './httpErrors.js';
import { healthPayload } from '../surfaceHealth.js';

export function createWebHttpAdapter({ webGateway, interactionService, staticDir, staticIndexFile = 'index.html', viteMiddleware } = {}) {
  if (!webGateway?.execute || !webGateway?.query || !webGateway?.events) throw new TypeError('invalid_web_http_dependencies');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  if (typeof staticDir === 'function') app.use(bufferedMiddleware(staticDir));
  // The canonical built entry is named after the surface (margin.html, see web/vite.config.js), not
  // index.html, so the static index is explicit rather than relying on express's index.html default.
  else if (staticDir) app.use(express.static(staticDir, { index: staticIndexFile }));
  if (typeof viteMiddleware === 'function') app.use(bufferedMiddleware(viteMiddleware, { bypass: isApiRequest }));

  app.get('/api/health', (_request, response) => response.json(healthPayload({ surface: 'workbench-gateway' })));
  app.post('/api/commands', asyncRoute((request) => webGateway.execute(request)));
  app.post('/api/queries', asyncRoute((request) => webGateway.query(request)));
  app.get('/api/events', asyncRoute((request) => webGateway.events(request)));
  app.post('/api/interactions', async (request, response) => {
    const input = interactionInput(request.body);
    const requestId = input?.requestId ?? request.body?.requestId;
    if (!input) return respond(response, failureEnvelope({ code: 'invalid_request', requestId }));
    if (!interactionService?.submit) return respond(response, failureEnvelope({ code: 'runtime_unavailable', requestId }));
    try { return respond(response, interactionEnvelope(await interactionService.submit(input), input.requestId)); }
    catch { return respond(response, failureEnvelope({ code: 'storage_failure', requestId })); }
  });
  app.use((error, request, response, _next) => {
    if (error?.type === 'entity.parse.failed' || error?.status === 413) return respond(response, failureEnvelope({ code: 'invalid_request', requestId: request.body?.requestId }));
    if (response.headersSent) return response.destroy();
    return respond(response, failureEnvelope({ code: 'storage_failure', requestId: request.body?.requestId }));
  });
  return app;
}

function isApiRequest(request) {
  return request.path.startsWith('/api/');
}

function interactionInput(value) {
  const fields = ['workstreamId', 'runId', 'message', 'requestId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || hasForbiddenBrowserField(value) ||
    Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) return null;
  const [workstreamId, runId, message, requestId] = fields.map((field) => value[field]);
  if (![workstreamId, runId, requestId].every((item) => typeof item === 'string' && item.trim() && item.length <= 2_000) ||
    typeof message !== 'string' || !message.trim() || message.length > 2_000) return null;
  return { workstreamId, runId, message, requestId };
}

function interactionEnvelope(result, requestId) {
  if (result?.error) return failureEnvelope({ code: result.error.code, requestId });
  if (result?.ok === false) return sanitizeBrowserEnvelope(result, { requestId });
  return sanitizeBrowserEnvelope({
    ok: true,
    data: interactionData(result),
    meta: { requestId }
  }, { requestId });
}

function interactionData(value) {
  const result = value && typeof value === 'object' ? value : {};
  return {
    message: boundedString(result.message, 2_000) ?? '',
    toolResults: (Array.isArray(result.toolResults) ? result.toolResults : []).slice(0, 20).map(toolEvidence),
    ...(result.workstream && typeof result.workstream === 'object' ? { workstream: result.workstream } : {}),
    ...(result.run && typeof result.run === 'object' ? { run: result.run } : {}),
    ...(result.events && typeof result.events === 'object' ? { events: result.events } : {})
  };
}

function toolEvidence(value) {
  const tool = value && typeof value === 'object' ? value : {};
  return {
    ...(boundedString(tool.toolName, 100) ? { toolName: tool.toolName } : {}),
    ...(boundedString(tool.code, 100) ? { code: tool.code } : {}),
    ...(boundedString(tool.auditId, 200) ? { auditId: tool.auditId } : {}),
    ...(boundedString(tool.entityId, 200) ? { entityId: tool.entityId } : {}),
    ...(Number.isInteger(tool.entityVersion) && tool.entityVersion >= 0 ? { entityVersion: tool.entityVersion } : {})
  };
}

function boundedString(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null;
}

function asyncRoute(dispatch) {
  return async (request, response) => {
    const envelope = request.method === 'GET' ? eventRequest(request) : request.body;
    const requestId = envelope?.requestId;
    if (envelope?.invalid) return respond(response, failureEnvelope({ code: 'invalid_request', requestId }));
    if (hasForbiddenBrowserField(envelope)) return respond(response, failureEnvelope({ code: 'invalid_request', requestId }));
    try { return respond(response, sanitizeBrowserEnvelope(await dispatch(envelope), { requestId })); }
    catch { return respond(response, failureEnvelope({ code: 'storage_failure', requestId })); }
  };
}

function eventRequest(request) {
  const allowed = new Set(['type', 'requestId', 'payload']);
  if (Object.keys(request.query).some((key) => !allowed.has(key))) return { invalid: true, requestId: request.query.requestId };
  if (Object.values(request.query).some((value) => Array.isArray(value))) return { invalid: true, requestId: request.query.requestId };
  try {
    const payload = request.query.payload === undefined ? {} : JSON.parse(request.query.payload);
    return { type: request.query.type, requestId: request.query.requestId, payload };
  } catch {
    return { invalid: true, requestId: request.query.requestId };
  }
}

function respond(response, envelope) {
  return response.status(httpStatusFor(envelope)).json(envelope);
}

function bufferedMiddleware(middleware, { bypass } = {}) {
  return (request, response, next) => {
    if (bypass?.(request)) return next();
    const capture = interceptResponse(response);
    let completed = false;
    let middlewareCompletion = null;
    const continueRequest = (error) => {
      if (completed) return;
      completed = true;
      capture.discard();
      next(error);
    };
    capture.whenEnded(() => deferCommit(() => {
      if (completed) return;
      const commit = () => {
        if (completed) return;
        completed = true;
        capture.commit();
      };
      if (middlewareCompletion) middlewareCompletion.then(commit, continueRequest);
      else commit();
    }));
    try {
      const pending = middleware(request, response, continueRequest);
      if (pending?.then) {
        middlewareCompletion = Promise.resolve(pending);
        middlewareCompletion.catch(continueRequest);
      }
    } catch (error) {
      continueRequest(error);
    }
  };
}

function interceptResponse(response) {
  const original = Object.fromEntries([
    'write', 'end', 'writeHead', 'setHeader', 'getHeader', 'getHeaders', 'getHeaderNames',
    'hasHeader', 'removeHeader', 'flushHeaders'
  ].map((name) => [name, response[name]]));
  const restores = new Map();
  const headers = new Map(Object.entries(original.getHeaders.call(response)));
  const writes = [];
  const initialStatusCode = response.statusCode;
  const initialStatusMessage = response.statusMessage;
  let endArgs = null;
  let onEnd = () => {};
  let virtualHeadersSent = response.headersSent;

  const replaceDescriptor = (name, descriptor) => {
    restores.set(name, Object.getOwnPropertyDescriptor(response, name));
    Object.defineProperty(response, name, { configurable: true, ...descriptor });
  };
  const replace = (name, value) => replaceDescriptor(name, { writable: true, value });
  const restore = ({ keepStatus = false } = {}) => {
    for (const [name, descriptor] of restores) {
      if (descriptor) Object.defineProperty(response, name, descriptor);
      else delete response[name];
    }
    restores.clear();
    if (!keepStatus) {
      response.statusCode = initialStatusCode;
      response.statusMessage = initialStatusMessage;
    }
  };
  const setHeader = (name, value) => headers.set(String(name).toLowerCase(), value);
  const applyHead = (code, message, values) => {
    response.statusCode = code;
    if (typeof message === 'string') {
      response.statusMessage = message;
    }
    if (Array.isArray(values)) {
      for (let index = 0; index < values.length; index += 2) setHeader(values[index], values[index + 1]);
    } else if (values && typeof values === 'object') {
      Object.entries(values).forEach(([name, value]) => setHeader(name, value));
    }
  };

  replaceDescriptor('headersSent', { enumerable: true, get: () => virtualHeadersSent });
  replaceDescriptor('writableEnded', { get: () => response.finished });
  replaceDescriptor('writableFinished', { get: () => response.finished });
  replace('finished', response.finished);
  replace('setHeader', (name, value) => { setHeader(name, value); return response; });
  replace('getHeader', (name) => headers.get(String(name).toLowerCase()));
  replace('getHeaders', () => Object.fromEntries(headers));
  replace('getHeaderNames', () => [...headers.keys()]);
  replace('hasHeader', (name) => headers.has(String(name).toLowerCase()));
  replace('removeHeader', (name) => { headers.delete(String(name).toLowerCase()); });
  replace('flushHeaders', () => { virtualHeadersSent = true; });
  replace('writeHead', (code, messageOrHeaders, maybeHeaders) => {
    applyHead(code, messageOrHeaders, typeof messageOrHeaders === 'string' ? maybeHeaders : messageOrHeaders);
    virtualHeadersSent = true;
    return response;
  });
  replace('write', (...args) => {
    if (!endArgs) {
      virtualHeadersSent = true;
      writes.push(args);
    }
    return true;
  });
  replace('end', (...args) => {
    if (endArgs) return response;
    virtualHeadersSent = true;
    response.finished = true;
    endArgs = args;
    onEnd();
    return response;
  });

  return {
    whenEnded(callback) { onEnd = callback; },
    discard() { restore(); },
    commit() {
      const committedStatusCode = response.statusCode;
      const committedStatusMessage = response.statusMessage;
      restore({ keepStatus: true });
      if (response.headersSent) return;
      response.statusCode = committedStatusCode;
      response.statusMessage = committedStatusMessage;
      headers.forEach((value, name) => response.setHeader(name, value));
      writes.forEach((args) => original.write.apply(response, args));
      original.end.apply(response, endArgs ?? []);
    }
  };
}

function deferCommit(callback) {
  queueMicrotask(() => queueMicrotask(callback));
}
