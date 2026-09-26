import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { groupSessions, SessionBoard, UsageBar } from '../web/src/margin/SessionBoard.js';
import { MarginApp } from '../web/src/margin/MarginApp.js';

const sessions = [
  { id: 'a', agent: 'Codex', capabilities: { handoff: true }, workspaceKey: 'git:one', workspaceName: 'one', cwd: 'D:\\one', label: 'A deliberately long session title that must remain one visual row', updatedAt: '2026-09-06T10:00:00Z', bytes: 4000 },
  { id: 'b', agent: 'Claude', workspaceKey: 'git:one', workspaceName: 'one', cwd: 'D:\\one', label: 'Second', updatedAt: '2026-09-06T09:00:00Z', bytes: 2000 },
  { id: 'c', agent: 'Codex', workspaceKey: 'git:two', workspaceName: 'two', cwd: 'D:\\two', label: 'Third', updatedAt: '2026-09-06T08:00:00Z', bytes: 1000 },
];

test('R3 board groups only by the selected mode and preserves source session order', () => {
  assert.deepEqual(groupSessions(sessions, 'Workspace').map((g) => [g.label, g.sessions.map((s) => s.id)]), [['one', ['a', 'b']], ['two', ['c']]]);
  assert.deepEqual(groupSessions(sessions, 'Agent').map((g) => [g.label, g.sessions.map((s) => s.id)]), [['Codex', ['a', 'c']], ['Claude', ['b']]]);
  assert.deepEqual(groupSessions(sessions, 'Sessions')[0].sessions.map((s) => s.id), ['a', 'b', 'c']);
});

test('R3.3 window controls keep content expansion first and Quit at the far right', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => root.render(React.createElement(UsageBar, { resourceStatus: { agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: 59, resetsAt: 1 }, { windowDurationMinutes: 10080, percentUsed: 51, resetsAt: 2 }] }, { agent: 'pi', label: 'Pi', quotaPrefix: 'Go', resources: [{ accessMode: 'api', scope: 'today', totalTokens: 126000, trustedResponseCount: 3 }] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] }, expanded: false, settings: {}, alwaysOnTop: false, onToggle() {}, onPin() {}, onHide() {}, onQuit() {} })));
  assert.deepEqual([...document.querySelectorAll('.margin-control-dock button')].map((button) => button.getAttribute('aria-label')), ['Expand sessions', 'Pin', 'Hide', 'Quit']);
  assert.equal(document.querySelectorAll('[data-agent="codex"]').length, 1);
  assert.match(document.querySelector('[data-agent="codex"]').textContent, /Codex · 5h 41% · 7d 49%/);
  assert.equal(document.querySelector('[data-agent="pi"]').textContent, 'Pi · API 126k');
  assert.match(document.querySelector('[data-agent="claude-code"]').textContent, /^Claude · —$/);
  assert.equal(document.body.textContent.includes('Today'), false);
  assert.equal(document.body.textContent.includes(' W'), false);
});

test('S7.1 Codex resource hover has no normal-state detail card', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => root.render(React.createElement(UsageBar, { resourceStatus: { agents: [{ agent: 'codex', label: 'Codex', freshAt: '2026-09-08T03:04:00.000Z', token: { model: 'GPT-5.2', totalTokens: 12345, cachedInputTokens: 9000, outputTokens: 345, reasoningTokens: 99, responseId: 'resp-secret' }, resources: [{ windowDurationMinutes: 300, remaining: 41, resetsAt: 1788611748, plan: 'plus' }, { windowDurationMinutes: 10080, remaining: 59, resetsAt: 1789198548 }] }] }, expanded: false, onToggle() {}, onPin() {}, onHide() {}, onQuit() {} })));
  assert.equal(document.querySelector('.margin-resource-details'), null);
  assert.doesNotMatch(document.body.textContent, /GPT-5\.2|Session usage|Total tokens|Quota|Updated|resp-secret/i);
});

test('resource bar refreshes its native snapshot when the Board expands', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let reads = 0;
  const api = { listSessions: async () => ({ ok: true, data: { sessions: [] } }), getResourceStatus: async () => ({ agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: ++reads, resetsAt: 1 }] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] }) };
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(MarginApp, { api })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { document.querySelector('.margin-usage-toggle').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(reads, 2);
  assert.match(document.querySelector('[data-agent="codex"]').textContent, /5h 98%/);
});

// S8.5C: the UI renders ONLY service-declared truth. A failed read with an LKG is returned by the
// service as stale (value kept, marked); a declared unavailable-without-LKG renders — and is never
// silently replaced by a previously shown value.
test('resource bar renders service truth: stale LKG stays marked, true unavailable renders —', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let calls = 0;
  const api = { listSessions: async () => ({ ok: true, data: { sessions: [] } }), getResourceStatus: async () => {
    calls += 1;
    if (calls === 1) return { agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: 71, resetsAt: 1 }] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] };
    if (calls === 2) return { agents: [{ agent: 'codex', label: 'Codex', stale: true, resources: [{ windowDurationMinutes: 300, percentUsed: 71, resetsAt: 1 }] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] };
    return { agents: [{ agent: 'codex', label: 'Codex', unavailable: true, resources: [] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] };
  } };
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(MarginApp, { api })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(document.querySelector('[data-agent="codex"]').textContent, /Codex · 5h 29%/);
  // A failed read with an LKG comes back stale and stays visible + marked — never flickers to —.
  await act(async () => { window.dispatchEvent(new window.Event('focus')); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(document.querySelector('[data-agent="codex"]').textContent, /Codex · 5h 29% · stale/);
  assert.doesNotMatch(document.querySelector('[data-agent="codex"]').textContent, /Codex · —/);
  // A declared unavailable-without-LKG is rendered honestly (—), not hidden behind the old value.
  await act(async () => { window.dispatchEvent(new window.Event('focus')); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(document.querySelector('[data-agent="codex"]').textContent, /Codex · —/);
  assert.equal(calls, 3);
});

test('R3 board Copy and Save each use the exact Core handoff markdown', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator }); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let copied; let saved; const api = { generateHandoff: async () => ({ ok: true, data: { markdown: '# Core handoff' } }), saveToWorkspace: async ({ markdown }) => { saved = markdown; return { ok: true, data: { path: 'x' } }; } };
  globalThis.navigator.clipboard = { writeText: async (text) => { copied = text; } };
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => root.render(React.createElement(SessionBoard, { api, sessions: [sessions[0]], loading: false, error: null, onRetry() {} })));
  await act(async () => { document.querySelector('.margin-row-actions button').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { document.querySelectorAll('.margin-row-actions button')[1].click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(copied, '# Core handoff'); assert.equal(saved, '# Core handoff');
});

test('S8.2.2 Workspace rows use a persistent resizable Agent column', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem('margin.workspace.agent-column-width', '156');
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => root.render(React.createElement(SessionBoard, { api: {}, sessions: [sessions[0]], loading: false, error: null, onRetry() {} })));
  const board = document.querySelector('.margin-board');
  const row = document.querySelector('.margin-session-row');
  assert.equal(row.dataset.mode, 'workspace');
  assert.equal(board.style.getPropertyValue('--margin-workspace-agent-width'), '156px');
  assert.equal(document.querySelector('.margin-row-resize-handle').getAttribute('aria-label'), 'Resize Agent column');

  await act(async () => { document.querySelector('.margin-row-resize-handle').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); });
  assert.equal(board.style.getPropertyValue('--margin-workspace-agent-width'), '112px');
  assert.equal(window.localStorage.getItem('margin.workspace.agent-column-width'), '112');

  const handle = document.querySelector('.margin-row-resize-handle');
  await act(async () => {
    handle.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100 }));
    window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 400 }));
  });
  assert.equal(board.style.getPropertyValue('--margin-workspace-agent-width'), '220px');
  assert.equal(window.localStorage.getItem('margin.workspace.agent-column-width'), '220');
});

test('S8.4 Agent and Sessions rows share resize behavior without sharing widths', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem('margin.workspace.agent-column-width', '150');
  window.localStorage.setItem('margin.agent.workspace-column-width', '170');
  window.localStorage.setItem('margin.sessions.metadata-column-width', '190');
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => root.render(React.createElement(SessionBoard, { api: {}, sessions: [sessions[0]], loading: false, error: null, onRetry() {} })));
  const board = document.querySelector('.margin-board');
  const modeButton = (name) => [...document.querySelectorAll('.margin-board-modes button')].find((button) => button.textContent === name);
  const resize = async (start, end) => {
    await act(async () => {
      const handle = document.querySelector('.margin-row-resize-handle');
      handle.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: start }));
      window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: end }));
    });
  };

  await act(async () => modeButton('Agent').click());
  assert.equal(board.style.getPropertyValue('--margin-metadata-width'), '170px');
  assert.equal(document.querySelector('.margin-row-resize-handle').getAttribute('aria-label'), 'Resize Workspace column');
  await resize(100, 400);
  assert.equal(window.localStorage.getItem('margin.agent.workspace-column-width'), '220');
  assert.equal(window.localStorage.getItem('margin.workspace.agent-column-width'), '150');

  await act(async () => modeButton('Sessions').click());
  assert.equal(board.style.getPropertyValue('--margin-metadata-width'), '190px');
  assert.equal(document.querySelector('.margin-row-resize-handle').getAttribute('aria-label'), 'Resize Session metadata column');
  await act(async () => { document.querySelector('.margin-row-resize-handle').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); });
  assert.equal(window.localStorage.getItem('margin.sessions.metadata-column-width'), '128');
  assert.equal(window.localStorage.getItem('margin.agent.workspace-column-width'), '220');
});

test('R3 board treats timestamp-only discoveries as neutral historical sessions', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => root.render(React.createElement(SessionBoard, { api: {}, sessions: [sessions[0]], loading: false, error: null, onRetry() {} })));
  const dot = document.querySelector('.margin-status-dot');
  assert.ok(dot.classList.contains('is-neutral'));
  assert.ok(!dot.classList.contains('is-recent'));
  assert.match(dot.title, /no live runtime evidence/i);
});

test('S8.2.3 source revision renders unified execution and attention colors', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = { revision: 'R0' };
  const api = {
    listSessions: async () => ({ ok: true, data: { revision: state.revision, sessions: [{ id: 'old', agent: 'Codex', workspaceName: 'one', label: 'Old', updatedAt: state.revision === 'R0' ? '2026-09-08T03:00:00Z' : '2026-09-08T03:01:00Z', executionStatus: state.revision === 'R1' ? 'working' : state.revision === 'R3' ? 'error' : 'idle', attentionStatus: state.revision === 'R2' ? 'needs-input' : 'none' }] } }),
    getSessionsRevision: async () => ({ ok: true, data: { revision: state.revision } }),
    listAgentSources: async () => ({ ok: true, data: { sources: [{ type: 'codex' }] } }),
    getResourceStatus: async () => ({ agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: 5, resetsAt: 1 }] }] }),
  };
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(MarginApp, { api, pollMs: 20, refreshGapMs: 0 })); await wait(30); });
  await act(async () => { document.querySelector('.margin-usage-toggle').click(); await wait(50); });
  state.revision = 'R1';
  await act(async () => { await wait(100); });
  const dot = document.querySelector('.margin-status-dot');
  assert.ok(dot.classList.contains('is-working'));
  assert.match(dot.title, /agent is working/i);
  state.revision = 'R2';
  await act(async () => { await wait(100); });
  assert.ok(dot.classList.contains('is-attention'));
  state.revision = 'R3';
  await act(async () => { await wait(100); });
  assert.ok(dot.classList.contains('is-error'));
});

test('S9.3 status feedback is one fixed overlay and stays geometry-stable under rapid updates', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = { revision: 0, executionStatus: 'idle' };
  const api = {
    listSessions: async () => ({ ok: true, data: { revision: state.revision, sessions: [{ id: 'codex-1', agent: 'Codex', label: 'Live task', executionStatus: state.executionStatus, attentionStatus: 'none' }] } }),
    getSessionsRevision: async () => ({ ok: true, data: { revision: state.revision } }),
    listAgentSources: async () => ({ ok: true, data: { sources: [{ type: 'codex' }] } }),
    getResourceStatus: async () => ({ agents: [{ agent: 'codex', label: 'Codex', unavailable: true }] }),
  };
  const root = createRoot(document.getElementById('root')); t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(MarginApp, { api, pollMs: 5, refreshGapMs: 0 })); await wait(25); });
  await act(async () => { document.querySelector('.margin-usage-toggle').click(); await wait(25); });
  const board = document.querySelector('.margin-board');
  const scroll = document.querySelector('.margin-board-scroll'); scroll.scrollTop = 37;

  for (let index = 0; index < 50; index += 1) {
    state.executionStatus = ['working', 'idle', 'error', 'working'][index % 4];
    state.revision += 1;
    await act(async () => { await wait(7); });
  }
  assert.equal(document.querySelectorAll('[data-toast-region="session-status"]').length, 1);
  assert.equal(document.querySelector('.margin-board'), board, 'status feedback must not remount the Board');
  assert.equal(document.querySelector('.margin-board-scroll').scrollTop, 37, 'status feedback must not change scrollTop');
  assert.match(document.querySelector('[data-toast-region="session-status"]').textContent, /Status updated/);
  assert.match(fs.readFileSync(new URL('../web/src/margin/margin.css', import.meta.url), 'utf8'), /\.margin-toast\s*\{[^}]*position:\s*fixed/);

  await act(async () => { await wait(1900); });
  assert.equal(document.querySelector('[data-toast-region="session-status"]'), null, 'toast auto-dismisses');
  assert.equal(document.querySelector('.margin-board'), board, 'dismissal must not remount the Board');
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function liveApi(state) {
  return {
    listSessions: async () => { state.listCalls += 1; return { ok: true, data: { revision: state.revision, sessions: [] } }; },
    getSessionsRevision: async () => { state.revisionCalls += 1; return { ok: true, data: { revision: state.revision } }; },
    listAgentSources: async () => ({ ok: true, data: { sources: [] } }),
    getResourceStatus: async () => ({ agents: [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: 10, resetsAt: 1 }] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] }),
  };
}

// S2 live revision sync: unchanged revision never triggers an extra full discovery; a real
// change triggers exactly one quiet refresh; collapsing stops polling entirely.
test('S2 Board live-sync polls only when expanded and refreshes only on a revision change', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = { revision: 'R0', listCalls: 0, revisionCalls: 0 };
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(MarginApp, { api: liveApi(state), pollMs: 20, refreshGapMs: 60 })); await wait(30); });

  assert.equal(state.listCalls, 1, 'initial mount loads sessions once');
  assert.equal(state.revisionCalls, 0, 'collapsed Board does not poll the revision');

  // Expand: arm the live sync. Unchanged revision must not cause extra full discovery.
  await act(async () => { document.querySelector('.margin-usage-toggle').click(); await wait(120); });
  assert.ok(state.revisionCalls > 0, 'expanded Board polls the revision');
  const afterExpand = state.listCalls;
  assert.ok(afterExpand >= 2, 'expand performs an immediate quiet refresh');
  const settled = state.listCalls;
  await act(async () => { await wait(120); });
  assert.equal(state.listCalls, settled, 'unchanged revision never triggers an extra full discovery');

  // Native change: exactly one quiet full refresh follows.
  state.revision = 'R1';
  await act(async () => { await wait(200); });
  assert.equal(state.listCalls, settled + 1, 'a revision change triggers exactly one quiet refresh');
  const afterChange = state.listCalls;
  await act(async () => { await wait(160); });
  assert.equal(state.listCalls, afterChange, 'no spurious refreshes once settled on the new revision');

  // Collapse stops polling and no further source change is picked up while collapsed.
  await act(async () => { document.querySelector('.margin-usage-toggle').click(); await wait(60); });
  const revisionAtCollapse = state.revisionCalls;
  state.revision = 'R2';
  await act(async () => { await wait(160); });
  assert.equal(state.revisionCalls, revisionAtCollapse, 'collapsed Board stops revision polling');
  assert.equal(state.listCalls, afterChange, 'collapsed Board does not refresh');
});

// S2 live sync pauses when the window is hidden and refreshes immediately on return to visible.
test('S2 Board live-sync pauses while hidden and refreshes on return to visible', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://margin.test/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.Event = dom.window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = { revision: 'R0', listCalls: 0, revisionCalls: 0 };
  const root = createRoot(document.getElementById('root'));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  await act(async () => { root.render(React.createElement(MarginApp, { api: liveApi(state), pollMs: 20, refreshGapMs: 60 })); await wait(30); });
  await act(async () => { document.querySelector('.margin-usage-toggle').click(); await wait(80); });
  assert.ok(state.revisionCalls > 0, 'expanded visible Board polls the revision');

  // Hide the window: revision polling must stop (zero revision requests while hidden).
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  const atHide = state.revisionCalls; const listAtHide = state.listCalls;
  state.revision = 'R3';
  await act(async () => { await wait(160); });
  assert.equal(state.revisionCalls, atHide, 'hidden Board issues zero revision requests');
  assert.equal(state.listCalls, listAtHide, 'hidden Board does not refresh');

  // Return to visible: an immediate full refresh runs and polling resumes.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); await wait(80); });
  assert.ok(state.listCalls > listAtHide, 'return to visible triggers an immediate refresh');
  assert.ok(state.revisionCalls > atHide, 'visible Board resumes revision polling');
});
