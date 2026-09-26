import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageBar } from '../web/src/margin/SessionBoard.js';
import { MarginApp } from '../web/src/margin/MarginApp.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function liveApi(counter) {
  return {
    listSessions: async () => { counter.list += 1; return { ok: true, data: { revision: 'R', sessions: [] } }; },
    listAgentSources: async () => ({ ok: true, data: { sources: [] } }),
    getResourceStatus: async () => { counter.resource += 1; return { revision: 'R', agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: counter.resource, resetsAt: 1 }], token: null }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] }; },
  };
}

function setup() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { dom, root: createRoot(dom.window.document.getElementById('root')) };
}

// S3: the Resource Bar keeps updating while the window is VISIBLE even when the Board is COLLAPSED.
test('S3 resource live sync polls while collapsed + visible and keeps updating', async (t) => {
  const { dom, root } = setup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  const counter = { resource: 0, list: 0 };
  await act(async () => { root.render(React.createElement(MarginApp, { api: liveApi(counter), pollMs: 20, refreshGapMs: 40 })); await wait(30); });
  assert.ok(counter.resource >= 1, 'mount performs an initial resource read');
  await act(async () => { await wait(180); });
  assert.ok(counter.resource > 1, `collapsed + visible Board polls resources (got ${counter.resource})`);
  const mid = counter.resource;
  await act(async () => { await wait(160); });
  assert.ok(counter.resource > mid, 'collapsed + visible Board keeps updating resources over time');
  const text = dom.window.document.querySelector('[data-agent="codex"]').textContent;
  assert.match(text, /Codex · 5h \d+%/, 'collapsed bar reflects the latest resource reading');
});

// S3: a hidden window performs ZERO resource polling; return-to-visible refreshes immediately.
test('S3 resource live sync pauses while hidden and refreshes on return to visible', async (t) => {
  const { dom, root } = setup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  const counter = { resource: 0, list: 0 };
  await act(async () => { root.render(React.createElement(MarginApp, { api: liveApi(counter), pollMs: 20, refreshGapMs: 40 })); await wait(20); });
  await act(async () => { await wait(160); });
  assert.ok(counter.resource > 1, 'visible Board polls resources');

  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await wait(40); });
  const atHide = counter.resource;
  await act(async () => { await wait(140); });
  assert.equal(counter.resource, atHide, 'hidden window issues zero resource requests');

  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); await wait(140); });
  assert.ok(counter.resource > atHide, 'return to visible refreshes immediately and resumes polling');
});

test('S9.2 focus bursts share one pending native resource read and resume after it settles', async (t) => {
  const { dom, root } = setup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const api = {
    listSessions: async () => ({ ok: true, data: { revision: 'R', sessions: [] } }),
    listAgentSources: async () => ({ ok: true, data: { sources: [] } }),
    getResourceStatus: () => {
      calls += 1;
      return pending;
    },
  };
  await act(async () => { root.render(React.createElement(MarginApp, { api, pollMs: 10000 })); await wait(0); });
  assert.equal(calls, 1, 'mount owns the first resource read');

  await act(async () => {
    for (let index = 0; index < 50; index += 1) window.dispatchEvent(new window.Event('focus'));
    await wait(0);
  });
  assert.equal(calls, 1, '50 focus events cannot spawn concurrent resource reads');

  release({ revision: 'R', agents: [{ agent: 'codex', label: 'Codex', resources: [] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] });
  await act(async () => { await wait(0); });
  await act(async () => { window.dispatchEvent(new window.Event('focus')); await wait(0); });
  assert.equal(calls, 2, 'the next focus refresh starts only after the first read settled');
});

// S7.4: telemetry remains in the resource DTO, but normal resource hover has no detail card.
test('S7.4 UsageBar keeps the primary resource bar and removes normal hover details', async (t) => {
  const { dom, root } = setup();
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => {
    root.render(React.createElement(UsageBar, { resourceStatus: { agents: [{ agent: 'codex', label: 'Codex', stale: true, freshAt: '2026-09-07T10:00:00.000Z', resources: [{ windowDurationMinutes: 300, percentUsed: 22, resetsAt: 1 }, { windowDurationMinutes: 10080, percentUsed: 71, resetsAt: 2 }], token: { resourceType: 'tokenUsage', totalTokens: 970872, inputTokens: 400, cachedInputTokens: 50, outputTokens: 30, reasoningTokens: 10, sessionId: 'U' } }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] }, expanded: false, settings: {}, alwaysOnTop: false, onToggle() {}, onPin() {}, onHide() {}, onQuit() {} }));
  });
  const text = dom.window.document.querySelector('[data-agent="codex"]').textContent;
  assert.match(text, /Codex · 5h 78% · 7d 29% · stale/);
  assert.doesNotMatch(text, /971k tok/);
  assert.equal(dom.window.document.querySelector('.margin-resource-details'), null);
  assert.doesNotMatch(dom.window.document.body.textContent, /Session usage|Total tokens|Updated|GPT-5/i);
});
