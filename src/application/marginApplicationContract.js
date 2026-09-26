import { CoreContractError } from '../core/contracts.js';
import { CONTRACT_VERSION } from '../contracts/contractTypes.js';
import {
  ContractValidationError,
  validateCommand,
  validateContractOutput,
  validateEventQuery,
  validateInvocationContext,
  validateQuery
} from '../contracts/validation.js';
import {
  toArtifactDTO,
  toCheckpointDTO,
  toDecisionDTO,
  toMemoryDTO,
  toNeedsOwnerDTO,
  toRunDTO,
  toSessionRunBindingDTO,
  toWorkstreamDTO
} from '../contracts/dtoMappers.js';
import { toActivityDTO, toEventEnvelope } from '../contracts/eventEnvelope.js';

const COMMAND_CAPABILITIES = Object.freeze({
  'workstream.create': 'workstream:write',
  'workstream.update': 'workstream:write',
  'run.create': 'run:control',
  'run.start': 'run:control',
  'run.pause': 'run:control',
  'run.resume': 'run:control',
  'run.stop': 'run:control',
  'checkpoint.create': 'checkpoint:write',
  'artifact.create': 'artifact:write',
  'needs_owner.create': 'needs_owner:write',
  'needs_owner.resolve': 'needs_owner:resolve',
  'workstream.switch': 'run:control',
  'memory.confirm': 'memory:confirm',
  'memory.correct': 'memory:correct',
  'memory.archive': 'memory:archive',
  'memory.restore': 'memory:restore',
  'run.bind_session': 'run:control'
});

const QUERY_CAPABILITIES = Object.freeze({
  'workstream.list': 'workstream:read',
  'workstream.get': 'workstream:read',
  'run.get': 'run:read',
  'run.list': 'run:read',
  'artifact.list': 'artifact:read',
  'decision.list': 'decision:read',
  'needs_owner.list': 'needs_owner:read',
  'activity.list': 'activity:read',
  'checkpoint.latest': 'checkpoint:read',
  'resume_brief.get': 'resume_brief:read',
  'memory.list': 'memory:read',
  'memory.search': 'memory:read',
  'session.resolve_runs': 'run:read'
});

const KNOWN_ERROR_CODES = new Set([
  'invalid_request', 'permission_denied', 'capability_required', 'not_found',
  'version_conflict', 'idempotency_conflict', 'invalid_transition', 'open_run_conflict',
  'runtime_unavailable', 'runtime_control_required', 'storage_failure', 'workstream_not_found',
  'run_not_found', 'open_run_exists', 'cross_workstream_reference', 'invalid_workstream_transition',
  // Session ↔ Run bridge (ADR 003). Without an entry here the code is downgraded to `storage_failure`,
  // which tells the caller nothing about what to do next.
  'session_already_bound'
]);

function requireCapability(context, capability, authorizeContext, requestType) {
  if (!context.capabilities.includes(capability)) throw new CoreContractError('capability_required', `Capability ${capability} is required`);
  if (authorizeContext && authorizeContext(context, capability, requestType) !== true) {
    throw new CoreContractError('permission_denied', 'Invocation context is not authorized');
  }
}

function mutationInput(command) {
  const input = { requestId: command.idempotencyKey, ...command.payload };
  if (command.expectedVersion !== undefined) input.expectedVersion = command.expectedVersion;
  return input;
}

function actorFor(context, toActor) {
  return toActor ? toActor(context) : {
    actorType: context.actor.type,
    subjectId: context.actor.subjectId,
    sourceSessionId: context.surface.instanceId ?? context.requestId,
    sourceEventId: context.requestId,
    correlationId: context.correlationId,
    surfaceKind: context.surface.kind
  };
}

function runtimeBoundary(runtimeControl) {
  if (!runtimeControl?.activate || !runtimeControl?.halt) return runtimeControl;
  return {
    async activate(run, descriptor) {
      try { return await runtimeControl.activate(run, descriptor); }
      catch { throw new CoreContractError('runtime_unavailable', 'Runtime activation is unavailable'); }
    },
    async halt(run, descriptor) {
      try { return await runtimeControl.halt(run, descriptor); }
      catch { throw new CoreContractError('runtime_unavailable', 'Runtime halt is unavailable'); }
    }
  };
}

function meta(context, auditId, stateVersion) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(auditId ? { auditId } : {}),
    ...(Number.isInteger(stateVersion) ? { stateVersion } : {})
  };
}

function success(data, context, result = {}) {
  return validateContractOutput({ ok: true, data, meta: meta(context, result.auditId, data?.version ?? data?.stateVersion) });
}

function safeIdentity(value) {
  return typeof value === 'string' && value.trim() && value.length <= 2_000 ? value : 'invalid';
}

function failure(error, rawContext = {}, rawRequest = {}) {
  const known = error instanceof CoreContractError || error instanceof ContractValidationError;
  const code = known && KNOWN_ERROR_CODES.has(error.code) ? error.code : 'storage_failure';
  // Structured detail only: the envelope never carries internal message text, so a code that needs
  // context (which Run owns this session, which version is current) must express it here.
  const details = code === 'version_conflict' && Number.isInteger(error.details?.actual)
    ? { currentVersion: error.details.actual }
    : (known && error.details && typeof error.details === 'object' ? error.details : undefined);
  const envelope = {
    ok: false,
    error: {
      code,
      retryable: ['storage_failure', 'runtime_unavailable'].includes(code),
      ...(details ? { details } : {})
    },
    meta: {
      contractVersion: CONTRACT_VERSION,
      requestId: safeIdentity(rawContext?.requestId ?? rawRequest?.requestId),
      correlationId: safeIdentity(rawContext?.correlationId)
    }
  };
  return validateContractOutput(envelope);
}

function notFound() { throw new CoreContractError('not_found', 'Requested resource was not found'); }

export function createMarginApplicationContract({ services, repository, runtimeControl, authorizeContext, toActor } = {}) {
  const runtime = runtimeBoundary(runtimeControl);

  const mapWorkstream = async (row, replayContext) => toWorkstreamDTO(row, replayContext === undefined ? {
    latestCheckpoint: await repository.latestCheckpointFor({ workstreamId: row.id }),
    activeRun: await repository.findOpenRun(row.id)
  } : replayContext);
  const mapRun = async (row, replayContext) => toRunDTO(row, replayContext === undefined
    ? { checkpoint: await repository.latestCheckpoint(row.id) }
    : replayContext);

  const commands = Object.freeze({
    'workstream.create': async (command, context, actor) => {
      const input = mutationInput(command);
      input.workspacePath = input.workspaceReference?.path;
      delete input.workspaceReference;
      return mappedAsync(await services.workstreams.create(input, actor), mapWorkstream);
    },
    'workstream.update': async (command, context, actor) => {
      const input = mutationInput(command);
      if (input.changes.workspaceReference !== undefined) {
        input.changes = { ...input.changes, workspacePath: input.changes.workspaceReference?.path ?? null };
        delete input.changes.workspaceReference;
      }
      return mappedAsync(await services.workstreams.update(input, actor), mapWorkstream);
    },
    'run.create': async (command, context, actor) => {
      const input = mutationInput(command);
      input.runtimeKind = input.workerKind;
      delete input.workerKind;
      return mappedAsync(await services.runs.create(input, actor), mapRun);
    },
    'run.start': (command, context, actor) => runControl('start', command, actor),
    'run.pause': (command, context, actor) => runControl('pause', command, actor),
    'run.resume': (command, context, actor) => runControl('resume', command, actor),
    'run.stop': (command, context, actor) => runControl('stop', command, actor),
    // Session ↔ Run bridge (ADR 003). Reuses the Run mapper, so the binding shows up in the same DTO
    // the caller already reads instead of introducing a parallel shape for one field.
    'run.bind_session': async (command, context, actor) => mappedAsync(await services.runs.bindSession(mutationInput(command), actor), mapRun),
    'checkpoint.create': async (command, context, actor) => mapped(await services.checkpoints.create(mutationInput(command), actor), toCheckpointDTO),
    'artifact.create': async (command, context, actor) => {
      const input = mutationInput(command);
      input.uri = input.resourceReference.uri;
      input.contentHash = input.resourceReference.contentHash;
      delete input.resourceReference;
      return mapped(await services.artifacts.create(input, actor), toArtifactDTO);
    },
    'needs_owner.create': async (command, context, actor) => mapped(await services.needsOwner.create(mutationInput(command), actor), toNeedsOwnerDTO),
    'needs_owner.resolve': async (command, context, actor) => mapped(await services.needsOwner.resolve(mutationInput(command), actor), toNeedsOwnerDTO),
    'memory.confirm': async (command, context, actor) => mapped(await services.memories.confirm({ ...mutationInput(command), expectedVersion: command.expectedVersion }, actor), toMemoryDTO),
    'memory.correct': async (command, context, actor) => mapped(await services.memories.correct({ ...mutationInput(command), expectedVersion: command.expectedVersion }, actor), toMemoryDTO),
    'memory.archive': async (command, context, actor) => mapped(await services.memories.archive({ ...mutationInput(command), expectedVersion: command.expectedVersion }, actor), toMemoryDTO),
    'memory.restore': async (command, context, actor) => mapped(await services.memories.restore({ ...mutationInput(command), expectedVersion: command.expectedVersion }, actor), toMemoryDTO),
    'workstream.switch': async (command, context, actor) => {
      const input = { ...mutationInput(command), expectedVersion: command.expectedVersion };
      const result = await services.workstreamSwitch.switch(input, actor, runtime);
      const sourceWorkstream = await mapWorkstream(await repository.getWorkstream(command.payload.sourceWorkstreamId).then((ws) => ws || notFound()));
      return { data: { sourceWorkstream, sourceRun: await mapRun(result.sourceRun), targetBrief: result.targetBrief, targetWorkstreamId: command.payload.targetWorkstreamId } };
    }
  });

  async function runControl(operation, command, actor) {
    return mappedAsync(await services.runs[operation](mutationInput(command), actor, runtime), mapRun);
  }

  const queries = Object.freeze({
    'workstream.list': async (request) => {
      const page = await services.workstreams.list(request.payload);
      return pageMap(page, mapWorkstream);
    },
    'workstream.get': async (request) => {
      const row = await services.workstreams.get(request.payload.workstreamId);
      if (!row) return notFound();
      return mapWorkstream(row);
    },
    'run.get': async (request) => {
      const row = await services.runs.get(request.payload.runId);
      if (!row) return notFound();
      return mapRun(row);
    },
    'run.list': async (request) => pageMap(await services.runs.list(request.payload), mapRun),
    'session.resolve_runs': async (request) => {
      const result = await services.runs.resolveSessions(request.payload);
      return { items: result.items.map(toSessionRunBindingDTO) };
    },
    'artifact.list': async (request) => pageMap(await services.artifacts.list(request.payload), toArtifactDTO),
    'decision.list': async (request) => {
      const input = { ...request.payload };
      if (input.statuses) input.statuses = input.statuses.map((status) => status === 'active' ? 'confirmed' : status);
      return pageMap(await repository.listDecisions(input), toDecisionDTO);
    },
    'needs_owner.list': async (request) => pageMap(await services.needsOwner.list(request.payload), toNeedsOwnerDTO),
    'activity.list': async (request) => activityPage(request.payload),
    'checkpoint.latest': async (request) => {
      const row = await services.checkpoints.latest(request.payload);
      return row ? toCheckpointDTO(row) : null;
    },
    'resume_brief.get': async (request) => {
      const { workstreamId } = request.payload;
      const ws = await repository.getWorkstream(workstreamId);
      if (!ws) return notFound();
      const openRun = await repository.findOpenRun(workstreamId);
      const checkpoint = openRun ? await repository.latestCheckpoint(openRun.id) : await repository.latestCheckpointFor({ workstreamId });
      const needsOwnerItems = await services.needsOwner.list({ workstreamId, statuses: ['open'], limit: 5 });
      const decisions = await repository.listDecisions({ workstreamId, statuses: ['confirmed'], limit: 10 });
      const memories = await repository.listMemories({ workstreamId, lifecycleStatuses: ['active'], limit: 10 });
      const recentEvents = await repository.listRecentEventRows(workstreamId, 20);
      const needsOwner = needsOwnerItems.items ?? [];
      let primaryAction;
      if (needsOwner[0]) { primaryAction = `Resolve: ${needsOwner[0].reason}`; }
      else if (ws.blockers?.length) { primaryAction = `Address blocker: ${ws.blockers[0]}`; }
      else if (ws.next_action) { primaryAction = ws.next_action; }
      else if (ws.current_plan?.length) { primaryAction = JSON.parse(typeof ws.current_plan === 'string' ? ws.current_plan : JSON.stringify(ws.current_plan))[0] ?? `Define the next action for ${ws.title}`; }
      else { primaryAction = `Define the next action for ${ws.title}`; }
      return {
        workstreamId,
        generatedAt: new Date().toISOString(),
        facts: {
          goal: ws.goal,
          currentState: ws.current_state ?? null,
          currentPlan: (() => { try { return JSON.parse(typeof ws.current_plan === 'string' ? ws.current_plan : JSON.stringify(ws.current_plan ?? [])); } catch { return []; } })(),
          nextAction: ws.next_action ?? null,
          blockers: (() => { try { return JSON.parse(typeof ws.blockers === 'string' ? ws.blockers : JSON.stringify(ws.blockers ?? [])); } catch { return []; } })()
        },
        run: openRun ? toRunDTO(openRun, { checkpoint }) : null,
        checkpoint: checkpoint ? toCheckpointDTO(checkpoint) : null,
        needsOwner: needsOwner.map(toNeedsOwnerDTO),
        decisions: decisions.items?.map(toDecisionDTO) ?? [],
        memories: memories.items ?? [],
        recentActivity: recentEvents.slice(0, 20).map((e) => ({ id: e.id, entityType: e.entity_type, eventType: e.event_type, createdAt: e.created_at })),
        recommendations: [{ id: `rec-${workstreamId}`, kind: 'primary', action: primaryAction, hypothesis: null, evidence: needsOwner[0] ? [{ aggregateType: 'needsOwner', aggregateId: needsOwner[0].id, aggregateVersion: needsOwner[0].version, reason: 'ownerDecisionRequired' }] : [{ aggregateType: 'workstream', aggregateId: workstreamId, reason: 'workstreamState' }] }],
        sourceVersions: [{ aggregateType: 'workstream', aggregateId: workstreamId, aggregateVersion: ws.version }]
      };
    },
    'memory.list': async (request) => {
      const result = await services.memories.list(request.payload);
      return { items: result.items.map(toMemoryDTO) };
    },
    'memory.search': async (request) => {
      const result = await services.memories.search(request.payload);
      return { items: result.items.map(toMemoryDTO) };
    }
  });

  async function dispatchMutation(rawCommand, rawContext) {
    try {
      const context = validateInvocationContext(rawContext);
      const command = validateCommand(rawCommand, context);
      requireCapability(context, COMMAND_CAPABILITIES[command.type], authorizeContext, command.type);
      const result = await commands[command.type](command, context, actorFor(context, toActor));
      return success(result.data, context, result);
    } catch (error) { return failure(error, rawContext, rawCommand); }
  }

  async function dispatchQuery(rawRequest, rawContext) {
    try {
      const context = validateInvocationContext(rawContext);
      const request = validateQuery(rawRequest, context);
      requireCapability(context, QUERY_CAPABILITIES[request.type], authorizeContext, request.type);
      return success(await queries[request.type](request), context);
    } catch (error) { return failure(error, rawContext, rawRequest); }
  }

  async function dispatchEvents(rawRequest, rawContext) {
    try {
      const context = validateInvocationContext(rawContext);
      const request = validateEventQuery(rawRequest, context);
      requireCapability(context, 'event:read', authorizeContext, request.type);
      return success(await eventPage(request.payload), context);
    } catch (error) { return failure(error, rawContext, rawRequest); }
  }

  async function eventPage(payload) {
    const page = await repository.listEventRows(payload);
    const mapped = page.items.map(toEventEnvelope);
    const items = mapped.filter((item) => item && (!payload.eventTypes || payload.eventTypes.includes(item.eventType)));
    return {
      items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      diagnostics: { skippedUnknownEvents: mapped.filter((item) => item === null).length }
    };
  }

  async function activityPage(payload) {
    const page = await eventPage(payload);
    return {
      items: page.items.map(toActivityDTO),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      diagnostics: page.diagnostics
    };
  }

  return Object.freeze({ execute: dispatchMutation, query: dispatchQuery, events: dispatchEvents });
}

function mapped(result, mapper) {
  return { ...result, data: mapper(result.data) };
}

async function mappedAsync(result, mapper) {
  return { ...result, data: await mapper(result.data, result.replayContext) };
}

async function pageMap(page, mapper) {
  return {
    items: await Promise.all(page.items.map((item) => mapper(item))),
    nextCursor: page.nextCursor ?? null
  };
}
