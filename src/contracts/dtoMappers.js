import { boundedJsonClone, ContractValidationError, deepFreeze } from './validation.js';
import { NEEDS_OWNER_STATUSES, NEEDS_OWNER_TYPES, RUN_STATUSES, WORKER_KINDS, WORKSTREAM_STATUSES, MEMORY_LIFECYCLE_STATUSES } from './contractTypes.js';

const storageFailure = (message) => new ContractValidationError('storage_failure', message);

export function toWorkstreamDTO(row, { latestCheckpoint = null, activeRun = null } = {}) {
  const dto = {
    id: string(row.id, 'id'), title: string(row.title, 'title'), goal: string(row.goal, 'goal'),
    status: enumValue(row.workstream_status ?? row.status, WORKSTREAM_STATUSES, 'status'), priority: integer(row.priority ?? 0, 'priority'),
    currentState: nullableString(row.current_state ?? row.currentState), currentPlan: jsonStringArray(row.current_plan ?? row.currentPlan ?? [], 'currentPlan'),
    nextAction: nullableString(row.next_action ?? row.nextAction), blockers: jsonStringArray(row.blockers ?? [], 'blockers'),
    autonomyLevel: integer(row.autonomy_level ?? row.autonomyLevel ?? 0, 'autonomyLevel'),
    workspaceReference: nullableString(row.workspace_path ?? row.workspacePath) ? { kind: 'local_path', path: row.workspace_path ?? row.workspacePath } : null,
    latestCheckpoint: latestCheckpoint ? toCheckpointDTO(latestCheckpoint) : null, activeRun: activeRun ? toRunSummaryDTO(activeRun) : null,
    version: integer(row.version, 'version'), updatedAt: nullableString(row.updated_at ?? row.updatedAt)
  };
  return deepFreeze(dto);
}

export function toRunDTO(row, { checkpoint = null } = {}) {
  const kind = enumValue(row.runtime_kind ?? row.workerKind, WORKER_KINDS, 'workerKind');
  const runtimeId = nullableString(row.runtime_session_id ?? row.runtimeSessionId);
  const canonicalSessionId = nullableString(row.runtime_session_canonical_id ?? row.runtimeSessionCanonicalId);
  // The Session bridge (ADR 003) refines the runtime reference rather than replacing it. An unbound
  // Run keeps exactly the shape it had before, so every existing reader of `{ kind, id }` is
  // unaffected; a bound Run additionally names the agent session the work came from. That id is the
  // Board's `canonicalId`, which is what makes the two bounded contexts joinable at all.
  const runtimeReference = (runtimeId || canonicalSessionId)
    ? { kind, id: runtimeId ?? null, ...(canonicalSessionId ? { canonicalSessionId } : {}) }
    : null;
  const dto = {
    id: string(row.id, 'id'), workstreamId: string(row.workstream_id ?? row.workstreamId, 'workstreamId'), workerKind: kind,
    runtimeReference, scope: nullableString(row.scope) ?? '', status: enumValue(row.status, RUN_STATUSES, 'status'),
    currentStep: null, progress: null,
    limits: { stopCondition: nullableString(row.stop_condition ?? row.stopCondition), allowedActions: jsonStringArray(row.allowed_actions ?? row.allowedActions ?? [], 'allowedActions'), forbiddenActions: jsonStringArray(row.forbidden_actions ?? row.forbiddenActions ?? [], 'forbiddenActions'), budget: null },
    result: jsonNullable(row.result, 'result'), validationSummary: jsonNullable(row.validation ?? row.validationSummary, 'validationSummary'), error: jsonNullable(row.error, 'error'),
    checkpoint: checkpoint ? toCheckpointDTO(checkpoint) : null, version: integer(row.version, 'version'),
    createdAt: nullableString(row.created_at ?? row.createdAt), updatedAt: nullableString(row.updated_at ?? row.updatedAt), startedAt: nullableString(row.started_at ?? row.startedAt), endedAt: nullableString(row.ended_at ?? row.endedAt)
  };
  return deepFreeze(dto);
}

// The bridge projection a Board consumes: just enough to label a session with the Run it belongs to.
// It is deliberately not a Run DTO — a caller that needs the whole Run asks the Contract for `run.get`.
export function toSessionRunBindingDTO(row) {
  return deepFreeze({
    canonicalSessionId: string(row.runtime_session_canonical_id ?? row.canonicalSessionId, 'canonicalSessionId'),
    runId: string(row.id ?? row.runId, 'runId'),
    workstreamId: string(row.workstream_id ?? row.workstreamId, 'workstreamId'),
    status: enumValue(row.status, RUN_STATUSES, 'status'),
    version: integer(row.version, 'version'),
    updatedAt: nullableString(row.updated_at ?? row.updatedAt)
  });
}

export function toArtifactDTO(row) {
  const runtimeId = nullableString(row.runtime_session_id ?? row.runtimeSessionId);
  const runtimeKind = row.runtime_kind ?? row.runtimeKind;
  const runtimeReference = runtimeId && WORKER_KINDS.includes(runtimeKind) ? { kind: runtimeKind, id: runtimeId } : null;
  return deepFreeze({
    id: string(row.id, 'id'), workstreamId: string(row.workstream_id ?? row.workstreamId, 'workstreamId'), runId: nullableString(row.run_id ?? row.runId), type: string(row.type, 'type'), title: string(row.title, 'title'),
    source: { createdBy: string(row.created_by ?? row.createdBy, 'createdBy'), runtimeReference },
    resourceReference: { uri: string(row.uri ?? row.resourceReference?.uri, 'uri'), contentHash: string(row.content_hash ?? row.resourceReference?.contentHash, 'contentHash') },
    metadata: jsonObject(row.metadata ?? {}, 'metadata'), previewMetadata: jsonObject(row.preview_metadata ?? row.previewMetadata ?? {}, 'previewMetadata'), version: integer(row.version, 'version'),
    createdAt: nullableString(row.created_at ?? row.createdAt), updatedAt: nullableString(row.updated_at ?? row.updatedAt)
  });
}

export function toDecisionDTO(row) {
  const status = row.status === 'confirmed' ? 'active' : enumValue(row.status, ['superseded', 'revoked'], 'status');
  return deepFreeze({
    id: string(row.id, 'id'), workstreamId: string(row.project_id ?? row.workstream_id ?? row.workstreamId, 'workstreamId'), decisionKey: string(row.decision_key ?? row.decisionKey, 'decisionKey'), content: string(row.content, 'content'), rationale: nullableString(row.rationale), status,
    supersededBy: nullableString(row.superseded_by ?? row.supersededBy), source: { runtimeReference: null, sourceEventId: nullableString(row.source_event_id ?? row.sourceEventId) },
    version: integer(row.version, 'version'), createdAt: nullableString(row.created_at ?? row.createdAt), updatedAt: nullableString(row.updated_at ?? row.updatedAt)
  });
}

export function toNeedsOwnerDTO(row) {
  const options = jsonArray(row.options ?? [], 'options').map((option) => {
    if (!plain(option) || typeof option.id !== 'string' || typeof option.label !== 'string') throw storageFailure('Invalid persisted options');
    return { id: option.id, label: option.label, consequenceSummary: nullableString(option.consequenceSummary) };
  });
  if (options.length > 10) throw storageFailure('Persisted options exceed bound');
  return deepFreeze({
    id: string(row.id, 'id'), workstreamId: string(row.workstream_id ?? row.workstreamId, 'workstreamId'), runId: nullableString(row.run_id ?? row.runId), type: enumValue(row.type, NEEDS_OWNER_TYPES, 'type'), reason: string(row.reason, 'reason'), options,
    consequenceSummary: nullableString(row.consequence_summary ?? row.consequenceSummary), contextSummary: nullableString(row.context_summary ?? row.contextSummary), status: enumValue(row.status, NEEDS_OWNER_STATUSES, 'status'), resolution: needsOwnerResolution(row.resolution), version: integer(row.version, 'version'), createdAt: nullableString(row.created_at ?? row.createdAt), resolvedAt: nullableString(row.resolved_at ?? row.resolvedAt)
  });
}

export function toCheckpointDTO(row) {
  return deepFreeze({ id: string(row.id, 'id'), workstreamId: string(row.workstream_id ?? row.workstreamId, 'workstreamId'), runId: nullableString(row.run_id ?? row.runId), runVersion: nullableInteger(row.run_version ?? row.runVersion, 'runVersion'), stateVersion: integer(row.state_version ?? row.stateVersion, 'stateVersion'), stateDigest: string(row.state_digest ?? row.stateDigest, 'stateDigest'), gitRef: nullableString(row.git_ref ?? row.gitRef), note: typeof row.note === 'string' ? row.note : '', createdBy: string(row.created_by ?? row.createdBy, 'createdBy'), createdAt: nullableString(row.created_at ?? row.createdAt) });
}

function toRunSummaryDTO(row) { const dto = toRunDTO(row); return { id: dto.id, status: dto.status, version: dto.version, runtimeReference: dto.runtimeReference }; }
function parse(value, label) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { throw storageFailure(`Malformed persisted ${label}`); } }
function clonePersistedJson(value, label) { try { return boundedJsonClone(value, label); } catch { throw storageFailure(`Invalid persisted ${label}`); } }
function jsonArray(value, label) { const parsed = clonePersistedJson(parse(value, label), label); if (!Array.isArray(parsed)) throw storageFailure(`Invalid persisted ${label}`); return parsed; }
function jsonStringArray(value, label, max = 20) { const parsed = jsonArray(value, label); if (parsed.length > max || parsed.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)) throw storageFailure(`Invalid persisted ${label}`); return parsed; }
function jsonObject(value, label) { const parsed = parse(value, label); if (!plain(parsed)) throw storageFailure(`Invalid persisted ${label}`); return clonePersistedJson(parsed, label); }
function needsOwnerResolution(value) {
  if (value === undefined || value === null) return null;
  const parsed = jsonObject(value, 'resolution');
  if (Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'optionId') || !Object.hasOwn(parsed, 'summary')) {
    throw storageFailure('Invalid persisted resolution');
  }
  return { optionId: nullableString(parsed.optionId), summary: nullableString(parsed.summary) };
}
function jsonNullable(value, label) { if (value === undefined || value === null) return null; return clonePersistedJson(parse(value, label), label); }
function string(value, label) { if (typeof value !== 'string' || !value.trim()) throw storageFailure(`Invalid persisted ${label}`); return value; }
function nullableString(value) { return value === undefined || value === null ? null : string(value, 'string'); }
function integer(value, label) { if (!Number.isInteger(value) || value < 0) throw storageFailure(`Invalid persisted ${label}`); return value; }
function nullableInteger(value, label) { return value === undefined || value === null ? null : integer(value, label); }
function enumValue(value, allowed, label) { if (!allowed.includes(value)) throw storageFailure(`Invalid persisted ${label}`); return value; }
function plain(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }

function memoryLifecycle(row) {
  if (row.confirmation_status === 'proposed') return 'candidate';
  if (row.confirmation_status === 'confirmed' && !row.archived_at && !row.superseded_by) return 'active';
  return 'archive';
}

export function toMemoryDTO(row) {
  return deepFreeze({
    id: string(row.id, 'id'),
    workstreamId: string(row.project_id ?? row.workstream_id ?? row.workstreamId, 'workstreamId'),
    content: string(row.content, 'content'),
    memoryType: string(row.memory_type ?? row.memoryType, 'memoryType'),
    lifecycleStatus: memoryLifecycle(row),
    confidence: typeof row.confidence === 'number' ? row.confidence : 0,
    validFrom: nullableString(row.valid_from ?? row.validFrom),
    expiresAt: nullableString(row.expires_at ?? row.expiresAt),
    supersededBy: nullableString(row.superseded_by ?? row.supersededBy),
    archivedAt: nullableString(row.archived_at ?? row.archivedAt),
    source: { sourceEventId: nullableString(row.source_event_id ?? row.sourceEventId) },
    version: integer(row.version, 'version'),
    createdAt: nullableString(row.created_at ?? row.createdAt),
    updatedAt: nullableString(row.updated_at ?? row.updatedAt)
  });
}

export function toMemoryRecallDTO(row) {
  return deepFreeze({ ...toMemoryDTO(row), score: typeof row.score === 'number' ? row.score : null, retrievalReason: nullableString(row.retrievalReason) });
}
