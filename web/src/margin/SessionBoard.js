import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconChevronUp, IconPin, IconMinus, IconX, IconGear } from './icons.js';
const MODES = ['Workspace', 'Agent', 'Sessions'];
const timestamp = (value) => { const time = new Date(value ?? 0).getTime(); return Number.isNaN(time) ? 0 : time; };
export function formatRelativeTime(iso, now = Date.now()) { if (!iso) return ''; const minutes = Math.max(0, Math.round((now - timestamp(iso)) / 60000)); if (minutes < 1) return 'now'; if (minutes < 60) return `${minutes}m`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`; }
export function groupSessions(sessions, mode) { if (mode === 'Sessions') return [{ key: 'sessions', label: null, sessions }]; const groups = new Map(); for (const session of sessions) { const key = mode === 'Workspace' ? session.workspaceKey ?? `cwd:${session.cwd ?? 'unknown'}` : session.agent ?? 'Unknown agent'; const label = mode === 'Workspace' ? session.workspaceName ?? 'Unknown workspace' : session.agent ?? 'Unknown agent'; const group = groups.get(key) ?? { key, label, sessions: [] }; group.sessions.push(session); groups.set(key, group); } return [...groups.values()]; }
async function copyToClipboard(markdown) { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(markdown); }
function status(executionStatus, attentionStatus) {
  if (executionStatus === 'error') return { className: 'is-error', title: 'Agent reported a native task error' };
  if (attentionStatus === 'needs-input' || attentionStatus === 'unread') return { className: 'is-attention', title: 'User attention required' };
  if (executionStatus === 'working') return { className: 'is-working', title: 'Agent is working' };
  // 'idle' is a real terminal state read from the Agent's own transcript (the last turn finished),
  // so it earns its own colour rather than sharing the grey 'no evidence' dot that 'unknown' gets.
  if (executionStatus === 'idle') return { className: 'is-idle', title: 'Agent finished its last turn' };
  return { className: 'is-neutral', title: 'No live runtime evidence' };
}
function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function quotaRemaining(resource) {
  if ('remaining' in resource) return resource.remaining;
  if (typeof resource.percentUsed === 'number') return Math.max(0, 100 - resource.percentUsed);
  return null;
}
function quotaStale(resource, remaining) { return remaining === null || resource.stale === true; }
// Token usage and 5h/7d quota are separate resources on the codex agent and are never added.
// Pure presentational constants derived from the record's own window budget.
const windowLabel = (minutes) => minutes === 300 ? '5h' : minutes === 10080 ? '7d' : minutes === 43200 ? 'M' : `${minutes}m`;
const isQuotaResource = (resource) => resource?.resourceType === 'quota'
  || (resource?.resourceType === undefined && resource?.windowDurationMinutes !== undefined);

// One agent's segment, derived entirely from the service record.
//
// There is deliberately no per-Agent branch here any more. The label, the subscription prefix and
// the resource list are all data supplied by the Agent's descriptor, so an Agent Margin has never
// heard of renders correctly the moment its adapter returns resources — which is what closes the
// onboarding loop: without this, a newly registered Agent could be reading its resources and still
// never appear.
function agentSegment(agent) {
  const label = typeof agent?.label === 'string' && agent.label.trim() ? agent.label : String(agent?.agent ?? 'Unknown');
  const resources = Array.isArray(agent?.resources) ? agent.resources : [];
  const quota = resources.filter(isQuotaResource);
  const apiUsage = resources.find((resource) => resource.accessMode === 'api' && resource.scope === 'today');
  // Subscription token counts stay telemetry-only: only an explicit API/metered projection with a
  // local-calendar total may claim the compact main-bar slot.
  const token = agent?.token && (agent.token.accessMode === 'api' || agent.token.accessMode === 'metered') ? agent.token : null;

  const windowParts = quota.map((resource) => {
    const remaining = quotaRemaining(resource);
    return `${windowLabel(resource.windowDurationMinutes)} ${remaining === null ? '—' : `${remaining}%`}${quotaStale(resource, remaining) ? ' · stale' : ''}`;
  });
  const windowStale = quota.some((resource) => quotaStale(resource, quotaRemaining(resource)));

  const parts = [];
  if (windowParts.length) parts.push(`${agent?.quotaPrefix ? `${agent.quotaPrefix} ` : ''}${windowParts.join(' · ')}`);
  if (apiUsage) {
    // The total is only ever the TRUSTED subset: unknown/unclassified providers are excluded and
    // flagged partial, so a partial aggregation is never shown as a complete-looking total.
    const total = apiUsage.trustedResponseCount ? (formatTokens(apiUsage.totalTokens) ?? '—') : '—';
    parts.push(`API ${total}${apiUsage.coverage?.partial ? ' · partial' : ''}`);
  }
  if (token) parts.push(`Today ${formatTokens(token.todayTotalTokens) ?? '—'} tok`);

  const unavailable = agent?.unavailable === true;
  const body = !unavailable && parts.length ? parts.join(' · ') : null;
  // A window that already reported stale is not marked stale a second time at agent level.
  return { label, text: body === null ? `${label} · —` : `${label} · ${body}`, stale: !unavailable && agent?.stale === true && !windowStale };
}

export function UsageBar({ resourceStatus, expanded, onToggle, alwaysOnTop, onPin, onHide, onQuit }) {
  const segments = (Array.isArray(resourceStatus?.agents) ? resourceStatus.agents : []).map((agent) => ({ agent, ...agentSegment(agent) }));
  // Overflow fade is driven by real scroll metrics, never a static mask: no overflow => no fade
  // on either side; left fade only once content is scrolled out to the left; right fade only while
  // more content remains off-screen to the right. Recomputed on scroll and on element resize.
  const viewportRef = useRef(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const updateFade = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    const overflow = scrollWidth > clientWidth;
    const next = {
      left: overflow && scrollLeft > 0,
      right: overflow && scrollLeft + clientWidth < scrollWidth - 1,
    };
    setFade((previous) => (previous.left === next.left && previous.right === next.right ? previous : next));
  }, []);
  useEffect(() => { updateFade(); }, [updateFade, segments.map((segment) => segment.text).join('|')]);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    el.addEventListener('scroll', updateFade, { passive: true });
    window.addEventListener('resize', updateFade);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateFade) : null;
    observer?.observe(el);
    return () => { el.removeEventListener('scroll', updateFade); window.removeEventListener('resize', updateFade); observer?.disconnect(); };
  }, [updateFade]);
  // Horizontal wheel: only when the bar actually overflows (`scrollWidth > clientWidth`) do we
  // take over the wheel and map the dominant vertical/trackpad delta to horizontal scroll, clamp
  // to the real edge, and let the existing scroll listener recompute the fades. With no overflow
  // the wheel is never intercepted: no preventDefault, no scroll change, no layout/height impact.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      const { clientWidth, scrollWidth } = el;
      if (scrollWidth <= clientWidth) return; // no overflow: never hijack the wheel
      event.preventDefault();
      let dx;
      if (event.deltaMode === 1) {            // DOM_DELTA_LINE (e.g. Firefox) ≈ 16 px / line
        dx = event.deltaY * 16;
      } else if (event.deltaMode === 2) {     // DOM_DELTA_PAGE
        dx = event.deltaY * clientWidth;
      } else {                                // pixels: dominant axis so wheel (deltaY) and trackpad (deltaX/Y) both work
        dx = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      }
      const max = scrollWidth - clientWidth;
      const next = Math.min(Math.max(el.scrollLeft + dx, 0), max); // clamp to real boundaries
      if (next !== el.scrollLeft) el.scrollLeft = next;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const mask = fade.left && fade.right ? 'linear-gradient(to right, transparent, #000 10px, #000 calc(100% - 24px), transparent)'
    : fade.left ? 'linear-gradient(to right, transparent, #000 10px)'
    : fade.right ? 'linear-gradient(to left, transparent, #000 24px)'
    : 'none';
  return createElement('header', { className: 'margin-usage-bar', 'data-window-drag-region': true },
    createElement('span', { ref: viewportRef, className: 'margin-usage-viewport', style: { maskImage: mask, WebkitMaskImage: mask } },
      segments.map((segment, index) => createElement('span', {
        key: `${segment.agent?.agent ?? segment.label}-${index}`,
        className: 'margin-usage-agent',
        'data-agent': segment.agent?.agent ?? segment.label,
      }, createElement('span', { className: 'margin-usage-agent-label' }, segment.text), segment.stale ? ' · ' : null, segment.stale ? createElement('span', { className: 'margin-usage-stale' }, 'stale') : null))),
    createElement('div', { className: 'margin-control-dock', 'data-window-drag-region': false },
      createElement('button', { type: 'button', className: 'margin-usage-toggle', onClick: onToggle, 'aria-expanded': expanded, 'aria-label': expanded ? 'Collapse sessions' : 'Expand sessions', title: expanded ? 'Collapse' : 'Expand' }, expanded ? createElement(IconChevronUp) : createElement(IconChevronDown)),
      createElement('button', { type: 'button', className: `margin-window-control ${alwaysOnTop ? 'is-active' : ''}`, onClick: onPin, title: 'Pin', 'aria-label': 'Pin', 'aria-pressed': alwaysOnTop }, createElement(IconPin)),
      createElement('button', { type: 'button', className: 'margin-window-control', onClick: onHide, title: 'Hide', 'aria-label': 'Hide' }, createElement(IconMinus)),
      createElement('button', { type: 'button', className: 'margin-window-control is-quit', onClick: onQuit, title: 'Quit', 'aria-label': 'Quit' }, createElement(IconX))));
}

export function SessionBoard({ api, sessions, loading, error, onRetry, sources, problems, onSourcesChanged, settings, onSettingsChange, onToast, alwaysOnTop, onPin }) {
  const [mode, setMode] = useState('Workspace'); const [showSettings, setShowSettings] = useState(false); const [actionState, setActionState] = useState({}); const [columnWidths, setColumnWidths] = useState(readColumnWidths); const groups = groupSessions(sessions, mode);
  useEffect(() => { persistColumnWidths(columnWidths); }, [columnWidths]);
  async function handoff(session, action) { const actionKey = session.canonicalId ?? session.id; if (actionState[actionKey] === 'working') return; setActionState((state) => ({ ...state, [actionKey]: 'working' })); try { const generated = await api.generateHandoff({ sessionId: actionKey, repo: session.cwd }); if (!generated.ok) throw new Error(generated.error?.message ?? 'Handoff generation failed'); if (action === 'copy') { await copyToClipboard(generated.data.markdown); onToast?.('✓ Copied'); } else { const saved = await api.saveToWorkspace({ repo: generated.data.session?.cwd ?? session.cwd, markdown: generated.data.markdown }); if (!saved.ok || !saved.data?.path) throw new Error(saved.error?.message ?? 'Handoff write was not confirmed'); onToast?.(settings.saveConfirmation === 'compact' ? '✓ Saved' : `✓ Saved · ${saved.data.path}`); } setActionState((state) => ({ ...state, [actionKey]: action === 'copy' ? 'copied' : 'saved' })); } catch (failure) { setActionState((state) => ({ ...state, [actionKey]: 'error' })); onToast?.(`${action === 'copy' ? 'Copy' : 'Save'} failed · ${failure.message || 'Unknown error'}`, 'error'); } }
  const list = createElement('div', { className: 'margin-board-scroll' },
    groups.map((group) => createElement('section', { className: 'margin-session-group', key: group.key },
      group.label ? createElement('header', { className: 'margin-session-group-label' }, group.label) : null,
      group.sessions.map((session) => createElement(SessionRow, { key: session.canonicalId ?? session.id, session, mode, state: actionState[session.canonicalId ?? session.id], onHandoff: handoff, metadataWidth: columnWidths[mode], onMetadataWidthChange: (value) => setColumnWidths((widths) => ({ ...widths, [mode]: clampColumnWidth(mode, value) })) }))
    ))
  );
  const supported = !Array.isArray(sources) || sources.length > 0;
  const retry = error ? createElement('div', { className: 'margin-board-message margin-error', role: 'alert' }, error, ' ', createElement('button', { type: 'button', className: 'margin-btn', onClick: onRetry }, 'Retry')) : null;
  // A transient read failure is not an empty Board.  Keep rendered LKG rows in place and make
  // the existing small retry affordance available above them.
  const content = showSettings ? createElement(Settings, { api, sources, problems, onSourcesChanged, settings, onSettingsChange, alwaysOnTop, onPin }) : loading ? createElement('p', { className: 'margin-board-message' }, 'Loading sessions…') : error && sessions.length ? createElement('div', { className: 'margin-board-lkg' }, retry, list) : error ? retry : sessions.length ? list : !supported ? createElement(EmptySources, { api, onSourcesChanged }) : createElement('p', { className: 'margin-board-message' }, 'No supported sessions found on this machine.');
  return createElement('section', { className: 'margin-board', 'aria-label': 'Session Board', style: { '--margin-workspace-agent-width': `${columnWidths.Workspace}px`, '--margin-metadata-width': `${columnWidths[mode]}px` } }, createElement('div', { className: 'margin-board-modes', role: 'tablist', 'aria-label': 'Session grouping' }, MODES.map((item) => createElement('button', { type: 'button', role: 'tab', key: item, onClick: () => { setMode(item); setShowSettings(false); }, 'aria-selected': !showSettings && item === mode, className: !showSettings && item === mode ? 'is-selected' : '' }, item)), createElement('button', { type: 'button', className: `margin-settings-button ${showSettings ? 'is-selected' : ''}`, title: 'Settings', 'aria-label': 'Settings', onClick: () => setShowSettings((value) => !value) }, createElement(IconGear))), content);
}
function SourceActions({ api, onSourcesChanged, source }) { const add = async () => { const sourcePath = window.prompt(source ? 'New source path' : 'Agent source path'); if (!sourcePath) return; const type = source?.agentType ?? source?.type ?? window.prompt('Agent type', 'codex'); if (!type) return; const result = await api.addAgentSource({ type: type.toLowerCase(), path: sourcePath, replaceId: source?.sourceId ?? source?.id }); if (result.ok) onSourcesChanged?.(); }; return createElement('span', { className: 'margin-source-actions' }, source ? createElement('button', { type: 'button', className: 'margin-btn', onClick: add }, 'Change path') : createElement('button', { type: 'button', className: 'margin-btn', onClick: add }, 'Add Source')); }
function EmptySources({ api, onSourcesChanged }) { const detect = async () => { await api.detectAgentSources(); onSourcesChanged?.(); }; return createElement('div', { className: 'margin-board-message' }, createElement('p', null, 'No supported Agent sources found'), createElement('button', { type: 'button', className: 'margin-btn', onClick: detect }, 'Detect'), ' ', createElement(SourceActions, { api, onSourcesChanged })); }
// The Agent Sources panel. Every row now reports one of four explicit states and offers removal,
// because "registered but invisible" was previously unrepresentable here: an auto-detected Agent had
// no Remove button at all, and a registered Agent whose plugin was broken simply did not appear.
function Settings({ api, sources = [], problems = [], onSourcesChanged, settings, onSettingsChange, alwaysOnTop, onPin }) {
  const detect = async () => { await api.detectAgentSources(); onSourcesChanged?.(); };
  const remove = async (id) => { await api.removeAgentSource(id); onSourcesChanged?.(); };
  const enable = async (id) => { await api.enableAgentSource?.(id); onSourcesChanged?.(); };
  const stateOf = (source) => {
    if (source.suppressed) return 'removed';
    if (source.enabled === false) return 'disabled';
    if (source.adapter === false) return 'adapter required';
    return source.active ? 'active' : 'enabled';
  };
  return createElement('div', { className: 'margin-settings-panel' }, createElement('section', null, createElement('h2', null, 'Agent Sources'), createElement('button', { type: 'button', className: 'margin-btn', onClick: detect }, 'Auto Detect'), ' ', createElement(SourceActions, { api, onSourcesChanged }), sources.length ? createElement('ul', { className: 'margin-source-list' }, sources.map((source) => {
    const capabilities = Object.entries(source.capabilities ?? {}).filter(([, enabled]) => enabled).map(([name]) => name).join(', ') || 'unavailable';
    const id = source.sourceId ?? source.id;
    const removed = source.suppressed === true || source.enabled === false;
    return createElement('li', { key: id, 'data-source-state': stateOf(source) },
      createElement('span', null, `${source.name} · ${source.origin} · ${capabilities} · ${stateOf(source)}`),
      createElement('small', null, source.home ?? source.path),
      createElement('span', null, ' ',
        removed ? createElement('button', { type: 'button', className: 'margin-btn', onClick: () => enable(id) }, 'Enable') : createElement(SourceActions, { api, onSourcesChanged, source }),
        ' ',
        createElement('button', { type: 'button', className: 'margin-btn', onClick: () => remove(id) }, 'Remove')));
  })) : createElement('p', null, 'No sources registered.'), problems.length ? createElement('ul', { className: 'margin-source-list margin-source-problems' }, problems.map((problem, index) => createElement('li', { key: `${problem.type ?? 'unknown'}-${problem.code}-${index}` }, createElement('span', null, `${problem.type ?? 'unknown'} · ${problem.code}`), createElement('small', null, problem.errors.join('; '))))) : null), createElement('section', null, createElement('h2', null, 'Display'), createElement('label', null, createElement('input', { type: 'checkbox', checked: settings.showSummary, onChange: (event) => onSettingsChange({ showSummary: event.target.checked }) }), ' Show workspace/session summary')), createElement('section', null, createElement('h2', null, 'Window'), createElement('label', null, createElement('input', { type: 'checkbox', checked: Boolean(alwaysOnTop), onChange: onPin }), ' Always on top')), createElement('section', null, createElement('h2', null, 'Feedback'), createElement('label', null, 'Save confirmation ', createElement('select', { value: settings.saveConfirmation, onChange: (event) => onSettingsChange({ saveConfirmation: event.target.value }) }, createElement('option', { value: 'full' }, 'Full path'), createElement('option', { value: 'compact' }, 'Compact'))))); }
const COLUMN_LAYOUTS = Object.freeze({
  Workspace: Object.freeze({ key: 'margin.workspace.agent-column-width', defaultWidth: 112, label: 'Resize Agent column' }),
  Agent: Object.freeze({ key: 'margin.agent.workspace-column-width', defaultWidth: 112, label: 'Resize Workspace column' }),
  Sessions: Object.freeze({ key: 'margin.sessions.metadata-column-width', defaultWidth: 128, label: 'Resize Session metadata column' }),
});
const MIN_METADATA_WIDTH = 80;
const MAX_METADATA_WIDTH = 220;
function clampColumnWidth(mode, value) { const layout = COLUMN_LAYOUTS[mode] ?? COLUMN_LAYOUTS.Workspace; return Math.min(MAX_METADATA_WIDTH, Math.max(MIN_METADATA_WIDTH, Math.round(Number(value) || layout.defaultWidth))); }
function readColumnWidth(mode) { const layout = COLUMN_LAYOUTS[mode]; try { return clampColumnWidth(mode, window.localStorage.getItem(layout.key)); } catch { return layout.defaultWidth; } }
function readColumnWidths() { return Object.fromEntries(MODES.map((mode) => [mode, readColumnWidth(mode)])); }
function persistColumnWidths(widths) { for (const mode of MODES) { try { window.localStorage.setItem(COLUMN_LAYOUTS[mode].key, String(clampColumnWidth(mode, widths[mode]))); } catch {} } }

// One resize implementation is shared by every Board mode. The mode only supplies
// its independent width, storage key, default and accessible column label.
function MetadataResizeHandle({ mode, width, onWidthChange }) {
  const resizeStart = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent) => onWidthChange(startWidth + moveEvent.clientX - startX);
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };
  return createElement('span', { className: 'margin-row-resize-handle', role: 'separator', 'aria-label': COLUMN_LAYOUTS[mode].label, onPointerDown: resizeStart, onDoubleClick: () => onWidthChange(COLUMN_LAYOUTS[mode].defaultWidth), style: { '--margin-row-metadata-width': `${width}px` } });
}

function SessionRow({ session, mode, state, onHandoff, metadataWidth, onMetadataWidthChange }) {
  const title = session.displayTitle ?? session.label ?? session.summary ?? session.id;
  const context = mode === 'Agent' ? session.workspaceName ?? session.cwd ?? '' : mode === 'Sessions' ? [session.agent ?? 'Unknown', session.workspaceName ?? session.cwd ?? ''].filter(Boolean).join(' · ') : session.agent ?? 'Unknown';
  const dotStatus = status(session.executionStatus ?? 'unknown', session.attentionStatus ?? 'none');
  // Copy / Save only when the adapter explicitly declares handoff support. Missing or unknown
  // capability must default to unavailable — never shown by absence-optimistic logic.
  const handoffSupported = session.capabilities?.handoff === true;
  return createElement('div', { className: 'margin-session-row', 'data-session-id': session.canonicalId ?? session.id, 'data-mode': mode.toLowerCase() },
    createElement('span', { className: `margin-status-dot ${dotStatus.className}`, title: dotStatus.title }),
    createElement('span', { className: 'margin-row-context', title: context }, context),
    createElement(MetadataResizeHandle, { mode, width: metadataWidth, onWidthChange: onMetadataWidthChange }),
    createElement('span', { className: 'margin-row-title', title }, title),
    createElement('span', { className: 'margin-row-right-slot' }, createElement('span', { className: 'margin-row-time' }, formatRelativeTime(session.updatedAt)), handoffSupported ? createElement('span', { className: 'margin-row-actions' }, createElement('button', { type: 'button', disabled: state === 'working', onClick: () => onHandoff(session, 'copy') }, state === 'working' ? '…' : 'Copy'), createElement('button', { type: 'button', disabled: state === 'working', onClick: () => onHandoff(session, 'save') }, 'Save')) : null));
}
