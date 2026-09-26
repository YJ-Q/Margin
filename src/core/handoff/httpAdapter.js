import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverSessions as discoverSessionsCore, captureSession as captureSessionCore, computeSourceRevision as computeSourceRevisionCore } from './session-source.js';
import { generateHandoff as generateHandoffCore } from './index.js';
import { createHandoffArtifact } from './handoffArtifact.js';
import { saveHandoffArtifact } from './save.js';
import { createWorkspaceOverview as createWorkspaceOverviewCore } from './workspace-overview.js';
import { getAgentResourceStatus as getAgentResourceStatusCore, resourceStatusOf } from '../../resources/agentResourceService.js';
import { AGENT_TYPES, readAgentSourceRegistry, writeAgentSourceRegistry, detectAgentSources, registerAgentSource, removeAgentSource, enableAgentSource, resolveActiveSource, validateSource, descriptorProblems } from '../../agents/sourceRegistry.js';
import { adapterFor } from '../../agents/adapters.js';
import { descriptorFor } from '../../agents/descriptor/load.js';
import { installAgentDescriptor, uninstallAgentDescriptor } from '../../agents/agentInstall.js';
import { healthPayload } from '../../surfaceHealth.js';

const MAX_LIST_LIMIT = 20;

function ok(data) { return { ok: true, data }; }
function fail(code, message) { return { ok: false, error: { code, message } }; }

function clampLimit(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MAX_LIST_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIST_LIMIT);
}

// The display name is declared by the Agent's descriptor, so an Agent Margin does not ship can name
// itself. An unknown type falls back to its own raw type rather than borrowing another Agent's name.
function descriptorLabel(type, options = {}) {
  return descriptorFor(type, options)?.label ?? (typeof type === 'string' && type.trim() ? type : 'Unknown');
}

// Only pass through browser-safe fields derived by the discovery layer.
function sessionSummary(session, options = {}) {
  return {
    id: session.id,
    nativeSessionId: session.nativeSessionId ?? session.id,
    canonicalId: session.canonicalId,
    sourceId: session.sourceId ?? null,
    agentType: session.agentType ?? 'codex',
    agent: descriptorLabel(session.agentType ?? 'codex', options),
    cwd: session.cwd ?? null,
    workspace: session.workspace ?? { key: session.workspaceKey ?? null, name: session.workspaceName ?? null },
    workspaceKey: session.workspaceKey ?? null,
    workspaceName: session.workspaceName ?? null,
    branch: session.branch ?? null,
    summary: session.summary ?? null,
    label: session.label ?? null,
    displayTitle: session.displayTitle ?? session.label ?? null,
    titleSource: session.titleSource ?? null,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
    executionStatus: session.executionStatus ?? 'unknown',
    attentionStatus: session.attentionStatus ?? 'none',
    // Session ↔ Run bridge (ADR 003). Always present so the session shape is stable: `null` means
    // either this host has no Core wired, or the session is genuinely not bound to a Run. It is never
    // inferred from cwd, title, or recency.
    runId: session.runId ?? null,
    workstreamId: session.workstreamId ?? null,
    capabilities: session.capabilities ?? { sessions: true, handoff: false, executionStatus: false, attentionStatus: false },
  };
}

function isDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

// The resource-bar key and the provider are declared by the descriptor. Both used to be ternaries
// here, which is why a new Agent needed an edit in this file just to appear correctly in the bar.
function resourceAgentName(type, options = {}) {
  return descriptorFor(type, options)?.resourceAgent ?? type;
}

// Display metadata for one resource-bar agent, declared by its descriptor. Attached at this
// boundary so the resource readers stay free of presentation and the browser never has to guess a
// label from a resource key.
function resourceAgentMeta(type, options = {}) {
  const descriptor = descriptorFor(type, options);
  return {
    ...(descriptor ? { label: descriptor.label } : {}),
    ...(descriptor?.quotaPrefix ? { quotaPrefix: descriptor.quotaPrefix } : {}),
  };
}

function unavailableResourceAgent(type, revision, options = {}) {
  const provider = descriptorFor(type, options)?.provider ?? null;
  return { agent: resourceAgentName(type, options), ...resourceAgentMeta(type, options), ...(provider ? { provider } : {}), revision, freshAt: null, stale: false, unavailable: true, resources: [] };
}

// Runtime Context boundary (ADR 003).
//
// This adapter owns the *Runtime* context: facts that belong to external agents (their session files,
// their quotas, the source registry). Margin does not own that data, so it is read-only here and is
// deliberately NOT routed through the Workstream/Run/Memory Application Contract — ADR 002 forbids a
// Surface from obtaining Pi/Codex session objects in the first place, and wrapping them in Contract
// DTOs would need a file-backed repository that lies about ownership.
//
// The one thing that genuinely joins the two contexts is the Session ↔ Run bridge (ADR 003). It is
// supplied by the host as an injected reader rather than read here, so this boundary never reaches
// into the Core's database: a host that owns both wires `resolveRuns`, and one that does not reports
// no Run, which is the honest answer rather than a missing field.
export function createHandoffHttpAdapter({
  rootDir,
  staticDir,
  viteMiddleware,
  env = process.env,
  discoverSessions = discoverSessionsCore,
  captureSession = captureSessionCore,
  generateHandoff = generateHandoffCore,
  createWorkspaceOverview = createWorkspaceOverviewCore,
  getAgentResourceStatus = getAgentResourceStatusCore,
  computeSourceRevision = computeSourceRevisionCore,
  readRegistry = readAgentSourceRegistry,
  writeRegistry = writeAgentSourceRegistry,
  adapterResolver = adapterFor,
  resolveRuns = null,
} = {}) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('invalid_handoff_adapter_dependencies');
  const app = express();
  const hasInjectedCodexDiscovery = discoverSessions !== discoverSessionsCore;
  const hasInjectedDependencies = hasInjectedCodexDiscovery
    || readRegistry !== readAgentSourceRegistry
    || writeRegistry !== writeAgentSourceRegistry;
  // Keep every surface on the same Core discovery path. Passing the process
  // environment makes the user-profile resolution explicit instead of letting
  // a packaged Electron runtime accidentally select a different home.
  const registryOptions = { env };
  const registry = () => {
    const current = readRegistry(registryOptions);
    if (current?.ok === false) {
      const error = new Error(current.error?.message ?? 'Unable to read agent source registry');
      error.code = current.error?.code ?? 'registry_unreadable';
      throw error;
    }
    return current;
  };
  // Startup detection is convenience only: persisted manual sources keep priority and
  // remain untouched. Doing it at the shared HTTP boundary gives Electron the same
  // standard-source behavior as `margin agent detect`.
  if (!hasInjectedDependencies) {
    try {
      const detected = detectAgentSources(registry(), registryOptions);
      writeRegistry(detected.registry, registryOptions);
    } catch { /* Registry failure is fail-safe: never replace it with detected defaults. */ }
  }
  const activeCodex = () => resolveActiveSource(registry(), 'codex', registryOptions);

  // The bridge reader is optional by construction. A read failure degrades to "no Run shown" rather
  // than an error page, because a Board that cannot reach the Core is still a useful Board.
  const attachRunBindings = async (sessions) => {
    const unbound = sessions.map((session) => ({ ...session, runId: session.runId ?? null, workstreamId: session.workstreamId ?? null }));
    if (typeof resolveRuns !== 'function' || !sessions.length) return unbound;
    let bindings = [];
    try { bindings = (await resolveRuns(sessions.map((session) => session.canonicalId))) ?? []; }
    catch { return unbound; }
    const bySession = new Map(bindings.map((binding) => [binding.canonicalSessionId, binding]));
    return unbound.map((session) => {
      const binding = bySession.get(session.canonicalId) ?? null;
      return { ...session, runId: binding?.runId ?? null, workstreamId: binding?.workstreamId ?? null };
    });
  };
  // Every type Margin knows about: the descriptors it ships plus whatever is registered. Deriving
  // this from the registry is what lets an Agent that arrived as a descriptor be discovered, read,
  // and shown without any edit to this file.
  const knownTypes = () => {
    const current = registry();
    return [...new Set([...AGENT_TYPES, ...current.sources.map((item) => item.agentType)])];
  };
  // Reserved bar slots are the Agents whose resources Margin itself reads. A descriptor-backed Agent
  // with no resource reader must not claim a permanent chip on every machine, so it earns its slot by
  // being registered instead.
  const alwaysPresentResourceTypes = () => AGENT_TYPES.filter((type) => descriptorFor(type, registryOptions)?.resources?.kind === 'builtin');
  const enabledSources = () => knownTypes().map((type) => resolveActiveSource(registry(), type, registryOptions)).filter((source) => source?.enabled);
  // Each enabled source is isolated: a malformed or unreadable Claude/Pi home must never
  // hide Codex (or another agent) sessions. Manual-vs-detected precedence is resolved per type.
  // Kept per source rather than as one global list so one unavailable Agent cannot make a
  // successful empty read from another Agent delete its sessions.  It is intentionally an
  // in-memory LKG cache, not a session shadow store.
  const sourceLastKnownGood = new Map();
  const sourceReadStatus = new Map(); // { stale, unavailable, error }; diagnostic-only, never UI truth
  const injectedCodexSource = { id: 'injected-codex', sourceId: 'injected-codex', type: 'codex', agentType: 'codex', path: rootDir, enabled: true,
    capabilities: { sessions: true, handoff: true, apiUsage: true, quota: true, executionStatus: true, attentionStatus: false } };
  const discover = async (_unused, options = {}) => {
    const sources = hasInjectedCodexDiscovery
      ? [injectedCodexSource]
      : knownTypes().map((type) => resolveActiveSource(registry(), type, registryOptions)).filter(Boolean);
    let sourceReadFailed = false;
    let readableSources = 0;
    const settled = await Promise.all(sources.map(async (source) => {
      const adapter = adapterResolver(source.type, registryOptions);
      if (!source.enabled || !adapter) return [];
      // An adapter is an independent native-data source.  Preserve a thrown reader error as
      // that source's failure envelope, rather than allowing Promise.all to reject the entire
      // multi-agent snapshot.
      let result;
      try {
        result = adapter.readSessionSnapshots
          ? await adapter.readSessionSnapshots(source, { ...options, env, codexDiscoverSessions: discoverSessions, computeCodexRevision: computeSourceRevision })
          : { ok: true, snapshots: await adapter.collectSessionSnapshots(source, { ...options, env, codexDiscoverSessions: discoverSessions, computeCodexRevision: computeSourceRevision }) };
      } catch (error) {
        result = { ok: false, error };
      }
      if (result?.ok) {
        // A successful empty read is authoritative and therefore intentionally clears this
        // source's LKG.  Only an explicit failed result retains it.
        sourceLastKnownGood.set(source.id, result.snapshots ?? []);
        sourceReadStatus.set(source.id, { stale: false, unavailable: false, error: null });
        readableSources += 1;
        return result.snapshots ?? [];
      }
      sourceReadFailed = true;
      sourceReadStatus.set(source.id, { stale: true, unavailable: !sourceLastKnownGood.has(source.id), error: result?.error ?? null });
      if (sourceLastKnownGood.has(source.id)) return sourceLastKnownGood.get(source.id);
      // A first-read failure means this source is unavailable, not that another
      // agent's successful snapshot is untrustworthy.  Never invent an empty
      // archive truth for Claude: it is omitted until it has a real snapshot.
      return [];
    }));
    const snapshots = settled.flat().sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    // Keep the established array contract for non-Board Core callers, while preserving whether
    // this aggregate is a trustworthy snapshot.  The HTTP Board path consumes this marker and
    // retains its own LKG rather than committing a partial read as current truth.
    Object.defineProperty(snapshots, 'snapshotComplete', { value: readableSources > 0 });
    Object.defineProperty(snapshots, 'sourceReadFailed', { value: sourceReadFailed });
    return snapshots;
  };
  // S2 live-sync aggregates adapter-owned source revisions. A revision is only a cheap re-read
  // signal: adapters remain the sole owners of session facts and lifecycle semantics.
  const currentRevision = () => {
    const sources = hasInjectedCodexDiscovery ? [injectedCodexSource] : enabledSources();
    const signatures = sources.flatMap((source) => {
      const adapter = adapterResolver(source.type, registryOptions);
      try {
        if (!adapter?.getSessionRevision) throw new Error(`No revision reader for ${source.type}`);
        const revision = adapter.getSessionRevision(source, { computeCodexRevision: computeSourceRevision });
        if (!revision) throw new Error(`Unable to read revision for ${source.type}`);
        return [revision];
      } catch (error) {
        sourceReadStatus.set(source.id, { stale: true, unavailable: !sourceLastKnownGood.has(source.id), error });
        return [];
      }
    });
    return signatures.length ? createHash('sha256').update(signatures.sort().join('\n')).digest('hex') : null;
  };
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_request, response) => response.json(healthPayload({ surface: 'margin-board' })));

  // Resource status is a read-only, independent domain. Every resource adapter returns the same
  // unified envelope { ok, status, revision, agents } whose agents carry their own resource
  // records/freshAt/stale/unavailable — the service owns LKG semantics, so a source failure is
  // represented as stale/unavailable by the domain and never takes down the board. The S3 live
  // reader is keyed to the same S2 source `revision` so an unchanged revision never triggers a
  // resource re-read; the reader carries last-known-good quota across archive/switch and token
  // usage is kept separate. Provider-specific binding stays inside its adapter; this boundary
  // only folds adapter envelopes and supplies an unavailable record when a source is absent.
  app.get('/api/resources/status', async (_request, response) => {
    const source = activeCodex();
    let revision = null;
    try { revision = currentRevision(); } catch { /* advisory; a failed revision read is never fatal */ }
    const fallback = {
      ok: true, status: 'unavailable', revision,
      agents: alwaysPresentResourceTypes().map((type) => ({ ...unavailableResourceAgent(type, revision, registryOptions), ...(type === 'codex' ? { stale: true } : {}) })),
    };
    try {
      const codex = getAgentResourceStatus({ codexHome: source?.path, source, revision });
      const current = registry();
      const byAgent = new Map((codex?.agents ?? []).filter((agent) => agent.agent !== 'claude-code').map((agent) => [agent.agent, { ...agent, ...resourceAgentMeta('codex', registryOptions) }]));
      const agentName = (type) => resourceAgentName(type, registryOptions);

      // Codex is read above through the shared service. Every OTHER known type — built-in or
      // descriptor-backed — is read through its own adapter. This loop used to name Claude and Pi
      // literally, so a newly added Agent could be listed on the Board and still never have its
      // resources read: the half-wired state that produced no error and no data.
      const allResourceTypes = [...new Set([...alwaysPresentResourceTypes(), ...current.sources.map((item) => item.agentType)])];
      for (const type of allResourceTypes.filter((item) => item !== 'codex')) {
        const sourceForType = resolveActiveSource(current, type, registryOptions);
        const adapter = sourceForType ? adapterResolver(type, registryOptions) : null;
        let result = null;
        if (sourceForType?.enabled && adapter?.collectResourceSnapshot) {
          let sourceRevision = null;
          try { sourceRevision = adapter.getSessionRevision ? adapter.getSessionRevision(sourceForType) : null; } catch { /* advisory; never fatal */ }
          try {
            result = await adapter.collectResourceSnapshot(sourceForType, { revision: sourceRevision, env, now: Date.now() });
          } catch { /* one provider's resource failure must not affect other agents */ }
        }
        const agent = result?.agents?.find((item) => item.agent === agentName(type));
        byAgent.set(agentName(type), agent ? { ...agent, ...resourceAgentMeta(type, registryOptions) } : unavailableResourceAgent(type, revision, registryOptions));
      }

      // Keep a stable visual order and ensure every supported agent remains represented without
      // hardcoding a Claude-specific placeholder in the HTTP contract.
      const agents = allResourceTypes.map((type) => byAgent.get(agentName(type)) ?? unavailableResourceAgent(type, revision, registryOptions));
      response.json({ ok: true, status: resourceStatusOf(agents), revision: codex?.revision ?? revision ?? null, agents });
    }
    catch { response.json(fallback); }
  });

  app.get('/api/agent-sources', (_request, response) => {
    try {
      const current = registry();
      // `problems` is the difference between "the Board is empty" and "the descriptor for this Agent
      // is malformed, here is why". `adapter` says whether this type can actually be read right now,
      // which is what turns a registered-but-silent Agent into a visible, explainable state.
      response.json(ok({
        sources: current.sources.map((source) => ({
          ...source,
          validation: validateSource(source),
          adapter: Boolean(adapterResolver(source.type, registryOptions)),
          active: resolveActiveSource(current, source.type, registryOptions)?.id === source.id,
        })),
        problems: descriptorProblems(registryOptions),
      }));
    } catch (error) { response.status(503).json(fail(error.code ?? 'registry_unreadable', error.message)); }
  });

  app.post('/api/agent-sources/detect', (_request, response) => {
    try {
      const result = detectAgentSources(registry(), registryOptions);
      const saved = writeRegistry(result.registry, registryOptions);
      response.json(ok({ sources: saved.sources, detected: result.detected.map((source) => source.id) }));
    } catch (error) { response.status(503).json(fail(error.code ?? 'registry_unreadable', error.message)); }
  });

  app.post('/api/agent-sources', (request, response) => {
    try {
      let current = registry();
      if (typeof request.body?.replaceId === 'string') current = removeAgentSource(current, request.body.replaceId);
      const next = registerAgentSource(current, { type: request.body?.type, path: request.body?.path, name: request.body?.name, origin: 'manual' });
      const saved = writeRegistry(next, registryOptions);
      response.status(201).json(ok({ sources: saved.sources }));
    } catch (error) { response.status(error?.code === 'registry_unreadable' ? 503 : 400).json(fail(error?.code ?? 'invalid_source', error?.message ?? 'Invalid source')); }
  });

  // Removal is origin-agnostic: an Agent that cannot be removed is an Agent that cannot be tested.
  // The registry tombstones a source that detection would otherwise recreate, so removing survives a
  // restart. LKG is dropped with the source, or a re-added Agent would show its old reading.
  app.delete('/api/agent-sources/:id', (request, response) => {
    try {
      const current = registry();
      const source = current.sources.find((item) => item.id === request.params.id);
      if (!source) return response.status(404).json(fail('not_found', 'Source not found'));
      const next = writeRegistry(removeAgentSource(current, source.id, registryOptions), registryOptions);
      sourceLastKnownGood.delete(source.id);
      sourceReadStatus.delete(source.id);
      response.json(ok({ sources: next.sources, suppressed: next.sources.find((item) => item.id === source.id)?.suppressed === true }));
    } catch (error) { response.status(error?.code === 'registry_unreadable' ? 503 : 400).json(fail(error?.code ?? 'invalid_source', error?.message ?? 'Invalid source')); }
  });

  // The undo for a removal, so undoing a mis-click never means hand-editing agent-sources.json.
  app.post('/api/agent-sources/:id/enable', (request, response) => {
    try {
      const current = registry();
      if (!current.sources.some((item) => item.id === request.params.id)) return response.status(404).json(fail('not_found', 'Source not found'));
      const next = writeRegistry(enableAgentSource(current, request.params.id, registryOptions), registryOptions);
      response.json(ok({ sources: next.sources }));
    } catch (error) { response.status(error?.code === 'registry_unreadable' ? 503 : 400).json(fail(error?.code ?? 'invalid_source', error?.message ?? 'Invalid source')); }
  });

  // The surface an Agent drives to configure itself. Fetching the plugin is deliberately the Agent's
  // job: these routes only accept a descriptor and reverse it, so Margin never gains a
  // download-and-execute path. Both are idempotent and dry-runnable for a repeated test loop.
  app.post('/api/agents/install', (request, response) => {
    try {
      const report = installAgentDescriptor({
        descriptor: request.body?.descriptor,
        path: typeof request.body?.path === 'string' && request.body.path.trim() ? request.body.path : null,
        env,
        dryRun: request.body?.dryRun === true,
      });
      if (!report.ok) return response.status(400).json(fail(report.error.code, report.error.message ?? ((report.error.errors ?? []).join('; ') || report.error.code)));
      response.status(201).json(ok(report));
    } catch (error) { response.status(400).json(fail(error?.code ?? 'install_failed', error?.message ?? 'Install failed')); }
  });

  app.post('/api/agents/uninstall', (request, response) => {
    try {
      const report = uninstallAgentDescriptor({ type: request.body?.type, env, dryRun: request.body?.dryRun === true });
      if (!report.ok) return response.status(400).json(fail(report.error.code, report.error.message ?? report.error.code));
      response.json(ok(report));
    } catch (error) { response.status(400).json(fail(error?.code ?? 'uninstall_failed', error?.message ?? 'Uninstall failed')); }
  });

  app.get('/api/sessions', async (request, response) => {
    try {
      const workspaceKey = typeof request.query.workspaceKey === 'string' ? request.query.workspaceKey : null;
      const limit = clampLimit(request.query.limit);
      // The Board is its own scroll container, so its initial load remains a
      // complete resumable discovery result. An explicit API limit stays
      // bounded for callers that request one.
      // A revision is the basis of a snapshot, not a value observed after it.  If a native
      // writer changes the source during discovery, retry on the next 500 ms reconciliation
      // instead of publishing old session facts labelled with the new revision.
      const revisionBefore = currentRevision();
      const sessions = await discover(undefined, workspaceKey ? undefined : { ...(limit ? { limit } : {}) });
      const revisionAfter = currentRevision();
      if (!sessions.snapshotComplete) throw Object.assign(new Error('One or more agent sources could not be read'), { code: 'source_read_failed' });
      if (revisionBefore !== revisionAfter) throw Object.assign(new Error('Source changed during snapshot read'), { code: 'snapshot_changed_during_read' });
      const mapped = (workspaceKey ? sessions.filter((session) => session.workspaceKey === workspaceKey) : sessions).map((session) => sessionSummary(session, registryOptions));
      response.json(ok({ revision: revisionAfter, sessions: await attachRunBindings(mapped) }));
    } catch (error) {
      response.status(503).json(fail(error?.code ?? 'discovery_failed', error?.message ?? 'unknown_error'));
    }
  });

  // S2 live-sync: the cheap source revision alone. A failure never returns partial data — the
  // renderer treats a non-ok/missing revision as "keep the shown snapshot".
  app.get('/api/sessions/revision', (_request, response) => {
    try { response.json(ok({ revision: currentRevision() })); }
    catch (error) { response.status(503).json(fail('revision_unavailable', error?.message ?? 'Unable to read source revision')); }
  });

  app.get('/api/workspace-overview', async (request, response) => {
    const workspaceKey = typeof request.query.workspaceKey === 'string' ? request.query.workspaceKey : '';
    if (!workspaceKey.trim()) return response.status(400).json(fail('invalid_request', 'workspaceKey is required'));
    try {
      // Deliberately unbounded: /api/sessions is a global display list and may
      // be truncated, while this workspace-specific navigation must be exact.
      const sessions = await discover();
      const workspaceSessions = sessions.filter((session) => session.workspaceKey === workspaceKey);
      if (!workspaceSessions.length) return response.status(404).json(fail('not_found', 'Workspace not found'));
      const workspaceName = workspaceSessions[0].workspaceName ?? 'Unknown workspace';
      response.json(ok(createWorkspaceOverview({ workspaceKey, workspaceName, sessions: workspaceSessions })));
    } catch (error) {
      response.status(503).json(fail('workspace_overview_failed', error?.message ?? 'unknown_error'));
    }
  });

  app.post('/api/handoff/generate', async (request, response) => {
    const sessionId = request.body?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return response.status(400).json(fail('invalid_request', 'sessionId is required'));
    }
    try {
      const sessions = await discover();
      // The browser always sends the canonical identity. Do not fall back to a
      // native id, title, workspace, or recency: more than one source can have
      // the same native id and a canonical id must pinpoint its exact source.
      const meta = sessions.find((session) => session.canonicalId === sessionId);
      if (!meta) return response.status(404).json(fail('not_found', 'Session not found'));
      if (meta.capabilities?.handoff === false) return response.status(400).json(fail('unsupported_action', 'Handoff is not supported for this session'));
      const repo = typeof request.body?.repo === 'string' && request.body.repo.trim() ? request.body.repo : meta.cwd;
      if (!isDirectory(repo)) return response.status(400).json(fail('invalid_repo', 'Workspace path is not a directory'));
      // Each agent adapter owns its capture/generation path (Pi evidence extractor vs the shared
      // Codex one). Only an adapter that explicitly declares the shared Codex defaults may inherit
      // them: the previous `?? captureSession` handed Codex's capture path to any Agent that declared
      // handoff without implementing one, producing a plausible-looking handoff built from the wrong
      // Agent's transcript.
      const adapter = adapterResolver(meta.agentType, registryOptions);
      const sessionCapturer = adapter?.captureSession ?? (adapter?.usesDefaultCapture === true ? captureSession : null);
      const handoffGenerator = adapter?.generateHandoff ?? (adapter?.usesDefaultCapture === true ? generateHandoff : null);
      if (!sessionCapturer || !handoffGenerator) return response.status(400).json(fail('unsupported_action', 'Handoff is not supported for this session'));
      const artifact = createHandoffArtifact({ session: meta, canonicalId: sessionId, rootDir, workspace: repo, captureSession: sessionCapturer, generateHandoff: handoffGenerator });
      response.json(ok({ markdown: artifact.markdown, resumeSummary: artifact.resumeSummary, session: sessionSummary(meta, registryOptions) }));
    } catch (error) {
      response.status(500).json(fail('handoff_generation_failed', error?.message ?? 'unknown_error'));
    }
  });

  app.post('/api/handoff/save', (request, response) => {
    const { repo, markdown } = request.body ?? {};
    if (!isDirectory(repo)) return response.status(400).json(fail('invalid_repo', 'Workspace path is not a directory'));
    if (typeof markdown !== 'string' || !markdown.trim()) return response.status(400).json(fail('invalid_request', 'markdown is required'));
    try {
      const filePath = saveHandoffArtifact({ repo, markdown });
      response.json(ok({ path: filePath }));
    } catch (error) {
      response.status(500).json(fail('checkpoint_write_failed', error?.message ?? 'unknown_error'));
    }
  });

  if (typeof viteMiddleware === 'function') app.use(viteMiddleware);
  else if (staticDir) app.use(express.static(staticDir, { index: 'margin.html' }));

  app.use((_request, response) => response.status(404).json(fail('not_found', 'Not found')));

  return app;
}
