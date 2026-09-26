import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMarginApiClient } from './marginApiClient.js';
import { SessionBoard, UsageBar } from './SessionBoard.js';

const SETTINGS_KEY = 'margin.r3.settings';
const DEFAULT_SETTINGS = { showSummary: false, saveConfirmation: 'full' };
function readSettings() { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return DEFAULT_SETTINGS; } }

export function MarginApp({ api: suppliedApi, pollMs = 500, refreshGapMs = 250 }) {
  const api = useMemo(() => suppliedApi ?? createMarginApiClient(), [suppliedApi]);
  const [listState, setListState] = useState({ loading: true, error: null, sessions: [] });
  const [sourceState, setSourceState] = useState({ loading: true, sources: [], problems: [] });
  const [resourceStatus, setResourceStatus] = useState({ agents: [{ agent: 'codex', label: 'Codex', unavailable: true }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', unavailable: true }] });
  const [expanded, setExpanded] = useState(false); const [settings, setSettings] = useState(readSettings); const [alwaysOnTop, setAlwaysOnTop] = useState(false); const [toast, setToast] = useState(null); const toastTimer = useRef();
  const previousExecutionStatuses = useRef(null);
  // `observedRevision` is only a dirty hint from the cheap endpoint.  It must never advance the
  // revision of the Board by itself: `committedRevision` moves solely with a successful snapshot
  // commit.  One request owns the UI at a time; callers during it get that real Promise and leave
  // exactly one trailing reconciliation behind.
  const observedRevision = useRef(null);
  const committedRevision = useRef(null);
  const sessionRequest = useRef(null);
  const sessionRequestGeneration = useRef(0);
  const trailingReconciliation = useRef(false);
  const resourceRequest = useRef(null);
  const mounted = useRef(true);
  const lastRefreshAt = useRef(0);
  const trailingTimer = useRef(null);
  const loadSessions = useCallback(({ quiet = false } = {}) => {
    if (sessionRequest.current) {
      trailingReconciliation.current = true;
      return sessionRequest.current;
    }
    if (!quiet) setListState((prev) => ({ ...prev, loading: true, error: null }));
    const generation = ++sessionRequestGeneration.current;
    const request = Promise.resolve().then(() => api.listSessions()).then((result) => {
      // A request can only be authoritative while it is the current generation.  This is
      // defensive as well as documenting the ordering guarantee if a future entry point changes
      // the guard: an old response may never overwrite a newer Board snapshot.
      if (!mounted.current || generation !== sessionRequestGeneration.current) return result;
      if (result?.ok && Array.isArray(result.data?.sessions)) {
        setListState({ loading: false, error: null, sessions: result.data.sessions });
        if (result.data.revision != null) committedRevision.current = result.data.revision;
      } else {
        // Retain the Last Known Good list on every failed read, including an initial/foreground
        // request.  A failed revision therefore remains eligible for the next poll to retry.
        setListState((prev) => ({ ...prev, loading: false, error: result?.error?.message ?? 'Failed to load sessions' }));
      }
      return result;
    }).catch(() => {
      if (mounted.current && generation === sessionRequestGeneration.current) setListState((prev) => ({ ...prev, loading: false, error: 'Failed to load sessions' }));
      return { ok: false, error: { message: 'Failed to load sessions' } };
    });
    sessionRequest.current = request;
    // The returned value is the actual network request lifecycle, including cleanup.  Do not
    // release the in-flight guard before it settles.
    return request.finally(() => {
      if (sessionRequest.current !== request) return;
      sessionRequest.current = null;
      if (trailingReconciliation.current && mounted.current) {
        trailingReconciliation.current = false;
        // A real source change arrived while the read was in flight.  Queue one reconciliation;
        // this is event-driven by a revision difference, not a busy-poll loop.
        setTimeout(() => { if (mounted.current) loadSessions({ quiet: true }); }, 0);
      }
    });
  }, [api]);
  // `problems` is descriptor-level diagnostics: a registered Agent whose plugin is malformed, or one
  // that names a reader Margin does not have. Without it, the Settings list can only show what
  // loaded, which is the half of the truth that never explains a missing Agent.
  const loadSources = useCallback(() => { api.listAgentSources?.().then((result) => { if (result.ok) setSourceState({ loading: false, sources: result.data.sources ?? [], problems: result.data.problems ?? [] }); }).catch(() => setSourceState({ loading: false, sources: [], problems: [] })); }, [api]);
  const showToast = useCallback((message, kind = 'success') => { clearTimeout(toastTimer.current); setToast({ message, kind }); toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 3500 : 1800); }, []);
  // Status changes are presentation-only feedback. Keep one previous snapshot after the
  // initial load, then replace the single overlay message when a session's execution truth
  // changes. This deliberately does not debounce, rewrite, or infer status values.
  useEffect(() => {
    if (listState.loading || listState.error || !Array.isArray(listState.sessions)) return;
    const next = new Map(listState.sessions.map((session) => [session.canonicalId ?? session.id, session.executionStatus ?? 'unknown']));
    if (previousExecutionStatuses.current) {
      const changed = listState.sessions.find((session) => {
        const id = session.canonicalId ?? session.id;
        return previousExecutionStatuses.current.has(id) && previousExecutionStatuses.current.get(id) !== next.get(id);
      });
      if (changed) showToast(`Status updated · ${changed.displayTitle ?? changed.label ?? changed.summary ?? changed.id}`);
    }
    previousExecutionStatuses.current = next;
  }, [listState.loading, listState.error, listState.sessions, showToast]);
  const updateSettings = useCallback((patch) => setSettings((previous) => { const next = { ...previous, ...patch }; try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {} return next; }), []);
  const togglePin = useCallback(async () => { const next = await globalThis.marginShell?.toggleAlwaysOnTop?.(); if (typeof next === 'boolean') setAlwaysOnTop(next); }, []);
  // Resource status refresh renders ONLY the service-declared truth: the resource domain owns
  // LKG + stale/freshness, so every well-formed response (fresh, stale LKG, or declared
  // unavailable-without-LKG) is committed verbatim. An unchanged revision/DTO is ignored so the
  // bar does not re-render on every poll tick; a transport failure leaves the shown snapshot in
  // place. The UI never filters, re-derives, or silently keeps an old value against a response.
  const loadResources = useCallback(() => {
    // Resource reads can include native provider work.  All entry points (mount,
    // focus, visibility, expand, and the regular poll) therefore share the one
    // real request until it settles.  Returning that Promise is essential: the
    // polling effect must not release its in-flight guard while a read is active.
    if (resourceRequest.current) return resourceRequest.current;
    let request;
    try { request = api.getResourceStatus?.(); } catch { return Promise.resolve(); }
    if (!request || typeof request.then !== 'function') return Promise.resolve();
    const current = Promise.resolve(request).then((result) => {
      if (!result || !Array.isArray(result.agents)) return;
      const next = { revision: result.revision ?? null, agents: result.agents };
      setResourceStatus((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    }).catch(() => { /* transient transport failure: keep the shown snapshot */ });
    resourceRequest.current = current;
    return current.finally(() => {
      if (resourceRequest.current === current) resourceRequest.current = null;
    });
  }, [api]);
  const toggleExpanded = useCallback(() => setExpanded((value) => { const next = !value; globalThis.marginShell?.setExpanded?.(next); if (next) { loadSessions({ quiet: true }); loadResources(); } return next; }), [loadResources, loadSessions]);
  useEffect(() => { loadSessions(); loadSources(); }, [loadSessions, loadSources]);
  useEffect(() => { loadResources(); }, [loadResources]);
  useEffect(() => { globalThis.marginShell?.getAlwaysOnTop?.().then((value) => { if (typeof value === 'boolean') setAlwaysOnTop(value); }); }, []);
  // Sessions reconcile on the 30 s interval and on focus only while expanded. Resources are handled
  // by the always-on, visibility-gated resource effect below (which updates even when collapsed).
  useEffect(() => { if (!expanded) return undefined; const onFocus = () => { loadSessions({ quiet: true }); }; window.addEventListener('focus', onFocus); const interval = setInterval(() => { loadSessions({ quiet: true }); }, 30000); return () => { window.removeEventListener('focus', onFocus); clearInterval(interval); }; }, [expanded, loadSessions]);
  // S2 near-real-time source sync. While the Board is visible and expanded, poll the cheap
  // `GET /api/sessions/revision` source signature every pollMs and run one quiet full refresh
  // only when it differs from the revision the shown snapshot was loaded with. Full discovery
  // stays the single source of truth — a revision difference merely says "re-read" and carries
  // no session data, so a deleted or archived session can never be resurrected by a poll. A
  // revision read failure never mutates the shown last-known-good snapshot. Burst Codex writes
  // are coalesced by a min-gap plus one trailing refresh. Polling stops when the Board is
  // collapsed (this effect unmounts) or the document is hidden; returning to visible refreshes.
  useEffect(() => {
    if (!expanded || !api?.getSessionsRevision) return undefined;
    let disposed = false;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const doRefresh = () => {
      lastRefreshAt.current = Date.now();
      loadSessions({ quiet: true });
    };
    const clearTrailing = () => { if (trailingTimer.current) { clearTimeout(trailingTimer.current); trailingTimer.current = null; } };
    const scheduleRefresh = () => {
      clearTrailing();
      const remaining = refreshGapMs - (Date.now() - lastRefreshAt.current);
      if (remaining > 0) {
        trailingTimer.current = setTimeout(() => { trailingTimer.current = null; if (!disposed && visible()) doRefresh(); }, remaining);
      } else doRefresh();
    };
    const pollOnce = () => {
      if (!visible()) return;
      let request; try { request = api.getSessionsRevision(); } catch { return; }
      if (!request || typeof request.then !== 'function') return;
      request.then((result) => {
        if (disposed || !visible()) return;
        if (!result?.ok || result.data == null || result.data.revision == null) return;
        const revision = result.data.revision;
        observedRevision.current = revision;
        // Do not mark this observed revision handled until a matching snapshot commits.  If the
        // read fails, committedRevision stays put and this same revision is retried next tick.
        if (revision === committedRevision.current) return;
        scheduleRefresh();
      }).catch(() => {});
    };
    const onVisible = () => { if (!disposed && visible()) doRefresh(); };
    document.addEventListener('visibilitychange', onVisible);
    pollOnce();
    const interval = setInterval(pollOnce, pollMs);
    return () => { disposed = true; clearInterval(interval); clearTrailing(); document.removeEventListener('visibilitychange', onVisible); };
  }, [expanded, api, pollMs, refreshGapMs, loadSessions]);
  // S3 resource live sync runs whenever the window is visible — expanded AND collapsed — and pauses
  // while hidden. It reuses the same S2 source revision as a dirty detector on the server (an
  // unchanged revision returns the cached DTO without a resource re-read); here it issues one
  // getResourceStatus per tick and only advances React state on a real change. Focus / return-to-
  // visible refresh immediately; mount/expand refresh are handled by their own loadResources calls.
  useEffect(() => {
    if (!api?.getResourceStatus) return undefined;
    let disposed = false;
    let inFlight = false;
    const visible = () => { const v = typeof document === 'undefined' ? 'visible' : document.visibilityState; return v !== 'hidden'; };
    const refresh = () => { if (inFlight) return; inFlight = true; Promise.resolve(loadResources()).finally(() => { inFlight = false; }); };
    const onVisible = () => { if (!disposed && visible()) refresh(); };
    const onFocus = () => { if (!disposed && visible()) refresh(); };
    const tick = () => { if (!disposed && visible()) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    const interval = setInterval(tick, pollMs);
    return () => { disposed = true; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onFocus); };
  }, [api, pollMs, loadResources]);
  useEffect(() => () => { mounted.current = false; clearTimeout(toastTimer.current); }, []);
  return createElement('main', { className: 'margin-shell' }, createElement(UsageBar, { resourceStatus, expanded, onToggle: toggleExpanded, settings, alwaysOnTop, onPin: togglePin, onHide: () => globalThis.marginShell?.hide?.(), onQuit: () => globalThis.marginShell?.quit?.() }), expanded ? createElement(SessionBoard, { api, sessions: listState.sessions, loading: listState.loading, error: listState.error, onRetry: loadSessions, sources: sourceState.sources, problems: sourceState.problems, onSourcesChanged: () => { loadSources(); loadSessions({ quiet: true }); loadResources(); }, settings, onSettingsChange: updateSettings, onToast: showToast, alwaysOnTop, onPin: togglePin }) : null, toast ? createElement('div', { className: `margin-toast ${toast.kind === 'error' ? 'is-error' : ''}`, role: 'status', 'aria-live': 'polite', 'data-toast-region': 'session-status', title: toast.message }, toast.message) : null);
}
