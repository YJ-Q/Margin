export const CONTRACT_VERSION = '1.2';

export const COMMAND_TYPES = Object.freeze([
  'workstream.create', 'workstream.update',
  'run.create', 'run.start', 'run.pause', 'run.resume', 'run.stop',
  'checkpoint.create', 'artifact.create',
  'needs_owner.create', 'needs_owner.resolve',
  'workstream.switch', 'memory.confirm', 'memory.correct', 'memory.archive', 'memory.restore',
  'run.bind_session'
]);

export const QUERY_TYPES = Object.freeze([
  'workstream.list', 'workstream.get', 'run.get', 'run.list',
  'artifact.list', 'decision.list', 'needs_owner.list',
  'activity.list', 'checkpoint.latest',
  'resume_brief.get', 'memory.list', 'memory.search',
  'session.resolve_runs'
]);

export const EVENT_QUERY_TYPES = Object.freeze(['event.list']);

export const EVENT_TYPES = Object.freeze([
  'workstream.created', 'workstream.updated', 'run.created', 'run.started',
  'run.progressed', 'run.paused', 'run.resumed', 'run.stopped', 'run.completed',
  'run.failed', 'run.session_bound', 'checkpoint.created', 'artifact.created', 'decision.created',
  'decision.superseded', 'decision.revoked', 'needs_owner.created',
  'needs_owner.resolved', 'needs_owner.cancelled',
  'memory.proposed', 'memory.confirmed', 'memory.superseded', 'memory.archived', 'memory.restored'
]);

export const ACTOR_TYPES = Object.freeze(['user', 'agent', 'system']);
export const SURFACE_KINDS = Object.freeze(['cli', 'web', 'feishu', 'scheduler', 'worker']);
export const WORKSTREAM_STATUSES = Object.freeze(['running', 'ready', 'waiting', 'watching', 'blocked', 'needs_owner', 'paused', 'completed']);
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'paused', 'completed', 'failed', 'needs_owner', 'cancelled']);
export const NEEDS_OWNER_TYPES = Object.freeze(['decision', 'approval', 'input', 'conflict']);
export const NEEDS_OWNER_STATUSES = Object.freeze(['open', 'resolved', 'cancelled']);
// Which agent a Run was executed by.
//
// This is the CORE's closed vocabulary (it validates `run.workerKind`), not the Runtime context's agent
// registry. Deriving it from the descriptor registry would make the Core depend on a context ADR 003
// keeps it independent of, and it would let a plugin file widen a Core enum. The precise identity of the
// session a Run came from travels in `runtimeReference.canonicalSessionId` instead, which is why `other`
// can stay the honest answer for a runtime Margin ships no reader for.
//
// Invariant, pinned by test/contractVersion.test.js: every agent type Margin ships is a valid workerKind,
// so a Run can be created for any session the bridge is able to bind. `claude` was missing here while
// Claude sessions existed on the Board — harmless until the bridge made it impossible to create the Run a
// Claude session would bind to.
export const WORKER_KINDS = Object.freeze(['pi', 'codex', 'claude', 'other']);
export const MEMORY_LIFECYCLE_STATUSES = Object.freeze(['candidate', 'active', 'archive']);
