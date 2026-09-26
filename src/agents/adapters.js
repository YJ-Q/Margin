import os from 'node:os';
import { detectAgentSources, validateSource } from './sourceRegistry.js';
import { builtinDescriptors } from './descriptor/builtin.js';
import { descriptorFor } from './descriptor/load.js';
import { composeAdapter } from './descriptor/compose.js';
import { normalizeDescriptor, validateDescriptor } from './descriptor/spec.js';
import { discoverSessions as discoverCodexSessions, computeSourceRevision as computeCodexSourceRevision } from '../core/handoff/session-source.js';
import { discoverClaudeSessions, discoverPiSessions, computeExternalSessionRevision } from './externalSessionDiscovery.js';
import { collectPiResourceSnapshot } from '../resources/piApiUsage.js';
import { readGoQuotaResources } from '../resources/opencodeGoQuota.js';
import { readActiveClaudeOpenCodeGoBinding } from '../resources/claudeOpenCodeGoBinding.js';
import { resourceStatusOf } from '../resources/agentResourceService.js';
import { captureSession as captureSessionCore } from '../core/handoff/session-source.js';
import { generatePiHandoff } from './pi/piHandoff.js';
import { generateClaudeHandoff } from './claude/claudeHandoff.js';

// Composition root.
//
// The adapter objects hosts consume are no longer hand-wired per Agent. Each type is composed from
// its descriptor (identity, capabilities, wiring) plus an optional built-in reader module below. A
// descriptor-backed Agent that Margin does not ship therefore reaches the same contract without this
// file changing at all — which is the whole point of the onboarding interface.
//
// `adapters.js` is the only place that knows both sides (descriptors and reader implementations),
// which is why the readers live here rather than in the descriptor layer.

// Every agent uses this source-facing shape.  A false capability is represented
// by an intentionally empty stub, never by inferred session/resource data.

// ---- Built-in reader modules ---------------------------------------------------------------
// A reader module provides only what is genuinely Agent-specific: how to find sessions, how to
// compute a cheap change signal, how to read resources, and (when the Agent owns a handoff
// extractor) how to capture and generate one.

async function codexResourceStatus(source, options = {}) {
  const { getAgentResourceStatus } = await import('../resources/agentResourceService.js');
  return getAgentResourceStatus({ ...options, source });
}

async function piResourceStatus(source, options = {}) {
  const fallbackRevision = options.revision ?? null;
  if (!source?.path) {
    const agents = [piAgent(fallbackRevision, null, null, false, true)];
    return { ok: true, status: resourceStatusOf(agents), revision: fallbackRevision, agents };
  }
  const now = options.now;
  // Two independent readers under one Pi source: API Today (local JSONL aggregation) and the
  // OpenCode Go subscription quota (live structured endpoint). They are never added/converted.
  const apiSnapshot = collectPiResourceSnapshot({ source, revision: options.revision, now });
  const goQuota = await readGoQuotaResources({ home: source.path, now, fetchFn: options.fetchGoQuota ?? undefined });
  const agents = [piAgent(fallbackRevision, apiSnapshot, goQuota, false, false)];
  return { ok: true, status: resourceStatusOf(agents), revision: fallbackRevision, agents };
}

async function claudeResourceStatus(source, options = {}) {
  const fallbackRevision = options.revision ?? null;
  const unavailable = (stale = false) => ({
    agent: 'claude-code', revision: fallbackRevision,
    freshAt: null, stale, unavailable: true, resources: [],
  });
  if (!source?.path) {
    const agent = unavailable();
    return { ok: true, status: resourceStatusOf([agent]), revision: fallbackRevision, agents: [agent] };
  }

  let binding;
  try {
    const resolveProvider = options.resolveClaudeProvider ?? readActiveClaudeOpenCodeGoBinding;
    binding = await resolveProvider({ env: options.env ?? process.env, claudeHome: source.path, ccSwitchHome: options.ccSwitchHome });
  } catch {
    binding = null;
  }
  // A Claude source is allowed to use this reader only after CC Switch proves that the active
  // Claude route is OpenCode Go. In particular, never fall back to Pi's auth store here.
  if (!binding?.available || binding.providerType !== 'opencode_go' || typeof binding.credential !== 'string') {
    const agent = unavailable();
    return { ok: true, status: resourceStatusOf([agent]), revision: fallbackRevision, agents: [agent] };
  }

  let goQuota;
  try {
    goQuota = await readGoQuotaResources({
      home: source.path,
      credential: binding.credential,
      cacheKey: `claude:${source.sourceId ?? source.id ?? source.path}:${binding.configIdentity ?? 'binding'}`,
      agent: 'claude-code',
      provider: 'opencode-go',
      now: options.now ?? Date.now(),
      fetchFn: options.fetchGoQuota ?? undefined,
    });
  } catch {
    goQuota = { resources: [], available: false, stale: false };
  }
  const resources = goQuota?.resources ?? [];
  const hasQuota = goQuota?.available === true && resources.length > 0;
  const agent = {
    agent: 'claude-code', provider: 'opencode-go', revision: fallbackRevision,
    freshAt: goQuota?.freshAt ?? null, stale: goQuota?.stale === true, resources,
  };
  if (hasQuota) agent.subscriptionQuota = true;
  else agent.unavailable = true;
  return { ok: true, status: resourceStatusOf([agent]), revision: fallbackRevision, agents: [agent] };
}

// Unified Pi agent record merging PI Today API usage and, when a structured Go quota is available,
// the 5h/7d/M subscription remaining windows. Credential never appears in this record.
function piAgent(revision, apiSnapshot, goQuota, stale, unavailable) {
  const apiRecord = apiSnapshot ? {
    resourceType: 'tokenUsage', accessMode: 'api', scope: 'today',
    totalTokens: apiSnapshot.totalTokens ?? 0,
    trustedResponseCount: apiSnapshot.trustedApiResponses ?? 0,
    ...(apiSnapshot.coverage ? { coverage: apiSnapshot.coverage } : {}),
    provenance: apiSnapshot.provenance ?? null,
  } : null;
  const goRecords = goQuota?.resources ?? [];
  const resources = [apiRecord, ...goRecords].filter(Boolean);
  const unbornUnavailable = unavailable === true;
  const mergedUnavailable = resources.length === 0 && (Boolean(apiSnapshot?.unavailable) && goQuota?.available === false);
  const agent = {
    agent: 'pi', provider: 'pi',
    revision, freshAt: goQuota?.freshAt ?? apiSnapshot?.freshAt ?? null,
    stale: Boolean(apiSnapshot?.stale) || goQuota?.stale === true,
    resources,
  };
  // Data-driven capability: only present when the structured reader actually succeeded/held LKG.
  // Never claimed solely because the provider is named opencode-go.
  if (goQuota?.available === true) agent.subscriptionQuota = true;
  if (unbornUnavailable || mergedUnavailable) agent.unavailable = true;
  return agent;
}

const codexRevision = (source, options = {}) => (options.computeCodexRevision ?? computeCodexSourceRevision)({ codexHome: source.path, source });
const claudeRevision = (source, options = {}) => computeExternalSessionRevision(source, ['projects'], options);
const piRevision = (source) => computeExternalSessionRevision(source, ['agent', 'sessions']);

const builtinReaders = Object.freeze({
  codex: Object.freeze({
    // `codexDiscoverSessions` stays injectable: the existing host tests drive the Codex reader with
    // a fixture through exactly this seam.
    discoverSessions: (source, { codexDiscoverSessions = discoverCodexSessions, ...options } = {}) =>
      codexDiscoverSessions(source.path, { ...options, sourceId: source.sourceId ?? source.id, agentType: 'codex' }),
    getSessionRevision: codexRevision,
    collectResourceSnapshot: codexResourceStatus,
  }),
  claude: Object.freeze({
    discoverSessions: discoverClaudeSessions,
    getSessionRevision: claudeRevision,
    collectResourceSnapshot: claudeResourceStatus,
    captureSession: captureSessionCore,
    generateHandoff: generateClaudeHandoff,
  }),
  pi: Object.freeze({
    discoverSessions: discoverPiSessions,
    getSessionRevision: piRevision,
    collectResourceSnapshot: piResourceStatus,
    captureSession: captureSessionCore,
    generateHandoff: generatePiHandoff,
  }),
});

// A shipped descriptor that does not validate is a release-blocking bug, not a soft warning: it
// would silently remove one of Margin's own Agents. Failing at import makes that loud and cheap.
function composeBuiltinAdapters() {
  const adapters = {};
  for (const raw of builtinDescriptors) {
    const validation = validateDescriptor(raw);
    if (!validation.ok) {
      throw new Error(`Invalid built-in Agent descriptor "${raw?.type}": ${validation.errors.join('; ')}`);
    }
    adapters[raw.type] = composeAdapter(normalizeDescriptor(raw), {
      builtinAdapter: builtinReaders[raw.type] ?? null,
      detect: detectAgentSources,
      validateSource,
    });
  }
  return Object.freeze(adapters);
}

export const agentAdapters = composeBuiltinAdapters();

// A type with no built-in adapter is resolved from its descriptor on demand, so an Agent that ships
// its own descriptor needs no change here. `options` carries the profile/environment the caller is
// operating in; a descriptor's templates are expanded against it, never against import-time state.
export function adapterFor(type, options = {}) {
  if (agentAdapters[type]) return agentAdapters[type];
  const descriptor = descriptorFor(type, options);
  if (!descriptor) return null;
  const env = options.env ?? process.env;
  const profile = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  try {
    return composeAdapter(descriptor, { builtinAdapter: null, detect: detectAgentSources, validateSource, profile, env });
  } catch {
    // A descriptor that validated but cannot be composed is reported by loadDescriptors; here it
    // simply means "no usable adapter", which the caller renders as an adapter-required Agent.
    return null;
  }
}
