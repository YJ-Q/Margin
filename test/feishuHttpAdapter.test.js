import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { CONTRACT_VERSION } from '../src/contracts/contractTypes.js';
import { createFeishuHttpAdapter, FEISHU_ROUTES } from '../src/surfaces/feishu/httpAdapter.js';

async function withServer(adapter, run) {
  const server = http.createServer(adapter);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Feishu HTTP adapter owns the declared routes and preserves their response contracts', async () => {
  const calls = [];
  const feishuClient = {};
  const adapter = createFeishuHttpAdapter({
    webhookHandler: { async handle(body, headers) { calls.push({ body, headers }); return { status: 200, body: { accepted: true } }; } },
    feishuClient,
    ownerOpenId: 'owner-id',
    getPilotReady: () => true,
    buildBrief: async (options) => { calls.push(options); },
  });
  assert.deepEqual(FEISHU_ROUTES, ['POST /feishu/webhook', 'GET /health', 'POST /feishu/send-brief']);

  await withServer(adapter, async (origin) => {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-type'), 'application/json');
    assert.deepEqual(await health.json(), { ok: true, status: 'ready', name: 'Margin', surface: 'feishu', contractVersion: CONTRACT_VERSION, pilotReady: true });

    const webhook = await fetch(`${origin}/feishu/webhook`, { method: 'POST', headers: { 'x-test': 'present' }, body: 'event-payload' });
    assert.equal(webhook.status, 200);
    assert.deepEqual(await webhook.json(), { accepted: true });
    assert.equal(calls[0].body, 'event-payload');
    assert.equal(calls[0].headers['x-test'], 'present');

    const brief = await fetch(`${origin}/feishu/send-brief`, { method: 'POST' });
    assert.equal(brief.status, 200);
    assert.deepEqual(await brief.json(), { ok: true });
    assert.deepEqual(calls[1], { feishuClient, receiveId: 'owner-id', receiveIdType: 'open_id' });

    assert.equal((await fetch(`${origin}/feishu/webhook`)).status, 404);
  });
});

test('Feishu HTTP adapter rejects unavailable brief delivery and contains webhook failures', async () => {
  const adapter = createFeishuHttpAdapter({
    webhookHandler: { async handle() { throw new Error('private failure'); } },
    feishuClient: {}, buildBrief: async () => {},
  });
  await withServer(adapter, async (origin) => {
    const brief = await fetch(`${origin}/feishu/send-brief`, { method: 'POST' });
    assert.equal(brief.status, 400);
    assert.deepEqual(await brief.json(), { error: 'FEISHU_OWNER_OPEN_ID not configured' });
    const webhook = await fetch(`${origin}/feishu/webhook`, { method: 'POST', body: '{}' });
    assert.equal(webhook.status, 500);
    assert.deepEqual(await webhook.json(), { error: 'webhook_failed' });
  });
});
