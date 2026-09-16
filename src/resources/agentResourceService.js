import { readLatestCodexQuotaSnapshot } from './codexQuotaSource.js';
import { normalizeCodexQuotaSnapshot } from './normalizeAgentResource.js';
import { defaultCodexLiveResourceReader } from './codexLiveResource.js';

// Assemble the Agent Resource Bar DTO from provider-reported Codex telemetry.
//
// This module is the SOLE owner of LKG + stale/freshness semantics for the resource domain.
// Consumers (HTTP, UI) render the returned truth; they never re-derive LKG from prior responses
// and never silently keep an old value when a read reports unavailable-without-LKG.
//
// Two sources of truth are supported:
//   - LIVE (default): the incremental codexLiveResourceReader reads the ACTIVE sessions tree only,
//     keys a view to the S2 source `revision`, and returns the newest trusted quota snapshot (last-
//     known-good across archive/switch) plus the foreground user session's token usage. Token usage
//     and the 5h/7d quota are separate `codex.resources` (quota) vs `codex.token` (tokenUsage) and are
//     never added.
//   - Injected `readLatestSnapshot` (legacy tests / a caller that owns its own snapshot provider):
//     quota-only projection, preserved for compatibility with the pure-snapshot contract.
//
// The unified result envelope is:
//   { ok, status: 'ok' | 'stale' | 'unavailable', revision, agents: [...agent records] }
// where each agent record carries freshAt/stale/unavailable and its own resource records.

// Single derived truth for a merged resource response: stale wins, then any agent with data is ok,
// otherwise nothing trustworthy exists.
export function resourceStatusOf(agents) {
  const hasData = (agent) => agent.unavailable !== true && ((Array.isArray(agent.resources) && agent.resources.length > 0) || Boolean(agent.token));
  if (agents.some((agent) => agent.stale === true)) return 'stale';
  if (agents.some(hasData)) return 'ok';
  return 'unavailable';
}

export function getAgentResourceStatus({
  codexHome,
  source,
  revision,
  readLatestSnapshot = null,
  reader = defaultCodexLiveResourceReader,
  now = Date.now(),
} = {}) {
  const home = source?.path || codexHome || null;

  if (readLatestSnapshot) {
    const quotaResources = normalizeCodexQuotaSnapshot(readLatestSnapshot(home), { now });
    // collected revision is mapped to the returned snapshot, never mutated
    const agents = [
      codexAgent(home, quotaResources, null, revision, null, false, quotaResources.length === 0),
      claudeAgent(revision),
    ];
    return { ok: true, status: resourceStatusOf(agents), revision: revision ?? null, agents };
  }

  if (!home) {
    const agents = [codexAgent(home, [], null, revision, null, false, true), claudeAgent(revision)];
    return { ok: true, status: resourceStatusOf(agents), revision: revision ?? null, agents };
  }

  const view = reader.snapshot({ codexHome: home, revision });
  // Normalize against the same observation clock as the live reader. This keeps provider reset
  // semantics consistent with injected/test clocks and with the read that produced the snapshot.
  const observedAt = view.observedAt ? Date.parse(view.observedAt) : NaN;
  const normalizationNow = Number.isFinite(observedAt) ? observedAt : now;
  const quotaResources = normalizeCodexQuotaSnapshot(view.quotaSnapshot, { now: normalizationNow });
  // A failed read returns the LKG marked stale, so view.stale is the LKG truth; a successful read
  // with nothing trustworthy (fresh home, no quota, no token) is genuinely unavailable.
  const unavailable = view.unavailable === true || (!quotaResources.length && !view.token);
  const viewRevision = view.revision ?? revision ?? null;
  const agents = [
    codexAgent(home, quotaResources, view.token, viewRevision, view.freshAt ?? null, Boolean(view.stale), unavailable),
    claudeAgent(revision),
  ];
  return { ok: true, status: resourceStatusOf(agents), revision: viewRevision, agents };
}

function codexAgent(home, quotaResources, token, revision, freshAt, stale, unavailable) {
  const base = {
    agent: 'codex', provider: 'openai',
    revision, freshAt, stale,
    resources: quotaResources,
  };
  if (token) base.token = token;
  if (unavailable) base.unavailable = true;
  return base;
}

function claudeAgent(revision) {
  return { agent: 'claude-code', revision, freshAt: null, stale: false, unavailable: true };
}
