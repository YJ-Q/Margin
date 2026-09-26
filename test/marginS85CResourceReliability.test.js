import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createHandoffHttpAdapter } from '../src/core/handoff/httpAdapter.js';
import { createCodexLiveResourceReader } from '../src/resources/codexLiveResource.js';
import { getAgentResourceStatus } from '../src/resources/agentResourceService.js';
import { collectPiResourceSnapshot, resetPiResourceCache } from '../src/resources/piApiUsage.js';
import { MarginApp } from '../web/src/margin/MarginApp.js';
import { UsageBar } from '../web/src/margin/SessionBoard.js';
import { createMarginApiClient } from '../web/src/margin/marginApiClient.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(app) {
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// ---- fixtures (real Codex JSONL shapes, shared with marginResourceRevision.test.js) ----
const USAGE = (n) => ({ input_tokens: n.input ?? 0, cached_input_tokens: n.cached ?? 0, cache_write_input_tokens: n.cacheWrite ?? 0, output_tokens: n.output ?? 0, reasoning_output_tokens: n.reasoning ?? 0, total_tokens: n.total ?? (n.input ?? 0) + (n.output ?? 0) });
function sessionMeta(sessionId) {
  return JSON.stringify({ timestamp: '2026-09-07T00:00:00.000Z', ordinal: 0, type: 'session_meta',
    payload: { session_id: sessionId, id: sessionId, cwd: 'D:\\w', thread_source: 'user', model_provider: 'openai', base_instructions: { text: `You are Codex, based on GPT-5.2.` } } });
}
function tokenUsage(sessionId, respId, ts, u, threadTotal) {
  return JSON.stringify({ timestamp: ts, type: 'token_usage_record', payload: { thread_id: `${sessionId}-th`, turn_id: `${sessionId}-turn`, session_id: sessionId, root_turn_id: 'R', response_id: respId, usage: USAGE(u), thread_token_usage: USAGE(threadTotal) } });
}
function tokenCount(sessionId, ts, totals, ratePct, secondary = 40) {
  return JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: USAGE(totals), last_token_usage: USAGE(totals), model_context_window: 258400 },
    rate_limits: { limit_id: 'codex', plan_type: 'plus', primary: { used_percent: ratePct, window_minutes: 300, resets_at: 1788611748 }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1789198548 }, credits: { has_credits: false, unlimited: false, balance: '0' } } } });
}
function turn(sessionId, respId, ts, perRequest, totals, ratePct) {
  return `${tokenUsage(sessionId, respId, ts, perRequest, totals)}\n${tokenCount(sessionId, ts, totals, ratePct)}\n`;
}
function codexRoot(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-s85c-codex-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function writeRollout(dir, name, content) { const full = path.join(dir, 'sessions', '2026', '09', '07', name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); return full; }

// ---- Pi fixtures ----
function piFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-s85c-pi-'));
  fs.mkdirSync(path.join(home, 'agent', 'sessions', 'one'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function line(value) { return `${JSON.stringify(value)}\n`; }
function assistant(timestamp, totalTokens) { return { type: 'message', timestamp: timestamp.toISOString(), message: { role: 'assistant', usage: { totalTokens } } }; }

function domSetup() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { dom, root: createRoot(dom.window.document.getElementById('root')) };
}

test('S8.5C Pi cache invalidates on provider-config change and on local calendar day rollover', (t) => {
  resetPiResourceCache();
  const home = piFixture(t);
  const day1 = new Date(2026, 8, 8, 10, 0, 0, 0);
  const day2 = new Date(2026, 8, 9, 10, 0, 0, 0);
  const file = path.join(home, 'agent', 'sessions', 'one', 'a.jsonl');
  fs.writeFileSync(file, line({ type: 'model_change', provider: 'YAPI' }) + line(assistant(day1, 77)));
  const first = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: day1.getTime() });
  assert.equal(first.totalTokens, 0, 'YAPI is unknown without config');
  assert.equal(first.excludedUnknownResponses, 1);

  // Session tree untouched, yet the provider config now classifies YAPI as API-only: recompute.
  fs.writeFileSync(path.join(home, 'agent', 'models.json'), JSON.stringify({ providers: { YAPI: { baseUrl: 'https://example.test', api: 'anthropic-messages' } } }));
  const afterConfig = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: day1.getTime() });
  assert.notStrictEqual(afterConfig, first, 'provider-config change invalidates the Pi cache');
  assert.equal(afterConfig.totalTokens, 77);
  assert.equal(afterConfig.excludedUnknownResponses, 0);

  // Same session tree + config but a new local calendar day: the Today total must recompute.
  const afterRollover = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: day2.getTime() });
  assert.notStrictEqual(afterRollover, afterConfig, 'day rollover invalidates the Today total');
  assert.equal(afterRollover.totalTokens, 0, 'the previous day no longer counts on day 2');

  // Unchanged session + config + day is a genuine cache hit (same reference).
  assert.strictEqual(collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: day2.getTime() }), afterRollover);
});

test('S8.5C Pi read failure keeps the last trusted total marked stale, retries, and recovers fresh', (t) => {
  resetPiResourceCache();
  const home = piFixture(t);
  const now = new Date(2026, 8, 8, 12, 0, 0, 0);
  const file = path.join(home, 'agent', 'sessions', 'one', 'a.jsonl');
  fs.writeFileSync(file, line({ type: 'model_change', provider: 'deepseek' }) + line(assistant(now, 150)));
  const fresh = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: now.getTime() });
  assert.equal(fresh.totalTokens, 150);
  assert.equal(fresh.stale, false);
  const freshAt = fresh.freshAt;

  const original = fs.readFileSync;
  let attempts = 0;
  fs.readFileSync = (target, ...args) => {
    if (String(target).endsWith('.jsonl')) { attempts += 1; throw Object.assign(new Error('read blocked'), { code: 'EIO' }); }
    return original(target, ...args);
  };
  t.after(() => { fs.readFileSync = original; });

  // A revision bump (a real new-response signal) forces a re-read which fails: stale LKG.
  const stale1 = collectPiResourceSnapshot({ source: { path: home }, revision: 'r2', now: now.getTime() });
  assert.equal(stale1.stale, true);
  assert.equal(stale1.readFailed, true);
  assert.equal(stale1.totalTokens, 150, 'last trusted total is retained');
  assert.equal(stale1.freshAt, freshAt, 'a failed read never advances freshAt');
  assert.notEqual(stale1.unavailable, true);

  const stale2 = collectPiResourceSnapshot({ source: { path: home }, revision: 'r3', now: now.getTime() });
  assert.equal(stale2.stale, true, 'a later revision retries the read and stays stale');
  assert.ok(attempts >= 2, 'every stale call re-attempts the read');

  fs.readFileSync = original;
  const recovered = collectPiResourceSnapshot({ source: { path: home }, revision: 'r3', now: now.getTime() });
  assert.equal(recovered.stale, false, 'recovery restores fresh automatically on the same revision');
  assert.equal(recovered.totalTokens, 150);
  assert.ok(recovered.freshAt, 'a successful read again supplies freshAt');
});

test('S8.5C unchanged Pi identity revalidates after max-age and observes a content-level read failure', (t) => {
  resetPiResourceCache();
  const home = piFixture(t);
  const now = new Date(2026, 8, 8, 12, 0, 0, 0);
  const file = path.join(home, 'agent', 'sessions', 'one', 'a.jsonl');
  fs.writeFileSync(file, line({ type: 'model_change', provider: 'deepseek' }) + line(assistant(now, 150)));
  const fresh = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: now.getTime() });
  assert.equal(fresh.stale, false);

  const original = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (String(target).endsWith('.jsonl')) throw Object.assign(new Error('read blocked'), { code: 'EIO' });
    return original(target, ...args);
  };
  t.after(() => { fs.readFileSync = original; });

  // Same revision/day/config: still within the re-validation window, the cache serves the last
  // value (never an erroneous empty); the bar keeps showing a trustworthy number.
  const cached = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: now.getTime() });
  assert.strictEqual(cached, fresh, 'young unchanged identity is a cache hit');
  assert.equal(cached.stale, false);
  assert.equal(cached.totalTokens, 150);

  // Identity unchanged but past max-age: the read is re-attempted, the failure is observed, and
  // the last trusted total is served marked stale.
  const aged = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: now.getTime() + 61000 });
  assert.equal(aged.stale, true, 'max-age revalidation observes the transient read failure');
  assert.equal(aged.totalTokens, 150, 'the trusted total stays visible, marked stale');
  assert.equal(aged.freshAt, fresh.freshAt, 'failed revalidation never advances freshAt');
});

test('S8.5C Pi read failure with no trusted history is honestly unavailable, never a fake zero', (t) => {
  resetPiResourceCache();
  const home = piFixture(t);
  const now = new Date(2026, 8, 8, 12, 0, 0, 0);
  fs.writeFileSync(path.join(home, 'agent', 'sessions', 'one', 'a.jsonl'), line({ type: 'model_change', provider: 'deepseek' }) + line(assistant(now, 150)));
  const original = fs.readFileSync;
  fs.readFileSync = () => { throw Object.assign(new Error('read blocked'), { code: 'EIO' }); };
  t.after(() => { fs.readFileSync = original; });
  const snapshot = collectPiResourceSnapshot({ source: { path: home }, revision: 'r1', now: now.getTime() });
  assert.equal(snapshot.unavailable, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.readFailed, true);
  assert.equal(snapshot.totalTokens, 0);
  assert.equal(snapshot.freshAt, null);
});

test('S8.5C codex reader: a failed read never advances freshAt nor commits the failed revision; LKG stays stale and the same revision retries', (t) => {
  const dir = codexRoot(t);
  writeRollout(dir, 'rollout-2026-09-07T10-00-00-USER1.jsonl', `${sessionMeta('USER1')}\n${turn('USER1', 'resp1', '2026-09-07T10:00:01.000Z', { input: 100, output: 20 }, { input: 100, output: 20, total: 120 }, 12)}`);
  let clock = Date.parse('2026-09-08T12:00:00.000Z');
  const reader = createCodexLiveResourceReader({ now: () => new Date(clock).toISOString() });
  const fresh = reader.snapshot({ codexHome: dir, revision: 'r1' });
  assert.equal(fresh.stale, false);
  assert.ok(fresh.freshAt);
  const freshAt = fresh.freshAt;

  const original = fs.readdirSync;
  fs.readdirSync = (target, ...args) => {
    if (String(target).endsWith('sessions')) throw Object.assign(new Error('read blocked'), { code: 'EACCES' });
    return original(target, ...args);
  };
  t.after(() => { fs.readdirSync = original; });

  const stale = reader.snapshot({ codexHome: dir, revision: 'r2' });
  assert.equal(stale.stale, true);
  assert.equal(stale.readFailed, true);
  assert.equal(stale.freshAt, freshAt, 'a failed read never advances freshAt');
  assert.ok(stale.quotaSnapshot, 'LKG quota is retained');
  assert.equal(stale.quotaSnapshot.rateLimits.primary.used_percent, 12);

  const staleAgain = reader.snapshot({ codexHome: dir, revision: 'r2' });
  assert.equal(staleAgain.stale, true, 'the same (failed) revision is retried, not served from cache');
  assert.equal(staleAgain.freshAt, freshAt, 'retry does not advance freshAt either');

  fs.readdirSync = original;
  clock += 1000;
  const recovered = reader.snapshot({ codexHome: dir, revision: 'r2' });
  assert.equal(recovered.stale, false, 'recovery restores fresh automatically');
  assert.ok(recovered.freshAt > freshAt, 'recovery advances freshAt for the first time since the failure');
  assert.equal(recovered.quotaSnapshot.rateLimits.primary.used_percent, 12);
});

test('S8.5C service: a failed read emits an ok/stale envelope with the LKG; recovery emits ok/fresh', (t) => {
  const dir = codexRoot(t);
  writeRollout(dir, 'rollout-2026-09-07T10-00-00-USER1.jsonl', `${sessionMeta('USER1')}\n${turn('USER1', 'resp1', '2026-09-07T10:00:01.000Z', { input: 100, output: 20 }, { input: 100, output: 20, total: 120 }, 12)}`);
  const reader = createCodexLiveResourceReader();
  const fresh = getAgentResourceStatus({ codexHome: dir, source: { path: dir }, revision: 'revX', reader });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.status, 'ok');
  const freshAt = fresh.agents.find((a) => a.agent === 'codex').freshAt;

  const original = fs.readdirSync;
  fs.readdirSync = (target, ...args) => {
    if (String(target).endsWith('sessions')) throw Object.assign(new Error('read blocked'), { code: 'EACCES' });
    return original(target, ...args);
  };
  t.after(() => { fs.readdirSync = original; });

  const stale = getAgentResourceStatus({ codexHome: dir, source: { path: dir }, revision: 'revY', reader });
  assert.equal(stale.ok, true);
  assert.equal(stale.status, 'stale');
  const codex = stale.agents.find((a) => a.agent === 'codex');
  assert.equal(codex.stale, true);
  assert.equal(codex.unavailable, undefined, 'LKG is still present, so the agent is not unavailable');
  assert.ok(codex.resources.length >= 1, 'quota windows remain visible under stale');
  assert.equal(codex.freshAt, freshAt, 'no freshAt advance on failure');
  assert.equal(stale.revision, 'revY');

  fs.readdirSync = original;
  const recovered = getAgentResourceStatus({ codexHome: dir, source: { path: dir }, revision: 'revY', reader });
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.agents.find((a) => a.agent === 'codex').stale, false);
});

// ---- real HTTP + real Resource Bar smoke: controlled read failure → stale LKG → recovery fresh ----
test('S8.5C smoke: a controlled Codex read failure never flashes the bar to an empty value and recovers fresh', async (t) => {
  const dir = codexRoot(t);
  writeRollout(dir, 'rollout-2026-09-07T10-00-00-USER1.jsonl', `${sessionMeta('USER1')}\n${turn('USER1', 'resp1', '2026-09-07T10:00:01.000Z', { input: 100, output: 20 }, { input: 100, output: 20, total: 120 }, 12)}`);
  let clock = Date.parse('2026-09-08T12:00:00.000Z');
  const reader = createCodexLiveResourceReader({ now: () => new Date(clock).toISOString() });
  const source = { id: 'codex', sourceId: 'codex', type: 'codex', path: dir, origin: 'manual', enabled: true };
  const app = createHandoffHttpAdapter({
    rootDir: dir,
    readRegistry: () => ({ version: 1, sources: [source] }),
    writeRegistry: (value) => value,
    getAgentResourceStatus: (options) => getAgentResourceStatus({ ...options, reader }),
  });
  const { server, origin } = await listen(app);
  t.after(() => { server.closeAllConnections?.(); server.close(); });

  const status = async () => (await (await fetch(`${origin}/api/resources/status`)).json());
  const codexOf = (body) => body.agents.find((a) => a.agent === 'codex');

  const fresh = await status();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.status, 'ok');
  assert.equal(codexOf(fresh).stale, false);
  assert.equal(codexOf(fresh).unavailable, undefined);
  assert.ok(codexOf(fresh).resources.length >= 1);
  const freshAt = codexOf(fresh).freshAt;

  // Real Bar: mount against the live server while it is fresh, then force the same failure while
  // it polls. The bar phase runs without the act() test flag so real fetch callbacks flush like a
  // browser; the server round-trips remain fully deterministic.
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  root.render(React.createElement(MarginApp, { api: createMarginApiClient({ baseUrl: origin }), pollMs: 40, refreshGapMs: 0 }));
  const bar = () => dom.window.document.querySelector('[data-agent="codex"]').textContent;
  await wait(250);
  assert.match(bar(), /Codex · 5h 88% · 7d 60%/, `bar shows the fresh truth (got ${bar()})`);
  assert.doesNotMatch(bar(), /stale/);

  // Controlled read failure: the ACTIVE sessions tree becomes unreadable (EACCES).
  const original = fs.readdirSync;
  fs.readdirSync = (target, ...args) => {
    if (String(target).endsWith('sessions')) throw Object.assign(new Error('read blocked'), { code: 'EACCES' });
    return original(target, ...args);
  };
  t.after(() => { fs.readdirSync = original; });

  const stale = await status();
  assert.equal(stale.ok, true);
  assert.equal(stale.status, 'stale');
  assert.equal(codexOf(stale).stale, true);
  assert.equal(codexOf(stale).unavailable, undefined, 'LKG keeps the agent present');
  assert.ok(codexOf(stale).resources.length >= 1, 'quota stays visible while stale');
  assert.equal(codexOf(stale).freshAt, freshAt, 'failed read never advances freshAt');

  // With the read still failing, the bar polls again and receives the stale LKG: value + marker.
  await wait(180);
  const during = bar();
  assert.match(during, /Codex · 5h 88% · 7d 60%/);
  assert.match(during, /stale/);
  assert.doesNotMatch(during, /Codex · —/, 'the bar never flashes to an erroneous empty value');

  // Recovery: the same revision is retried and comes back fresh automatically.
  fs.readdirSync = original;
  clock += 1000;
  const recovered = await status();
  assert.equal(recovered.status, 'ok');
  assert.equal(codexOf(recovered).stale, false);
  assert.ok(codexOf(recovered).freshAt > freshAt, 'recovery is the first freshAt advance since the failure');
  await wait(180);
  const after = bar();
  assert.match(after, /Codex · 5h 88% · 7d 60%/);
  assert.doesNotMatch(after, /stale/);
});

test('S8.5C Pi bar stays compact and can express partial coverage and stale truth', async (t) => {
  const { dom, root } = domSetup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => {
    root.render(React.createElement(UsageBar, { resourceStatus: { agents: [
      { agent: 'codex', label: 'Codex', unavailable: true },
      { agent: 'pi', label: 'Pi', quotaPrefix: 'Go', stale: true, resources: [{ resourceType: 'tokenUsage', accessMode: 'api', scope: 'today', totalTokens: 12345, trustedResponseCount: 9, coverage: { partial: true, excludedUnknownResponses: 3, excludedSubscriptionResponses: 2, readFailed: false }, provenance: null }] },
      { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true },
    ] }, expanded: false, settings: {}, alwaysOnTop: false, onToggle() {}, onPin() {}, onHide() {}, onQuit() {} }));
  });
  const text = dom.window.document.querySelector('[data-agent="pi"]').textContent;
  assert.match(text, /Pi · API 12k · partial · stale/, 'compact total with partial + stale markers');
});

test('S8.5C Pi bar hides the total when coverage makes only unknown responses exist', async (t) => {
  const { dom, root } = domSetup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => {
    root.render(React.createElement(UsageBar, { resourceStatus: { agents: [
      { agent: 'pi', label: 'Pi', quotaPrefix: 'Go', resources: [{ resourceType: 'tokenUsage', accessMode: 'api', scope: 'today', totalTokens: 0, trustedResponseCount: 0, coverage: { partial: true, excludedUnknownResponses: 4, excludedSubscriptionResponses: 0, readFailed: false }, provenance: null }] },
    ] }, expanded: false, settings: {}, alwaysOnTop: false, onToggle() {}, onPin() {}, onHide() {}, onQuit() {} }));
  });
  const text = dom.window.document.querySelector('[data-agent="pi"]').textContent;
  assert.match(text, /Pi · API — · partial/, 'no confirmed API total is shown as —, marked partial');
});
