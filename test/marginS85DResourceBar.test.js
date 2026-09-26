import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageBar } from '../web/src/margin/SessionBoard.js';
import { getAgentResourceStatus } from '../src/resources/agentResourceService.js';

function domSetup() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { dom, root: createRoot(dom.window.document.getElementById('root')) };
}
async function renderBar(t, resourceStatus) {
  const { dom, root } = domSetup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(UsageBar, { resourceStatus, expanded: false, settings: {}, alwaysOnTop: false, onToggle() {}, onPin() {}, onHide() {}, onQuit() {} })); });
  const viewport = dom.window.document.querySelector('.margin-usage-viewport');
  return { dom, viewport };
}
const wheel = (dom, overrides) => {
  const e = new dom.window.Event('wheel', { bubbles: true, cancelable: true });
  Object.assign(e, { deltaX: 0, deltaY: 0, deltaMode: 0 });
  Object.assign(e, overrides);
  return e;
};

test('S8.5D wheel is only taken over when the bar overflows', async (t) => {
  const { dom, viewport } = await renderBar(t, { agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: 40, resetsAt: 1 }] }] });
  // No overflow: the wheel is not hijacked — not prevented, no scroll.
  const noOverflow = wheel(dom, { deltaY: 200 });
  viewport.dispatchEvent(noOverflow);
  assert.equal(noOverflow.defaultPrevented, false, 'no overflow => wheel passes through');
  assert.equal(viewport.scrollLeft, 0, 'no overflow => no scroll');

  // Overflow: the wheel is taken over and the vertical delta maps to horizontal scroll.
  viewport.scrollLeft = 0;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => 400 });
  const overflow = wheel(dom, { deltaY: 120 });
  viewport.dispatchEvent(overflow);
  assert.equal(overflow.defaultPrevented, true, 'overflow => wheel is owned by the bar');
  assert.equal(viewport.scrollLeft, 120, 'vertical wheel delta scrolls the bar horizontally');
});

test('S8.5D wheel clamps to the real edges and supports the trackpad dominant axis', async (t) => {
  const { dom, viewport } = await renderBar(t, { agents: [] });
  viewport.scrollLeft = 0;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => 300 });

  // Positive scroll clamps at the right edge (max = 300 - 100 = 200).
  viewport.scrollLeft = 200;
  const right = wheel(dom, { deltaY: 500 });
  viewport.dispatchEvent(right);
  assert.equal(viewport.scrollLeft, 200, 'stops at the right edge');

  // Negative scroll clamps at the left edge.
  const left = wheel(dom, { deltaY: -900 });
  viewport.dispatchEvent(left);
  assert.equal(viewport.scrollLeft, 0, 'stops at the left edge');

  // Trackpad: the dominant deltaX axis drives horizontal scroll even with a small deltaY.
  const mid = wheel(dom, { deltaY: 0, deltaX: 40 });
  viewport.dispatchEvent(mid);
  assert.equal(viewport.scrollLeft, 40, 'trackpad horizontal delta scrolls');

  // A dominant deltaY (mouse wheel) maps the same way.
  viewport.scrollLeft = 0;
  const moose = wheel(dom, { deltaX: 2, deltaY: 70 });
  viewport.dispatchEvent(moose);
  assert.equal(viewport.scrollLeft, 70, 'dominant vertical delta maps to horizontal scroll');
});

test('S8.5D fades follow the real scroll position on the overflowed bar', async (t) => {
  const { dom, viewport } = await renderBar(t, { agents: [] });
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => 400 });
  const scrollTo = async (left) => { viewport.scrollLeft = left; await act(async () => { viewport.dispatchEvent(new dom.window.Event('scroll')); }); };

  // Left edge (not scrolled): only the right side fades.
  await scrollTo(0);
  assert.equal(viewport.style.maskImage, 'linear-gradient(to left, transparent, #000 24px)', 'left edge => right fade only');

  // Middle: both sides fade.
  await scrollTo(100);
  assert.equal(viewport.style.maskImage, 'linear-gradient(to right, transparent, #000 10px, #000 calc(100% - 24px), transparent)', 'middle => both edges fade');

  // Right edge: only the left side fades.
  await scrollTo(200);
  assert.equal(viewport.style.maskImage, 'linear-gradient(to right, transparent, #000 10px)', 'right edge => left fade only');
});

test('S8.5D no overflow => no fade at all', async (t) => {
  const { viewport } = await renderBar(t, { agents: [] });
  viewport.scrollLeft = 0;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => 400 });
  await act(async () => { viewport.dispatchEvent(new globalThis.Event('scroll')); });
  assert.equal(viewport.style.maskImage, 'none', 'no overflow => no fade');
});

test('S8.5D quota truth: fresh 0% / 25%, expired —, read-failure LKG value + stale', async (t) => {
  const { dom, viewport } = await renderBar(t, { agents: [{ agent: 'codex', label: 'Codex', resources: [
    { windowDurationMinutes: 300, remaining: 0 },
    { windowDurationMinutes: 10080, remaining: 25 },
  ] }] });
  void viewport;
  const text = dom.window.document.querySelector('[data-agent="codex"]').textContent;
  assert.match(text, /5h 0%/, 'fresh remaining=0 renders 0% (not a falsy "—")');
  assert.match(text, /7d 25%/, 'fresh remaining=25 renders 25%');

  const { dom: domExpired, viewport: vp2 } = await renderBar(t, { agents: [{ agent: 'codex', label: 'Codex', resources: [
    { windowDurationMinutes: 300, remaining: null, stale: true, resetsAt: 1 },
  ] }] });
  void vp2;
  const expired = domExpired.window.document.querySelector('[data-agent="codex"]').textContent;
  assert.match(expired, /5h —/, 'expired snapshot renders —, never a guessed 0');
  assert.doesNotMatch(expired, /0%/, 'expired does not render 0%');
  assert.match(expired, /stale/, 'expired window is honestly marked stale');
});

test('S8.5D read-failure LKG keeps the trusted value and stays stale', async (t) => {
  const { dom } = await renderBar(t, { agents: [{ agent: 'codex', label: 'Codex', stale: true, resources: [
    { windowDurationMinutes: 300, remaining: 25 },
  ] }] });
  const text = dom.window.document.querySelector('[data-agent="codex"]').textContent;
  assert.match(text, /5h 25% · stale/, 'read-failure LKG keeps the last trusted value + stale, never a fake 0');
  assert.doesNotMatch(text, /0%/, 'LKG is not rewritten to 0');
});

test('S8.5D every agent stays present when its resource is unavailable (no layout jump)', async (t) => {
  const { dom } = await renderBar(t, { agents: [
    { agent: 'codex', label: 'Codex', provider: 'openai', unavailable: true, resources: [] },
    { agent: 'pi', label: 'Pi', quotaPrefix: 'Go', provider: 'pi', unavailable: true, resources: [] },
    { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true },
  ] });
  const codex = dom.window.document.querySelector('[data-agent="codex"]').textContent;
  const pi = dom.window.document.querySelector('[data-agent="pi"]').textContent;
  const claude = dom.window.document.querySelector('[data-agent="claude-code"]').textContent;
  assert.match(codex, /Codex · —/);
  assert.match(pi, /Pi · —/);
  assert.match(claude, /Claude · —/);
});

test('S8.5D Pi Today stays compact while unavailable agents keep their placeholder', async (t) => {
  const { dom } = await renderBar(t, { agents: [
    { agent: 'article' },
    { agent: 'pi', label: 'Pi', quotaPrefix: 'Go', resources: [{ resourceType: 'tokenUsage', accessMode: 'api', scope: 'today', totalTokens: 8700, trustedResponseCount: 3, coverage: { partial: false, excludedUnknownResponses: 0, excludedSubscriptionResponses: 0, readFailed: false }, provenance: null }] },
    { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true },
  ] });
  const pi = dom.window.document.querySelector('[data-agent="pi"]').textContent;
  const claude = dom.window.document.querySelector('[data-agent="claude-code"]').textContent;
  assert.match(pi, /Pi · API 8\.7k/, 'Pi Today total renders compactly');
  assert.match(claude, /Claude · —/, 'Claude keeps its placeholder');
});

test('S8.5D service maps over-budget used_percent to 0 remaining (exhausted truth), not an empty window', () => {
  const now = Date.parse('2026-09-08T10:00:00.000Z');
  const status = getAgentResourceStatus({ readLatestSnapshot: () => ({
    timestamp: new Date('2026-09-08T10:00:00.000Z'),
    rateLimits: { primary: { used_percent: 100.4, window_minutes: 300, resets_at: 1788859983 }, secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1789446783 } },
  }), revision: 'r1', now });
  const windows = status.agents.find((a) => a.agent === 'codex').resources;
  assert.deepEqual(windows.map((w) => [w.windowDurationMinutes, w.percentUsed, w.remaining, w.stale]), [[300, 100, 0, false], [10080, 0, 100, false]], 'over-budget fresh snapshot => 0% remaining, not dropped');
});

test('S8.6B Pi one visual unit: Go 5h/7d/M remaining + API Today, stale window on failure', async (t) => {
  const { dom } = await renderBar(t, { agents: [{ agent: 'pi', label: 'Pi', quotaPrefix: 'Go', provider: 'pi', subscriptionQuota: true, resources: [
    { resourceType: 'quota', accessMode: 'subscription', window: '5h', windowDurationMinutes: 300, percentUsed: 14, remaining: 86, status: 'ok' },
    { resourceType: 'quota', accessMode: 'subscription', window: '7d', windowDurationMinutes: 10080, percentUsed: 7, remaining: 93, status: 'ok' },
    { resourceType: 'quota', accessMode: 'subscription', window: 'M', windowDurationMinutes: 43200, percentUsed: 3, remaining: 97, status: 'ok' },
    { resourceType: 'tokenUsage', accessMode: 'api', scope: 'today', totalTokens: 8_200_000, trustedResponseCount: 1, coverage: { partial: false, excludedSubscriptionResponses: 0, excludedUnknownResponses: 0, readFailed: false }, provenance: null },
  ] }] });
  const pi = dom.window.document.querySelector('[data-agent="pi"]').textContent;
  assert.match(pi, /Pi · Go 5h 86% · 7d 93% · M 97% · API 8\.2M/);

  // A window that rolled with no fresh refresh renders — · stale, never a guessed 0/100.
  const { dom: domExpired } = await renderBar(t, { agents: [{ agent: 'pi', label: 'Pi', quotaPrefix: 'Go', resources: [
    { resourceType: 'quota', accessMode: 'subscription', windowDurationMinutes: 300, remaining: null, stale: true, resetsAt: 1 },
  ] }] });
  const expired = domExpired.window.document.querySelector('[data-agent="pi"]').textContent;
  assert.match(expired, /5h —/);
  assert.doesNotMatch(expired, /0%/);
  assert.match(expired, /stale/);
});

test('S8.10A Claude Go quota is data-driven, preserves stale LKG, and renders fresh zero', async (t) => {
  const { dom } = await renderBar(t, { agents: [{ agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', provider: 'opencode-go', subscriptionQuota: true, resources: [
    { resourceType: 'quota', accessMode: 'subscription', window: '5h', windowDurationMinutes: 300, remaining: 75 },
    { resourceType: 'quota', accessMode: 'subscription', window: '7d', windowDurationMinutes: 10080, remaining: 89 },
    { resourceType: 'quota', accessMode: 'subscription', window: 'M', windowDurationMinutes: 43200, remaining: 95 },
  ] }] });
  assert.equal(dom.window.document.querySelector('[data-agent="claude-code"]').textContent, 'Claude · Go 5h 75% · 7d 89% · M 95%');

  const { dom: domStale } = await renderBar(t, { agents: [{ agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', provider: 'opencode-go', stale: true, resources: [
    { resourceType: 'quota', accessMode: 'subscription', windowDurationMinutes: 300, remaining: 75 },
  ] }] });
  assert.equal(domStale.window.document.querySelector('[data-agent="claude-code"]').textContent, 'Claude · Go 5h 75% · stale');

  const { dom: domZero } = await renderBar(t, { agents: [{ agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', provider: 'opencode-go', resources: [
    { resourceType: 'quota', accessMode: 'subscription', windowDurationMinutes: 300, remaining: 0 },
  ] }] });
  assert.equal(domZero.window.document.querySelector('[data-agent="claude-code"]').textContent, 'Claude · Go 5h 0%');
});
