import { ACTOR_TYPES, CONTRACT_VERSION, EVENT_TYPES, SURFACE_KINDS } from './contractTypes.js';
import { deepFreeze } from './validation.js';

const EVENT_TYPE_BY_EVIDENCE = new Map([
  ['workstream|created|workstream_create', 'workstream.created'],
  ['workstream|updated|workstream_update', 'workstream.updated'],
  ['workstream|completed|workstream_update', 'workstream.updated'],
  ['run|created|run_create', 'run.created'],
  ['run|updated|run_start', 'run.started'],
  ['run|updated|run_progress', 'run.progressed'],
  ['run|updated|run_pause', 'run.paused'],
  ['run|updated|run_resume', 'run.resumed'],
  ['run|updated|run_stop', 'run.stopped'],
  // The Session ↔ Run bridge (ADR 003). Without an entry here the binding event is dropped from the
  // activity stream silently: `eventTypeFor` returns null and the envelope is skipped, so a fact the
  // user just created simply does not appear. A diagnostic counter is not a substitute for the entry.
  ['run|updated|run_bind_session', 'run.session_bound'],
  ['run|completed|run_complete', 'run.completed'],
  ['run|failed|run_fail', 'run.failed'],
  ['artifact|created|artifact_create', 'artifact.created'],
  ['checkpoint|created|checkpoint_create', 'checkpoint.created'],
  ['decision|created|decision_create', 'decision.created'],
  ['decision|superseded|decision_supersede', 'decision.superseded'],
  ['decision|revoked|decision_revoke', 'decision.revoked'],
  ['needs_owner|created|needs_owner_create', 'needs_owner.created'],
  ['needs_owner|updated|needs_owner_resolve', 'needs_owner.resolved'],
  ['needs_owner|cancelled|needs_owner_cancel', 'needs_owner.cancelled'],
  ['memory|created|memory_propose', 'memory.proposed'],
  ['memory|updated|memory_confirm', 'memory.confirmed'],
  ['memory|superseded|memory_correct', 'memory.superseded'],
  ['memory|updated|memory_archive', 'memory.archived'],
  ['memory|restored|memory_restore', 'memory.restored'],
  ['memory|created', 'memory.proposed'],
  ['memory|updated', 'memory.confirmed']
]);

const EVENT_TYPE_BY_LEGACY_IDENTITY = new Map([
  ['project|created', 'workstream.created'],
  ['project|updated', 'workstream.updated'],
  ['project|completed', 'workstream.updated'],
  ['decision|created', 'decision.created'],
  ['decision|superseded', 'decision.superseded'],
  ['decision|revoked', 'decision.revoked']
]);

const AGGREGATE_TYPES = Object.freeze({
  project: 'workstream', workstream: 'workstream', run: 'run', artifact: 'artifact', checkpoint: 'checkpoint',
  decision: 'decision', needs_owner: 'needs_owner', memory: 'memory'
});

const ACTIVITY_MESSAGES = Object.freeze({
  'workstream.created': 'Workstream created',
  'workstream.updated': 'Workstream updated',
  'run.created': 'Run created',
  'run.started': 'Run started',
  'run.progressed': 'Run progressed',
  'run.paused': 'Run paused',
  'run.resumed': 'Run resumed',
  'run.stopped': 'Run stopped',
  'run.session_bound': 'Agent session bound',
  'run.completed': 'Run completed',
  'run.failed': 'Run failed',
  'artifact.created': 'Artifact created',
  'checkpoint.created': 'Checkpoint created',
  'decision.created': 'Decision created',
  'decision.superseded': 'Decision superseded',
  'decision.revoked': 'Decision revoked',
  'needs_owner.created': 'Needs owner created',
  'needs_owner.resolved': 'Needs owner resolved',
  'needs_owner.cancelled': 'Needs owner cancelled',
  'memory.proposed': 'Memory proposed',
  'memory.confirmed': 'Memory confirmed',
  'memory.superseded': 'Memory superseded',
  'memory.archived': 'Memory archived',
  'memory.restored': 'Memory restored'
});

function safeString(value, max = 2_000) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null;
}

function safePayload(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function safeAuditMetadata(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function safeActor(row) {
  const metadata = safeAuditMetadata(row.audit_metadata);
  const type = ACTOR_TYPES.includes(row.audit_actor_type) ? row.audit_actor_type : null;
  return {
    type,
    subjectId: type ? safeString(metadata.actorSubjectId, 200) : null
  };
}

function eventTypeFor(row, payload) {
  const type = EVENT_TYPE_BY_EVIDENCE.get(`${row.entity_type}|${row.event_type}|${payload.command}`) ??
    EVENT_TYPE_BY_LEGACY_IDENTITY.get(`${row.entity_type}|${row.event_type}`);
  if (!type || !EVENT_TYPES.includes(type)) return null;
  const statusByType = {
    'run.started': 'running', 'run.progressed': 'running', 'run.paused': 'paused',
    'run.resumed': 'running', 'run.stopped': 'cancelled', 'run.completed': 'completed',
    'run.failed': 'failed', 'needs_owner.resolved': 'resolved', 'needs_owner.cancelled': 'cancelled'
  };
  return statusByType[type] && payload.status !== statusByType[type] ? null : type;
}

/**
 * Converts one persisted evidence row to a closed public Event Envelope.
 * Returning null deliberately skips unrecognized or unsafe historical evidence.
 */
export function toEventEnvelope(row) {
  const payload = safePayload(row?.payload);
  const eventType = payload && eventTypeFor(row, payload);
  const aggregateType = AGGREGATE_TYPES[row?.entity_type];
  const cursor = row?.sequence;
  const eventId = safeString(row?.event_id ?? row?.id, 200);
  const aggregateId = safeString(row?.entity_id, 200);
  const workstreamId = safeString(row?.project_id, 200);
  const occurredAt = safeString(row?.created_at, 200);
  if (!eventType || !aggregateType || !Number.isInteger(cursor) || cursor < 1 || !eventId || !aggregateId ||
    !Number.isInteger(row?.entity_version) || row.entity_version < 1 || !occurredAt) return null;

  const summary = ACTIVITY_MESSAGES[eventType];
  const correlationId = safeString(payload.correlationId, 200);
  const surfaceKind = SURFACE_KINDS.includes(payload.surfaceKind) ? payload.surfaceKind : null;
  return deepFreeze({
    cursor,
    eventId,
    eventType,
    aggregateType,
    aggregateId,
    aggregateVersion: row.entity_version,
    workstreamId,
    runId: aggregateType === 'run' ? aggregateId : null,
    occurredAt,
    actor: safeActor(row),
    source: { kind: 'application', surfaceKind, runtimeReference: null, correlationId },
    summary,
    data: {},
    contractVersion: CONTRACT_VERSION
  });
}

/** Derives Activity strictly from an already safe Event Envelope. */
export function toActivityDTO(envelope) {
  if (!envelope || !ACTIVITY_MESSAGES[envelope.eventType]) return null;
  return deepFreeze({
    cursor: envelope.cursor,
    type: envelope.eventType,
    workstreamId: envelope.workstreamId,
    runId: envelope.runId,
    title: ACTIVITY_MESSAGES[envelope.eventType],
    summary: envelope.summary,
    status: null,
    occurredAt: envelope.occurredAt,
    artifactReference: null,
    needsOwnerId: envelope.aggregateType === 'needs_owner' ? envelope.aggregateId : null
  });
}
