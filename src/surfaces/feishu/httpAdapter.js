import { healthPayload } from '../../surfaceHealth.js';

export const FEISHU_ROUTES = Object.freeze(['POST /feishu/webhook', 'GET /health', 'POST /feishu/send-brief']);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

export function createFeishuHttpAdapter({ webhookHandler, feishuClient, ownerOpenId = '', getPilotReady = () => false, buildBrief } = {}) {
  if (!webhookHandler?.handle || !feishuClient || typeof buildBrief !== 'function') throw new TypeError('invalid_feishu_http_dependencies');

  const routes = new Map([
    ['POST /feishu/webhook', async (request, response) => {
      try {
        const result = await webhookHandler.handle(await bodyOf(request), request.headers);
        json(response, result.status, result.body);
      } catch { json(response, 500, { error: 'webhook_failed' }); }
    }],
    ['GET /health', async (_request, response) => {
      json(response, 200, healthPayload({ surface: 'feishu', extra: { pilotReady: Boolean(getPilotReady()) } }));
    }],
    ['POST /feishu/send-brief', async (_request, response) => {
      if (!ownerOpenId) { json(response, 400, { error: 'FEISHU_OWNER_OPEN_ID not configured' }); return; }
      try {
        await buildBrief({ feishuClient, receiveId: ownerOpenId, receiveIdType: 'open_id' });
        json(response, 200, { ok: true });
      } catch (error) { json(response, 500, { error: error.message }); }
    }],
  ]);
  if (routes.size !== FEISHU_ROUTES.length || FEISHU_ROUTES.some((route) => !routes.has(route))) throw new Error('feishu_route_registry_mismatch');

  return (request, response) => {
    const route = routes.get(`${request.method} ${request.url}`);
    if (!route) { response.writeHead(404); response.end(); return; }
    void route(request, response);
  };
}
