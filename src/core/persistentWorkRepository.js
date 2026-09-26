import { CoreContractError, digestInput } from './contracts.js';
import { transitionWorkstream } from '../domain/workstream.js';

const json = (value) => JSON.stringify(value ?? []);
const jsonObject = (value) => JSON.stringify(value ?? {});
const SURFACE_KINDS = new Set(['cli', 'web', 'feishu', 'scheduler', 'worker']);
const REPLAY_TABLES = Object.freeze({
  workstream: 'margin_projects', run: 'margin_runs', artifact: 'margin_artifacts',
  checkpoint: 'margin_checkpoints', needs_owner: 'margin_needs_owner'
});

function storedNeedsOwnerOptions(value) {
  let options;
  try { options = JSON.parse(value); }
  catch { throw new CoreContractError('storage_failure', 'Stored NeedsOwner options are invalid'); }
  if (!Array.isArray(options) || options.length > 10 || options.some((option) =>
    !option || typeof option !== 'object' || Array.isArray(option) ||
    Object.keys(option).some((key) => !['id', 'label', 'consequenceSummary'].includes(key)) ||
    typeof option.id !== 'string' || !option.id.trim() || option.id.length > 200 ||
    typeof option.label !== 'string' || !option.label.trim() || option.label.length > 2_000 ||
    (option.consequenceSummary !== undefined && option.consequenceSummary !== null &&
      (typeof option.consequenceSummary !== 'string' || !option.consequenceSummary.trim() || option.consequenceSummary.length > 2_000))
  ) || new Set(options.map((option) => option.id)).size !== options.length) {
    throw new CoreContractError('storage_failure', 'Stored NeedsOwner options are invalid');
  }
  return options;
}

function normalizeEvidenceMetadata(actor = {}) {
  const correlationId = actor.correlationId;
  if (correlationId !== undefined && correlationId !== null &&
    (typeof correlationId !== 'string' || !correlationId.trim() || correlationId.length > 200)) {
    throw new CoreContractError('invalid_request', 'correlationId must be a non-empty string up to 200 characters');
  }
  const surfaceKind = actor.surfaceKind;
  if (surfaceKind !== undefined && surfaceKind !== null &&
    (typeof surfaceKind !== 'string' || !SURFACE_KINDS.has(surfaceKind))) {
    throw new CoreContractError('invalid_request', 'surfaceKind is not supported');
  }
  return { correlationId: correlationId ?? null, surfaceKind: surfaceKind ?? null };
}

function versionConflict(actual) {
  const error = new CoreContractError('version_conflict', 'Version conflict');
  error.details = { actual };
  return error;
}

function pageInput(input = {}) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreContractError('invalid_request', 'limit must be an integer from 1 to 100');
  if (input.cursor === undefined || input.cursor === null) return { limit, cursor: null };
  try {
    const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    if (!cursor || typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string') throw new Error('invalid');
    return { limit, cursor };
  } catch { throw new CoreContractError('invalid_request', 'Invalid cursor'); }
}

function nextPage(rows, limit) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at, id: last.id })).toString('base64url') : null
  };
}

function listWhere({ workstreamId, runId, statuses, cursor }, aliases = {}) {
  const clauses = [];
  const values = [];
  if (workstreamId) { clauses.push(`${aliases.workstream ?? 'workstream_id'}=?`); values.push(workstreamId); }
  if (runId) { clauses.push(`${aliases.run ?? 'run_id'}=?`); values.push(runId); }
  if (statuses !== undefined) {
    if (!Array.isArray(statuses) || statuses.length === 0 || statuses.length > 20 || statuses.some((status) => typeof status !== 'string')) throw new CoreContractError('invalid_request', 'statuses must be a bounded string list');
    clauses.push(`${aliases.status ?? 'status'} IN (${statuses.map(() => '?').join(',')})`);
    values.push(...statuses);
  }
  if (cursor) {
    clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

export function createPersistentWorkRepository(store) {
  const evidence = async (tx, { operation, requestId, actor, workstreamId, entityType, entityId, version, eventType, input, status }) => {
    if (store.beforeEvidenceWrite) await store.beforeEvidenceWrite({ entityType, entityId, eventType });
    const auditId = store.idFactory('audit');
    const now = store.clock();
    const metadata = normalizeEvidenceMetadata(actor);
    const payload = JSON.stringify({
      command: operation,
      status: status ?? null,
      correlationId: metadata.correlationId,
      surfaceKind: metadata.surfaceKind,
      auditId
    });
    await tx.run(
      `INSERT INTO margin_events
       (id,entity_type,entity_id,project_id,event_type,entity_version,payload,source_session_id,source_event_id,created_at)
       VALUES (?,?,?,?,?,?,?, ?,?,?)`,
      store.idFactory('event'), entityType, entityId, workstreamId, eventType, version, payload, actor.sourceSessionId, actor.sourceEventId, now
    );
    const replayTable = REPLAY_TABLES[entityType];
    const replayData = replayTable ? await tx.get(`SELECT * FROM ${replayTable} WHERE id=?`, entityId) : undefined;
    let replayRelated;
    if (entityType === 'workstream') {
      replayRelated = {
        latestCheckpoint: await tx.get('SELECT * FROM margin_checkpoints WHERE workstream_id=? ORDER BY created_at DESC,id DESC LIMIT 1', entityId) ?? null,
        activeRun: await tx.get("SELECT * FROM margin_runs WHERE workstream_id=? AND status IN ('queued','running','paused','needs_owner') ORDER BY created_at DESC,id LIMIT 1", entityId) ?? null
      };
    } else if (entityType === 'run') {
      replayRelated = {
        checkpoint: await tx.get('SELECT * FROM margin_checkpoints WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1', entityId) ?? null
      };
    }
    await tx.run(
      `INSERT INTO margin_audit_log
       (id,operation,request_id,actor_type,project_id,entity_type,entity_id,permission_decision,result_code,input_digest,metadata,created_at)
       VALUES (?,?,?,?,?,?,?,'allowed','allowed',?,?,?)`,
      auditId, operation, requestId, actor.actorType, workstreamId, entityType, entityId, digestInput(input),
      JSON.stringify({
        actorSubjectId: actor.subjectId ?? null,
        correlationId: metadata.correlationId,
        surfaceKind: metadata.surfaceKind,
        gatewayRequestId: actor.sourceEventId,
        ...(replayData ? { replayData } : {}),
        ...(replayRelated ? { replayRelated } : {})
      }), now
    );
    return {
      auditId,
      ...(replayRelated === undefined ? {} : { replayContext: replayRelated })
    };
  };

  const replay = async (tx, operation, requestId, table, input, actor) => {
    const audit = await tx.get("SELECT id, operation, entity_id, actor_type, input_digest, metadata FROM margin_audit_log WHERE request_id=? AND result_code='allowed' ORDER BY created_at LIMIT 1", requestId);
    if (!audit) return null;
    let auditMetadata;
    try { auditMetadata = JSON.parse(audit.metadata || '{}'); } catch { throw new CoreContractError('idempotency_conflict', 'Stored idempotency identity is invalid'); }
    const recordedSubject = auditMetadata.actorSubjectId ?? null;
    if (audit.operation !== operation || audit.actor_type !== actor?.actorType || recordedSubject !== (actor?.subjectId ?? null) || audit.input_digest !== digestInput(input)) {
      throw new CoreContractError('idempotency_conflict', 'Request ID was already used with different input or actor');
    }
    return {
      auditId: audit.id,
      data: auditMetadata.replayData ?? await tx.get(`SELECT * FROM ${table} WHERE id=?`, audit.entity_id),
      ...(Object.hasOwn(auditMetadata, 'replayRelated') ? { replayContext: auditMetadata.replayRelated } : {})
    };
  };

  const mutation = async (actor, work) => {
    normalizeEvidenceMetadata(actor);
    return store.transaction(work);
  };

  const transitionRunInTransaction = async (tx, input, actor, coordinate) => {
    const operation = `run_${input.command}`;
    const requestInput = input.requestInput ?? input;
    const prior = await replay(tx, operation, input.requestId, 'margin_runs', requestInput, actor);
    if (prior) return prior;
    const current = await tx.get('SELECT * FROM margin_runs WHERE id=?', input.runId);
    if (!current) throw new CoreContractError('run_not_found','Run not found');
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const coordinated = coordinate ? await coordinate(current) : {};
    const transition = { ...input, ...coordinated };
    const now=store.clock(); const nextVersion=current.version+1;
    let checkpointId=current.checkpoint_id;
    if (transition.checkpoint) {
      const workstream=await tx.get('SELECT version FROM margin_projects WHERE id=?',current.workstream_id);
      checkpointId=store.idFactory('checkpoint');
      await tx.run(`INSERT INTO margin_checkpoints VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,checkpointId,current.workstream_id,current.id,nextVersion,workstream.version,digestInput({runId:current.id,status:transition.status,version:nextVersion}),null,transition.note ?? input.command,actor.actorType,actor.sourceSessionId,actor.sourceEventId,now);
      await tx.run('UPDATE margin_projects SET last_checkpoint_id=?,updated_at=? WHERE id=?',checkpointId,now,current.workstream_id);
    }
    const startedAt=transition.status==='running' ? (current.started_at ?? now) : current.started_at;
    const endedAt=['completed','failed','cancelled'].includes(transition.status) ? now : null;
    await tx.run(`UPDATE margin_runs SET status=?,runtime_session_id=?,checkpoint_id=?,version=?,source_session_id=?,source_event_id=?,updated_at=?,started_at=?,ended_at=? WHERE id=?`,
      transition.status,transition.runtimeSessionId ?? current.runtime_session_id,checkpointId,nextVersion,actor.sourceSessionId,actor.sourceEventId,now,startedAt,endedAt,current.id);
    const eventType=transition.status==='completed'?'completed':transition.status==='failed'?'failed':'updated';
    const replayEvidence=await evidence(tx,{operation,requestId:input.requestId,actor,workstreamId:current.workstream_id,entityType:'run',entityId:current.id,version:nextVersion,eventType,input:requestInput,status:transition.status});
    return {data:await tx.get('SELECT * FROM margin_runs WHERE id=?',current.id),...replayEvidence};
  };

  return {
    getOperationReplay: async (operation, requestId, table, input, actor) => {
      const found = await replay(store.db, operation, requestId, table, input, actor);
      return found;
    },
    getWorkstream: async (id) => mapWorkstream(await store.db.get('SELECT * FROM margin_projects WHERE id=? AND deleted_at IS NULL', id)),
    findWorkstreamByScenario: async (scenario) => mapWorkstream(await store.db.get("SELECT * FROM margin_projects WHERE scenario=? AND workstream_status <> 'completed' AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1", scenario)),
    listWorkstreams: async () => Promise.all((await store.db.all('SELECT * FROM margin_projects WHERE deleted_at IS NULL ORDER BY updated_at DESC,id')).map(mapWorkstream)),
    listWorkstreamsPage: async (input = {}) => {
      const page = pageInput(input);
      const where = listWhere({ ...input, cursor: page.cursor }, { status: 'workstream_status' });
      const deleted = where.clause ? `${where.clause} AND deleted_at IS NULL` : 'WHERE deleted_at IS NULL';
      const rows = await store.db.all(`SELECT * FROM margin_projects ${deleted} ORDER BY updated_at DESC,id DESC LIMIT ?`, ...where.values, page.limit + 1);
      const result = nextPage(rows, page.limit);
      return { ...result, items: result.items.map(mapWorkstream) };
    },
    getContinuitySnapshot: async (input) => {
      const snapshot = await store.getContinuitySnapshot(input);
      const actions = await store.db.all("SELECT * FROM margin_actions WHERE project_id=? AND status IN ('pending','active') ORDER BY updated_at DESC,id LIMIT 10", input.projectId);
      return { ...snapshot, project: mapWorkstream(snapshot.project), actions };
    },
    updateWorkstream: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'workstream_update', input.requestId, 'margin_projects', input, actor);
      if (prior) return { ...prior, data: mapWorkstream(prior.data) };
      const current = await tx.get('SELECT * FROM margin_projects WHERE id=? AND deleted_at IS NULL', input.workstreamId);
      if (!current) throw new CoreContractError('workstream_not_found','Workstream not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const legacyToWorkstream = { active: 'running', blocked: 'blocked', completed: 'completed', archived: 'completed' };
      const workstreamToLegacy = { running: 'active', ready: 'active', waiting: 'active', watching: 'active', blocked: 'blocked', needs_owner: 'blocked', paused: 'blocked', completed: 'completed' };
      const requestedStatus = input.changes.status;
      const workstreamStatus = requestedStatus === undefined ? current.workstream_status : (legacyToWorkstream[requestedStatus] ?? requestedStatus);
      const legacyStatus = requestedStatus === undefined ? current.status : (workstreamToLegacy[workstreamStatus] ?? requestedStatus);
      if (!workstreamToLegacy[workstreamStatus] || !['active','blocked','completed','archived'].includes(legacyStatus)) throw new CoreContractError('invalid_request','Unsupported Workstream status');
      if (workstreamStatus !== current.workstream_status) {
        const commands = { blocked: 'block', completed: 'complete', paused: 'pause', waiting: 'wait', watching: 'watch', needs_owner: 'needs_owner', ready: 'ready', running: current.workstream_status === 'ready' ? 'start' : 'resume' };
        try {
          if (transitionWorkstream({ status: current.workstream_status }, { type: commands[workstreamStatus] }).status !== workstreamStatus) throw new Error('invalid');
        } catch { throw new CoreContractError('invalid_workstream_transition','Invalid Workstream transition'); }
        const openRun = await tx.get("SELECT id FROM margin_runs WHERE workstream_id=? AND status IN ('queued','running','paused','needs_owner') LIMIT 1", current.id);
        if (openRun) throw new CoreContractError('open_run_conflict','Stop or complete the open Run before changing Workstream status');
      }
      const next = {
        goal: input.changes.goal ?? current.goal,
        phase: input.changes.phase ?? current.phase,
        priority: input.changes.priority ?? current.priority,
        currentState: input.changes.currentState === undefined ? current.current_state : input.changes.currentState,
        currentPlan: input.changes.currentPlan === undefined ? current.current_plan : json(input.changes.currentPlan),
        nextAction: input.changes.nextAction === undefined ? current.next_action : input.changes.nextAction,
        autonomyLevel: input.changes.autonomyLevel ?? current.autonomy_level,
        workspacePath: input.changes.workspacePath === undefined ? current.workspace_path : input.changes.workspacePath
      };
      const now=store.clock(); const nextVersion=current.version+1;
      await tx.run(
        `UPDATE margin_projects
         SET goal=?,phase=?,status=?,workstream_status=?,priority=?,current_state=?,current_plan=?,next_action=?,autonomy_level=?,workspace_path=?,
             version=?,source_session_id=?,source_event_id=?,updated_at=? WHERE id=?`,
        next.goal,next.phase,legacyStatus,workstreamStatus,next.priority,next.currentState,next.currentPlan,next.nextAction,next.autonomyLevel,next.workspacePath,
        nextVersion,actor.sourceSessionId,actor.sourceEventId,now,current.id
      );
      const replayEvidence=await evidence(tx,{operation:'workstream_update',requestId:input.requestId,actor,workstreamId:current.id,entityType:'workstream',entityId:current.id,version:nextVersion,eventType:workstreamStatus==='completed'?'completed':'updated',input,status:workstreamStatus});
      return {data:mapWorkstream(await tx.get('SELECT * FROM margin_projects WHERE id=?',current.id)),...replayEvidence};
    }),
    createWorkstream: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'workstream_create', input.requestId, 'margin_projects', input, actor);
      if (prior) return { ...prior, data: mapWorkstream(prior.data) };
      const id = store.idFactory('workstream');
      const now = store.clock();
      await tx.run(
        `INSERT INTO margin_projects
         (id,scenario,goal,phase,status,version,source_session_id,source_event_id,created_at,updated_at,deleted_at,
          title,workstream_status,priority,current_state,current_plan,next_action,blockers,dependencies,workspace_path,autonomy_level,artifact_refs,last_checkpoint_id)
         VALUES (?,?,?,'v1','active',1,?,?,?, ?,NULL,?,'running',?,?,'[]',NULL,'[]','[]',?,?,'[]',NULL)`,
        id, input.scenario, input.goal, actor.sourceSessionId, actor.sourceEventId, now, now,
        input.title, input.priority ?? 0, input.currentState ?? null, input.workspacePath ?? null, input.autonomyLevel ?? 0
      );
      if (input.currentPlan?.length || input.nextAction) {
        await tx.run('UPDATE margin_projects SET current_plan=?,next_action=? WHERE id=?', json(input.currentPlan), input.nextAction ?? null, id);
      }
      const replayEvidence = await evidence(tx, { operation: 'workstream_create', requestId: input.requestId, actor, workstreamId: id, entityType: 'workstream', entityId: id, version: 1, eventType: 'created', input, status: 'running' });
      return { data: mapWorkstream(await tx.get('SELECT * FROM margin_projects WHERE id=?', id)), ...replayEvidence };
    }),
    createRun: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'run_create', input.requestId, 'margin_runs', input, actor);
      if (prior) return prior;
      const workstream = await tx.get('SELECT id FROM margin_projects WHERE id=? AND deleted_at IS NULL', input.workstreamId);
      if (!workstream) throw new CoreContractError('workstream_not_found', 'Workstream not found');
      if (await tx.get("SELECT id FROM margin_runs WHERE workstream_id=? AND status IN ('queued','running','paused','needs_owner')", input.workstreamId)) {
        throw new CoreContractError('open_run_exists', 'An open Run already exists');
      }
      const id = store.idFactory('run');
      const now = store.clock();
      await tx.run(
        `INSERT INTO margin_runs
         (id,workstream_id,runtime_kind,runtime_session_id,scope,status,stop_condition,allowed_actions,forbidden_actions,files_changed,
          validation,result,error,checkpoint_id,version,source_session_id,source_event_id,created_at,updated_at,started_at,ended_at)
         VALUES (?,?,?,?,?,'queued',?,?,?,'[]',NULL,NULL,NULL,NULL,1,?,?,?, ?,NULL,NULL)`,
        id, input.workstreamId, input.runtimeKind, input.runtimeSessionId ?? null, input.scope, input.stopCondition ?? null,
        json(input.allowedActions), json(input.forbiddenActions), actor.sourceSessionId, actor.sourceEventId, now, now
      );
      const replayEvidence = await evidence(tx, { operation: 'run_create', requestId: input.requestId, actor, workstreamId: input.workstreamId, entityType: 'run', entityId: id, version: 1, eventType: 'created', input });
      return { data: await tx.get('SELECT * FROM margin_runs WHERE id=?', id), ...replayEvidence };
    }),
    getRun: (id) => store.db.get('SELECT * FROM margin_runs WHERE id=?', id),
    findOpenRun: (workstreamId) => store.db.get("SELECT * FROM margin_runs WHERE workstream_id=? AND status IN ('queued','running','paused','needs_owner') ORDER BY created_at DESC,id LIMIT 1", workstreamId),
    transitionRun: (input, actor) => mutation(actor, (tx) => transitionRunInTransaction(tx, input, actor)),
    coordinateRunTransition: (input, actor, coordinate) => mutation(actor, (tx) => transitionRunInTransaction(tx, input, actor, coordinate)),
    // Session ↔ Run bridge (ADR 003): bind, rebind, or unbind the agent session a Run came from.
    // `sessionCanonicalId: null` unbinds.
    bindRunSession: (input, actor) => mutation(actor, async (tx) => {
      const operation = 'run_bind_session';
      const requestInput = input.requestInput ?? input;
      const prior = await replay(tx, operation, input.requestId, 'margin_runs', requestInput, actor);
      if (prior) return prior;
      const current = await tx.get('SELECT * FROM margin_runs WHERE id=?', input.runId);
      if (!current) throw new CoreContractError('run_not_found', 'Run not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const sessionCanonicalId = input.sessionCanonicalId ?? null;
      // Exclusivity is enforced by the partial unique index. Checking here as well turns a raw
      // constraint failure into an actionable error that names the Run already holding the session —
      // "which Run is this session?" must never require the caller to guess.
      if (sessionCanonicalId) {
        const owner = await tx.get('SELECT id, workstream_id FROM margin_runs WHERE runtime_session_canonical_id=? AND id<>?', sessionCanonicalId, current.id);
        if (owner) {
          // The surface envelope deliberately carries no message text (ADR 002 forbids leaking internal
          // detail), so "which Run already holds this session" is reported the same structured way
          // `version_conflict` reports `currentVersion`. A code the caller cannot act on is not enough.
          const conflict = new CoreContractError('session_already_bound', `Agent session is already bound to Run ${owner.id}`);
          conflict.details = { runId: owner.id, workstreamId: owner.workstream_id };
          throw conflict;
        }
      }
      const now = store.clock(); const nextVersion = current.version + 1;
      await tx.run(
        'UPDATE margin_runs SET runtime_session_canonical_id=?,version=?,source_session_id=?,source_event_id=?,updated_at=? WHERE id=?',
        sessionCanonicalId, nextVersion, actor.sourceSessionId, actor.sourceEventId, now, current.id
      );
      const replayEvidence = await evidence(tx, {
        operation, requestId: input.requestId, actor, workstreamId: current.workstream_id,
        entityType: 'run', entityId: current.id, version: nextVersion, eventType: 'updated',
        input: requestInput, status: current.status
      });
      return { data: await tx.get('SELECT * FROM margin_runs WHERE id=?', current.id), ...replayEvidence };
    }),
    // Reverse lookup for a Board that holds many sessions: one bounded read instead of N queries.
    // Returns only the projection the caller needs; a Run DTO is fetched through the Contract.
    resolveRunsByCanonicalSessions: async (canonicalSessionIds = []) => {
      const ids = [...new Set(canonicalSessionIds.filter((value) => typeof value === 'string' && value.trim()))].slice(0, 100);
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      return store.db.all(
        `SELECT id,workstream_id,runtime_session_canonical_id,status,version,updated_at FROM margin_runs
         WHERE runtime_session_canonical_id IN (${placeholders}) ORDER BY updated_at DESC,id DESC`,
        ...ids
      );
    },
    createArtifact: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'artifact_create', input.requestId, 'margin_artifacts', input, actor);
      if (prior) return prior;
      const workstream = await tx.get('SELECT id FROM margin_projects WHERE id=? AND deleted_at IS NULL', input.workstreamId);
      if (!workstream) throw new CoreContractError('workstream_not_found', 'Workstream not found');
      const run = input.runId ? await tx.get('SELECT workstream_id FROM margin_runs WHERE id=?', input.runId) : null;
      if (input.runId && (!run || run.workstream_id !== input.workstreamId)) throw new CoreContractError('cross_workstream_reference', 'Run belongs to another Workstream');
      const id = store.idFactory('artifact'); const now = store.clock();
      await tx.run(
        `INSERT INTO margin_artifacts
         (id,workstream_id,run_id,type,title,uri,content_hash,created_by,version,source_session_id,source_event_id,created_at,updated_at,deleted_at,metadata,preview_metadata)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,NULL,?,?)`,
        id,input.workstreamId,input.runId ?? null,input.type,input.title,input.uri,input.contentHash,actor.actorType,actor.sourceSessionId,actor.sourceEventId,now,now,
        jsonObject(input.metadata),jsonObject(input.previewMetadata)
      );
      const replayEvidence = await evidence(tx,{operation:'artifact_create',requestId:input.requestId,actor,workstreamId:input.workstreamId,entityType:'artifact',entityId:id,version:1,eventType:'created',input});
      return {data:await tx.get('SELECT * FROM margin_artifacts WHERE id=?',id),...replayEvidence};
    }),
    createCheckpoint: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'checkpoint_create', input.requestId, 'margin_checkpoints', input, actor);
      if (prior) return prior;
      const hasRunId = input.runId !== undefined && input.runId !== null;
      const hasRunVersion = input.runVersion !== undefined && input.runVersion !== null;
      if (hasRunId !== hasRunVersion) throw new CoreContractError('invalid_request','runId and runVersion must be provided together');
      const workstream = await tx.get('SELECT id,version FROM margin_projects WHERE id=? AND deleted_at IS NULL', input.workstreamId);
      if (!workstream) throw new CoreContractError('workstream_not_found','Workstream not found');
      if (workstream.version !== input.stateVersion) throw versionConflict(workstream.version);
      const run = input.runId ? await tx.get('SELECT workstream_id,version FROM margin_runs WHERE id=?',input.runId) : null;
      if (input.runId && (!run || run.workstream_id !== input.workstreamId)) throw new CoreContractError('cross_workstream_reference','Run belongs to another Workstream');
      if (run && run.version !== input.runVersion) throw versionConflict(run.version);
      const id=store.idFactory('checkpoint'); const now=store.clock();
      await tx.run(`INSERT INTO margin_checkpoints VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,id,input.workstreamId,input.runId ?? null,input.runVersion ?? null,input.stateVersion,input.stateDigest,input.gitRef ?? null,input.note ?? '',actor.actorType,actor.sourceSessionId,actor.sourceEventId,now);
      await tx.run('UPDATE margin_projects SET last_checkpoint_id=?,updated_at=? WHERE id=?',id,now,input.workstreamId);
      if (input.runId) await tx.run('UPDATE margin_runs SET checkpoint_id=?,updated_at=? WHERE id=?',id,now,input.runId);
      const replayEvidence=await evidence(tx,{operation:'checkpoint_create',requestId:input.requestId,actor,workstreamId:input.workstreamId,entityType:'checkpoint',entityId:id,version:1,eventType:'created',input});
      return {data:await tx.get('SELECT * FROM margin_checkpoints WHERE id=?',id),...replayEvidence};
    }),
    latestCheckpoint: (runId) => store.db.get('SELECT * FROM margin_checkpoints WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1',runId),
    latestCheckpointFor: ({ workstreamId, runId } = {}) => {
      if (!workstreamId) throw new CoreContractError('invalid_request', 'workstreamId is required');
      return runId
        ? store.db.get('SELECT * FROM margin_checkpoints WHERE workstream_id=? AND run_id=? ORDER BY created_at DESC,id DESC LIMIT 1', workstreamId, runId)
        : store.db.get('SELECT * FROM margin_checkpoints WHERE workstream_id=? ORDER BY created_at DESC,id DESC LIMIT 1', workstreamId);
    },
    listRuns: async (input = {}) => {
      const page = pageInput(input); const where = listWhere({ ...input, cursor: page.cursor });
      return nextPage(await store.db.all(`SELECT * FROM margin_runs ${where.clause} ORDER BY updated_at DESC,id DESC LIMIT ?`, ...where.values, page.limit + 1), page.limit);
    },
    listArtifacts: async (input = {}) => {
      const page = pageInput(input); const where = listWhere({ ...input, cursor: page.cursor });
      return nextPage(await store.db.all(`SELECT * FROM margin_artifacts ${where.clause} ORDER BY updated_at DESC,id DESC LIMIT ?`, ...where.values, page.limit + 1), page.limit);
    },
    listDecisions: async (input = {}) => {
      const page = pageInput(input); const where = listWhere({ ...input, cursor: page.cursor }, { workstream: 'project_id' });
      return nextPage(await store.db.all(`SELECT * FROM margin_decisions ${where.clause} ORDER BY updated_at DESC,id DESC LIMIT ?`, ...where.values, page.limit + 1), page.limit);
    },
    listNeedsOwner: async (input = {}) => {
      const page = pageInput(input); const where = listWhere({ ...input, cursor: page.cursor });
      return nextPage(await store.db.all(`SELECT * FROM margin_needs_owner ${where.clause} ORDER BY updated_at DESC,id DESC LIMIT ?`, ...where.values, page.limit + 1), page.limit);
    },
    getNeedsOwner: (id) => store.db.get('SELECT * FROM margin_needs_owner WHERE id=?', id),
    createNeedsOwner: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'needs_owner_create', input.requestId, 'margin_needs_owner', input, actor);
      if (prior) return prior;
      const workstream = await tx.get('SELECT id FROM margin_projects WHERE id=? AND deleted_at IS NULL', input.workstreamId);
      if (!workstream) throw new CoreContractError('workstream_not_found', 'Workstream not found');
      if (input.runId) {
        const run = await tx.get('SELECT workstream_id FROM margin_runs WHERE id=?', input.runId);
        if (!run || run.workstream_id !== input.workstreamId) throw new CoreContractError('cross_workstream_reference', 'Run belongs to another Workstream');
      }
      const optionIds = Array.isArray(input.options) ? input.options.map((option) => option?.id) : [];
      if (!['decision', 'approval', 'input', 'conflict'].includes(input.type) || !input.reason?.trim() || !Array.isArray(input.options) ||
        input.options.length > 10 || optionIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) ||
        new Set(optionIds).size !== optionIds.length) throw new CoreContractError('invalid_request', 'Valid NeedsOwner input is required');
      const id = store.idFactory('needs-owner'); const now = store.clock();
      await tx.run(
        `INSERT INTO margin_needs_owner
         (id,workstream_id,run_id,type,reason,options,consequence_summary,context_summary,status,resolution,version,source_session_id,source_event_id,created_at,updated_at,resolved_at)
         VALUES (?,?,?,?,?,?,?,?,'open',NULL,1,?,?,?, ?,NULL)`,
        id,input.workstreamId,input.runId ?? null,input.type,input.reason,json(input.options),input.consequenceSummary ?? null,input.contextSummary ?? null,
        actor.sourceSessionId,actor.sourceEventId,now,now
      );
      const replayEvidence = await evidence(tx, { operation: 'needs_owner_create', requestId: input.requestId, actor, workstreamId: input.workstreamId, entityType: 'needs_owner', entityId: id, version: 1, eventType: 'created', input, status: 'open' });
      return { data: await tx.get('SELECT * FROM margin_needs_owner WHERE id=?', id), ...replayEvidence };
    }),
    resolveNeedsOwner: (input, actor) => mutation(actor, async (tx) => {
      const prior = await replay(tx, 'needs_owner_resolve', input.requestId, 'margin_needs_owner', input, actor);
      if (prior) return prior;
      const current = await tx.get('SELECT * FROM margin_needs_owner WHERE id=?', input.needsOwnerId);
      if (!current) throw new CoreContractError('not_found', 'NeedsOwner not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      if (current.status !== 'open') throw new CoreContractError('invalid_transition', 'NeedsOwner is not open');
      const options = storedNeedsOwnerOptions(current.options);
      const optionId = input.optionId ?? null;
      if ((options.length > 0 && optionId === null) ||
        (optionId !== null && !options.some((option) => option.id === optionId))) {
        throw new CoreContractError('invalid_request', 'A valid NeedsOwner optionId is required');
      }
      const resolution = JSON.stringify({
        optionId,
        summary: input.resolutionSummary ?? input.resolution ?? null
      });
      const now = store.clock(); const nextVersion = current.version + 1;
      await tx.run(
        `UPDATE margin_needs_owner SET status='resolved',resolution=?,version=?,source_session_id=?,source_event_id=?,updated_at=?,resolved_at=? WHERE id=?`,
        resolution,nextVersion,actor.sourceSessionId,actor.sourceEventId,now,now,current.id
      );
      const replayEvidence = await evidence(tx, { operation: 'needs_owner_resolve', requestId: input.requestId, actor, workstreamId: current.workstream_id, entityType: 'needs_owner', entityId: current.id, version: nextVersion, eventType: 'updated', input, status: 'resolved' });
      return { data: await tx.get('SELECT * FROM margin_needs_owner WHERE id=?', current.id), ...replayEvidence };
    }),
    listMemories: async (input = {}) => {
      const { workstreamId, lifecycleStatuses, limit = 50 } = input;
      if (!workstreamId) throw new CoreContractError('invalid_request', 'workstreamId is required');
      const clauses = ['project_id=?', 'deleted_at IS NULL'];
      const values = [workstreamId];
      if (lifecycleStatuses && lifecycleStatuses.length) {
        const statusClauses = lifecycleStatuses.map((s) => {
          if (s === 'candidate') return "(confirmation_status='proposed')";
          if (s === 'active') return "(confirmation_status='confirmed' AND archived_at IS NULL AND superseded_by IS NULL)";
          if (s === 'archive') return "(archived_at IS NOT NULL OR superseded_by IS NOT NULL)";
          throw new CoreContractError('invalid_request', `Unknown lifecycle status: ${s}`);
        });
        clauses.push(`(${statusClauses.join(' OR ')})`);
      }
      const lim = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
      const rows = await store.db.all(
        `SELECT * FROM margin_memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT ?`,
        ...values, lim
      );
      return { items: rows };
    },
    searchMemories: async (input = {}) => {
      const { workstreamId, query, includeArchive = false, asOf, limit = 10 } = input;
      if (!workstreamId) throw new CoreContractError('invalid_request', 'workstreamId is required');
      const asOfVal = asOf ?? store.clock();
      const lim = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 10;
      let sql = `SELECT * FROM margin_memories WHERE project_id=? AND confirmation_status='confirmed' AND deleted_at IS NULL AND superseded_by IS NULL AND valid_from<=? AND (expires_at IS NULL OR expires_at>?)`;
      const values = [workstreamId, asOfVal, asOfVal];
      if (!includeArchive) { sql += ' AND archived_at IS NULL'; }
      const rows = await store.db.all(sql + ' ORDER BY updated_at DESC,id DESC LIMIT ?', ...values, lim);
      const ranked = query ? await store.rankMemories(rows, { query, asOf: asOfVal, topK: lim }) : rows;
      return { items: ranked };
    },
    confirmMemory: (input, actor) => mutation(actor, async (tx) => {
      const operation = 'memory_confirm';
      const prior = await replay(tx, operation, input.requestId, 'margin_memories', input, actor);
      if (prior) return prior;
      const current = await tx.get('SELECT * FROM margin_memories WHERE id=?', input.memoryId);
      if (!current || current.project_id !== input.workstreamId) throw new CoreContractError('not_found', 'Memory not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const now = store.clock(); const nextVersion = current.version + 1;
      await tx.run('UPDATE margin_memories SET confirmation_status=?,version=?,source_session_id=?,source_event_id=?,updated_at=? WHERE id=?', 'confirmed', nextVersion, actor.sourceSessionId, actor.sourceEventId, now, current.id);
      await evidence(tx, { operation, requestId: input.requestId, actor, workstreamId: input.workstreamId, entityType: 'memory', entityId: current.id, version: nextVersion, eventType: 'updated', input, status: 'confirmed' });
      return { data: await tx.get('SELECT * FROM margin_memories WHERE id=?', current.id) };
    }),
    correctMemory: (input, actor) => mutation(actor, async (tx) => {
      const operation = 'memory_correct';
      const prior = await replay(tx, operation, input.requestId, 'margin_memories', input, actor);
      if (prior) return prior;
      const current = await tx.get('SELECT * FROM margin_memories WHERE id=?', input.memoryId);
      if (!current || current.project_id !== input.workstreamId) throw new CoreContractError('not_found', 'Memory not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const now = store.clock();
      const successorId = store.idFactory('memory');
      await tx.run(
        `INSERT INTO margin_memories (id,project_id,task_id,content,memory_type,confidence,confirmation_status,valid_from,expires_at,superseded_by,version,source_session_id,source_event_id,created_at,updated_at,deleted_at,archived_at)
         VALUES (?,?,?,?,?,?,'confirmed',?,?,NULL,1,?,?,?,?,NULL,NULL)`,
        successorId, current.project_id, current.task_id, input.content, input.memoryType, input.confidence, input.validFrom ?? now, input.expiresAt ?? null, actor.sourceSessionId, actor.sourceEventId, now, now
      );
      await tx.run('UPDATE margin_memories SET superseded_by=?,version=version+1,updated_at=? WHERE id=?', successorId, now, current.id);
      await evidence(tx, { operation, requestId: input.requestId, actor, workstreamId: input.workstreamId, entityType: 'memory', entityId: current.id, version: current.version + 1, eventType: 'superseded', input });
      await evidence(tx, { operation, requestId: `${input.requestId}_created`, actor, workstreamId: input.workstreamId, entityType: 'memory', entityId: successorId, version: 1, eventType: 'created', input });
      return { data: await tx.get('SELECT * FROM margin_memories WHERE id=?', successorId) };
    }),
    archiveMemory: (input, actor) => mutation(actor, async (tx) => {
      const operation = 'memory_archive';
      const prior = await replay(tx, operation, input.requestId, 'margin_memories', input, actor);
      if (prior) return prior;
      const current = await tx.get('SELECT * FROM margin_memories WHERE id=?', input.memoryId);
      if (!current || current.project_id !== input.workstreamId) throw new CoreContractError('not_found', 'Memory not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const now = store.clock(); const nextVersion = current.version + 1;
      await tx.run('UPDATE margin_memories SET archived_at=?,version=?,updated_at=? WHERE id=?', now, nextVersion, now, current.id);
      await evidence(tx, { operation, requestId: input.requestId, actor, workstreamId: input.workstreamId, entityType: 'memory', entityId: current.id, version: nextVersion, eventType: 'updated', input });
      return { data: await tx.get('SELECT * FROM margin_memories WHERE id=?', current.id) };
    }),
    restoreMemory: (input, actor) => mutation(actor, async (tx) => {
      const operation = 'memory_restore';
      const prior = await replay(tx, operation, input.requestId, 'margin_memories', input, actor);
      if (prior) return prior;
      const current = await tx.get('SELECT * FROM margin_memories WHERE id=?', input.memoryId);
      if (!current || current.project_id !== input.workstreamId) throw new CoreContractError('not_found', 'Memory not found');
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      if (current.superseded_by) throw new CoreContractError('invalid_request', 'Cannot restore a superseded Memory');
      const now = store.clock(); const nextVersion = current.version + 1;
      await tx.run('UPDATE margin_memories SET archived_at=NULL,version=?,updated_at=? WHERE id=?', nextVersion, now, current.id);
      await evidence(tx, { operation, requestId: input.requestId, actor, workstreamId: input.workstreamId, entityType: 'memory', entityId: current.id, version: nextVersion, eventType: 'restored', input });
      return { data: await tx.get('SELECT * FROM margin_memories WHERE id=?', current.id) };
    }),
    findSwitchReplay: async (input, actor) => {
      const audit = await store.db.get("SELECT id, operation, entity_id, actor_type, input_digest, metadata FROM margin_audit_log WHERE request_id=? AND result_code='allowed' AND operation='workstream_switch' ORDER BY created_at LIMIT 1", input.requestId);
      if (!audit) return null;
      let meta; try { meta = JSON.parse(audit.metadata || '{}'); } catch { return null; }
      if (audit.input_digest !== digestInput(input)) throw new CoreContractError('idempotency_conflict', 'Request ID was already used with different input or actor');
      return { sourceRunId: meta.sourceRunId ?? audit.entity_id };
    },
    recordSwitchResult: async (input, actor, sourceRunId) => {
      const now = store.clock();
      const auditId = store.idFactory('audit');
      await store.db.run(
        `INSERT INTO margin_audit_log (id,operation,request_id,actor_type,project_id,entity_type,entity_id,permission_decision,result_code,input_digest,metadata,created_at)
         VALUES (?,?,?,?,?,?,?,'allowed','allowed',?,?,?)`,
        auditId, 'workstream_switch', input.requestId, actor.actorType, input.sourceWorkstreamId, 'workstream', sourceRunId, digestInput(input),
        JSON.stringify({ actorSubjectId: actor.subjectId ?? null, sourceRunId }), now
      );
      return auditId;
    },
    listRecentEventRows: async (workstreamId, limit = 20) => {
      const lim = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
      return store.db.all('SELECT * FROM margin_events WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?', workstreamId, lim);
    },
    listEventRows: async ({ workstreamId, afterCursor = 0, limit = 50 } = {}) => {
      if (!Number.isInteger(afterCursor) || afterCursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CoreContractError('invalid_request', 'Valid event cursor and limit are required');
      const filters = ['c.sequence>?']; const values = [afterCursor];
      if (workstreamId) { filters.push('e.project_id=?'); values.push(workstreamId); }
      const rows = await store.db.all(
        `SELECT c.sequence,c.event_id,e.*,a.actor_type AS audit_actor_type,a.metadata AS audit_metadata
         FROM margin_event_cursors c JOIN margin_events e ON e.id=c.event_id
         LEFT JOIN margin_audit_log a ON a.id=(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.auditId') END)
           AND a.result_code='allowed' AND a.entity_type=e.entity_type AND a.entity_id=e.entity_id AND a.project_id IS e.project_id
           -- The audit operation IS the recorded command, so it is read directly. This used to be a
           -- hand-maintained CASE listing every command by name; a command missing from that list made
           -- the join silently fail (the row kept its event but lost its audit columns) instead of
           -- raising anything. Every branch mapped a value to itself, so removing the list is exactly
           -- equivalent for the commands it covered and correct for any command added later.
           AND a.operation=(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.command') END)
         WHERE ${filters.join(' AND ')} ORDER BY c.sequence ASC LIMIT ?`,
        ...values, limit + 1
      );
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: items.length ? items.at(-1).sequence : afterCursor,
        hasMore: rows.length > limit
      };
    }
  };
}

function mapWorkstream(row) {
  if (!row) return null;
  return { ...row, status: row.workstream_status, currentPlan: JSON.parse(row.current_plan), blockers: JSON.parse(row.blockers), dependencies: JSON.parse(row.dependencies), artifactRefs: JSON.parse(row.artifact_refs) };
}
