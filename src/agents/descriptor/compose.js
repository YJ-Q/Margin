// Descriptor → adapter composition.
//
// This is the single place that turns a validated descriptor plus an optional built-in adapter into
// the ten-method adapter contract every host already consumes. Keeping it in one place is what makes
// "add an Agent" stop meaning "edit nine files": the hosts keep consuming the same contract, and the
// only new artefact is data.

import { createHash } from 'node:crypto';
import { resourceStatusOf } from '../../resources/agentResourceService.js';
import { computeTranscriptRevision, discoverTranscriptSessions, probeDescriptor } from './readers.js';

const BASE_CAPABILITIES = Object.freeze({
  sessions: true, handoff: false, apiUsage: false, quota: false, executionStatus: false, attentionStatus: false,
});

const noSnapshots = async () => [];
const noRevision = () => null;

// Identical to the collector used by the built-in adapters. It is deliberately duplicated in
// behaviour rather than imported so the descriptor layer has no dependency on the adapter module it
// is about to be composed into. `validateSource` is passed in (rather than held in module state) so
// composing one descriptor can never change how an already-composed one behaves.
const snapshotRead = (collect, validateSource) => async (source, options = {}) => {
  try {
    const validation = validateSource(source);
    if (!validation.valid) return { ok: false, error: { code: 'source_unavailable', message: validation.reason } };
    return { ok: true, snapshots: await collect(source, options) };
  } catch (error) {
    return { ok: false, error: { code: 'source_read_failed', message: error?.message ?? 'Unable to read agent source' } };
  }
};

export function createSnapshotCollector(descriptor, collect) {
  return async (source, options = {}) => {
    const sessions = await collect(source, options);
    return sessions.map((session) => asSnapshot({ ...session, agentType: descriptor.type }, descriptor, source));
  };
}

// Field-for-field the projection the built-in adapters used, so a descriptor-backed Agent produces
// the exact same session DTO a handwritten one does.
function asSnapshot(session, descriptor, source) {
  const sourceId = session.sourceId ?? source.sourceId ?? source.id;
  const nativeSessionId = session.nativeSessionId ?? session.id;
  return {
    ...session,
    id: nativeSessionId,
    agentType: descriptor.type,
    sourceId,
    nativeSessionId,
    canonicalId: `${descriptor.type}:${sourceId}:${nativeSessionId}`,
    displayTitle: session.displayTitle ?? session.label ?? `Untitled session · ${String(nativeSessionId).slice(0, 8)}`,
    titleSource: session.titleSource ?? 'fallback-id',
    workspace: session.workspace ?? { key: session.workspaceKey ?? null, name: session.workspaceName ?? null },
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
    executionStatus: session.executionStatus ?? 'unknown',
    attentionStatus: session.attentionStatus ?? 'none',
    capabilities: { ...BASE_CAPABILITIES, ...descriptor.capabilities, ...descriptor.sessionCapabilities },
  };
}

function unavailableResourceEnvelope(descriptor, revision) {
  const agent = {
    agent: descriptor.resourceAgent,
    label: descriptor.label,
    ...(descriptor.quotaPrefix ? { quotaPrefix: descriptor.quotaPrefix } : {}),
    ...(descriptor.provider ? { provider: descriptor.provider } : {}),
    revision: revision ?? null,
    freshAt: null,
    stale: false,
    unavailable: true,
    resources: [],
  };
  return { ok: true, status: resourceStatusOf([agent]), revision: revision ?? null, agents: [agent] };
}

// Wiring check shared by composition and by the loader, so an unsatisfiable descriptor is reported
// once, in one place, instead of producing a half-wired adapter that looks healthy.
export function compositionProblems(descriptor, { hasBuiltinAdapter = false } = {}) {
  const problems = [];
  if (descriptor.sessions.kind === 'builtin' && !hasBuiltinAdapter) {
    problems.push(`sessions.kind builtin requires a built-in adapter for type "${descriptor.type}"`);
  }
  if (descriptor.resources.kind === 'builtin' && !hasBuiltinAdapter) {
    problems.push(`resources.kind builtin requires a built-in adapter for type "${descriptor.type}"`);
  }
  if (descriptor.handoff.kind !== 'none' && !hasBuiltinAdapter) {
    problems.push(`handoff.kind ${descriptor.handoff.kind} requires a built-in adapter for type "${descriptor.type}"`);
  }
  return problems;
}

export function composeAdapter(descriptor, {
  builtinAdapter = null,
  detect,
  validateSource,
  profile = null,
  env = process.env,
} = {}) {
  const problems = compositionProblems(descriptor, { hasBuiltinAdapter: Boolean(builtinAdapter) });
  if (problems.length) throw Object.assign(new TypeError(problems.join('; ')), { code: 'descriptor_adapter_missing' });
  if (typeof detect !== 'function' || typeof validateSource !== 'function') {
    throw Object.assign(new TypeError('composeAdapter requires detect and validateSource'), { code: 'invalid_descriptor_composition' });
  }

  const readerOptions = { profile, env };
  let collect;
  if (descriptor.sessions.kind === 'transcript') {
    collect = (source, options = {}) => discoverTranscriptSessions(descriptor, source, { ...readerOptions, ...options });
  } else if (descriptor.sessions.kind === 'builtin') {
    collect = (source, options = {}) => builtinAdapter.discoverSessions(source, options);
  } else {
    collect = noSnapshots;
  }

  const snapshots = descriptor.sessions.kind === 'none'
    ? noSnapshots
    : createSnapshotCollector(descriptor, collect);

  const getSessionRevision = descriptor.sessions.kind === 'transcript'
    ? (source, options = {}) => {
      const home = source?.path ?? null;
      if (!home) return null;
      const entries = computeTranscriptRevision(descriptor, source, { ...readerOptions, ...options });
      const context = JSON.stringify({ id: source.sourceId ?? source.id, type: descriptor.type, path: home, enabled: source.enabled });
      return createHash('sha256').update(`${context}\n${entries}`).digest('hex');
    }
    : descriptor.sessions.kind === 'builtin'
      ? (source, options = {}) => builtinAdapter.getSessionRevision(source, options)
      : noRevision;

  const collectResourceSnapshot = descriptor.resources.kind === 'builtin'
    ? (source, options = {}) => builtinAdapter.collectResourceSnapshot(source, options)
    : (source, options = {}) => unavailableResourceEnvelope(descriptor, options?.revision ?? null);

  const adapter = {
    agentType: descriptor.type,
    label: descriptor.label,
    provider: descriptor.provider,
    resourceAgent: descriptor.resourceAgent,
    supportLevel: descriptor.supportLevel,
    capabilities: descriptor.capabilities,
    sessionCapabilities: descriptor.sessionCapabilities,
    descriptor,
    detect,
    validateSource,
    discoverSessions: snapshots,
    collectSessionSnapshots: snapshots,
    readSessionSnapshots: snapshotRead(snapshots, validateSource),
    getSessionRevision,
    getResourceStatus: collectResourceSnapshot,
    collectResourceSnapshot,
    // `probe` is what turns "registered but returns nothing" into an actionable message.
    probe: (source, options = {}) => probeDescriptor(descriptor, source?.path ?? null, { ...readerOptions, ...options }),
  };

  // Handoff is the one capability with no declarative form: the shared Handoff Core consumes
  // Codex-shaped records and each Agent brings its own extraction layer. A descriptor can therefore
  // only ever reference a built-in implementation — never invent one.
  if (descriptor.handoff.kind === 'builtin') {
    if (typeof builtinAdapter?.captureSession !== 'function' || typeof builtinAdapter?.generateHandoff !== 'function') {
      throw Object.assign(new TypeError(`handoff.kind builtin requires captureSession and generateHandoff for type "${descriptor.type}"`), { code: 'descriptor_handoff_incomplete' });
    }
    adapter.captureSession = builtinAdapter.captureSession;
    adapter.generateHandoff = builtinAdapter.generateHandoff;
  } else if (descriptor.handoff.kind === 'shared-codex') {
    // Codex delegates to the host-injected Codex capture/generate defaults. Marking that explicitly
    // is what lets the host refuse to hand a foreign Agent the Codex path by accident.
    adapter.usesDefaultCapture = true;
  }

  return Object.freeze(adapter);
}
