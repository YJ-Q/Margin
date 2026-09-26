import { CoreContractError } from '../core/contracts.js';
import { transitionRun } from '../domain/run.js';

export function createRunService({ repository, authorization }) {
  const authorize = (actor) => {
    if (actor?.actorType !== 'user' || authorization?.(actor) !== true) throw new CoreContractError('permission_denied','Run control is host-user owned');
  };
  const control = async (command, input, actor, runtimeControl) => {
    authorize(actor);
    if (!input?.requestId || !input?.runId || !Number.isInteger(input.expectedVersion)) throw new CoreContractError('invalid_request','Valid Run control input is required');
    const result = await repository.coordinateRunTransition(
      { ...input, command, requestInput: input },
      actor,
      async (current) => {
        if (!runtimeControl?.activate || !runtimeControl?.halt) throw new CoreContractError('runtime_control_required','Host runtime control is required');
        let status;
        try { status=transitionRun(current,{type:command}).status; }
        catch (error) {
          if (error?.code === 'invalid_run_transition') throw new CoreContractError('invalid_transition','Invalid Run transition');
          throw error;
        }
        const descriptor = Object.freeze({
          operation: `run.${command}`,
          key: input.requestId,
          runtimeReference: current.runtime_session_id
            ? Object.freeze({ kind: current.runtime_kind, id: current.runtime_session_id })
            : null
        });
        if (command==='start' || command==='resume') {
          const activated=await runtimeControl.activate(current, descriptor);
          return {status,runtimeSessionId:activated?.runtimeSessionId,checkpoint:false};
        }
        await runtimeControl.halt(current, descriptor);
        return {status,checkpoint:['pause','stop','complete'].includes(command)};
      }
    );
    return {ok:true,...result};
  };
  return {
    async create(input, actor) {
      authorize(actor);
      if (!input?.requestId || !input?.workstreamId || !input?.scope?.trim() || !input?.runtimeKind) throw new CoreContractError('invalid_request','Valid Run input is required');
      return { ok: true, ...await repository.createRun(input, actor) };
    },
    async get(id) {
      if (typeof id !== 'string' || !id.trim()) throw new CoreContractError('invalid_request','runId is required');
      return repository.getRun(id);
    },
    findOpen: repository.findOpenRun,
    async list(input = {}) {
      if (!input.workstreamId || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))) throw new CoreContractError('invalid_request','Valid Run list input is required');
      return repository.listRuns(input);
    },
    start: (input,actor,runtime) => control('start',input,actor,runtime),
    pause: (input,actor,runtime) => control('pause',input,actor,runtime),
    resume: (input,actor,runtime) => control('resume',input,actor,runtime),
    stop: (input,actor,runtime) => control('stop',input,actor,runtime),
    complete: (input,actor,runtime) => control('complete',input,actor,runtime),
    // Session ↔ Run bridge (ADR 003). Host-user owned like every other Run mutation: it asserts which
    // real agent session a Run corresponds to, and an agent must not be able to claim that about
    // itself. `sessionCanonicalId: null` unbinds an existing binding.
    async bindSession(input, actor) {
      authorize(actor);
      if (!input?.requestId || !input?.runId || !Number.isInteger(input.expectedVersion)) throw new CoreContractError('invalid_request','Valid Run session binding input is required');
      const sessionCanonicalId = input.sessionCanonicalId ?? null;
      if (sessionCanonicalId !== null && (typeof sessionCanonicalId !== 'string' || !sessionCanonicalId.trim())) {
        throw new CoreContractError('invalid_request','sessionCanonicalId must be a non-empty string or null');
      }
      return { ok: true, ...await repository.bindRunSession({ ...input, sessionCanonicalId, requestInput: input }, actor) };
    },
    // Read side of the bridge. Returns raw rows; the Contract owns the DTO shape.
    async resolveSessions(input = {}) {
      if (!Array.isArray(input.canonicalSessionIds)) throw new CoreContractError('invalid_request','canonicalSessionIds must be an array');
      if (input.canonicalSessionIds.length > 100) throw new CoreContractError('invalid_request','At most 100 session ids may be resolved at once');
      return { items: await repository.resolveRunsByCanonicalSessions(input.canonicalSessionIds) };
    }
  };
}
