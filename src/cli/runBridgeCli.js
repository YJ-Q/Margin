import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMarginCore } from '../core/createMarginCore.js';

// `margin run` — the command surface for the Session ↔ Run bridge (ADR 003).
//
// This is a HOST: it owns a Core, so it is allowed to bind host authority and drive the Application
// Contract. It deliberately does not touch the repository directly — the same path a Surface takes —
// so the bridge cannot grow a second, ungoverned write route.
//
// Capability strings are declared here rather than imported from the HTTP surface, because a wrong
// string fails closed (`capability_required`) and coupling a CLI to the web layer to reuse two
// constants would be the worse trade. They must match the Contract's own mapping.
const CAPABILITIES = Object.freeze({ 'run.bind_session': 'run:control', 'session.resolve_runs': 'run:read' });

const write = (stream, text) => stream.write(`${text}\n`);
const flagValue = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

export async function runRunBridgeCli(argv, {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  core: injectedCore = null,
  dbPath,
  requestIdFactory = () => `cli_${randomUUID()}`,
} = {}) {
  const command = argv[0];
  if (!['bind', 'unbind', 'resolve'].includes(command)) {
    write(stderr, 'Usage: margin run <bind <runId> <sessionCanonicalId> | unbind <runId> | resolve <sessionCanonicalId...>> [--request-id <id>] [--version <n>]');
    return 1;
  }

  let core = injectedCore;
  let owned = false;
  try {
    if (!core) {
      core = await createMarginCore({ enabled: true, dbPath: path.resolve(dbPath ?? env.MARGIN_CORE_DB_PATH ?? path.join('data', 'terminal-pilot', 'margin-core.sqlite')) });
      owned = true;
    }
    const contract = core.createApplicationContract({});
    // Both ids are derived from one value so a retry with the same `--request-id` replays instead of
    // appending a second mutation.
    const call = async (method, type, payload, capability, { expectedVersion } = {}) => {
      const requestId = flagValue(argv, '--request-id') ?? requestIdFactory();
      // Commands and queries are different closed shapes: a command requires `idempotencyKey` and may
      // carry `expectedVersion`, while a query accepts neither. Sending one shape to the other is
      // rejected by validation, so the shape is chosen by method rather than shared.
      const request = method === 'execute'
        ? { type, requestId, idempotencyKey: requestId, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) }
        : { type, requestId, payload };
      const context = core.bindHostContext({
        actor: { type: 'user', subjectId: 'local-cli-user' },
        surface: { kind: 'cli', instanceId: 'margin-cli' },
        requestId,
        correlationId: requestId,
        capabilities: [capability],
      });
      const result = await contract[method](request, context);
      if (!result?.ok) throw Object.assign(new Error(result?.error?.message ?? result?.error?.code ?? 'contract_failure'), { code: result?.error?.code });
      return result.data;
    };

    if (command === 'resolve') {
      const ids = argv.slice(1).filter((value) => !value.startsWith('--'));
      const previousFlag = flagValue(argv, '--request-id');
      const requested = ids.filter((value) => value !== previousFlag);
      if (!requested.length) { write(stderr, 'Usage: margin run resolve <sessionCanonicalId...>'); return 1; }
      const { items } = await call('query', 'session.resolve_runs', { canonicalSessionIds: requested }, CAPABILITIES['session.resolve_runs']);
      const bySession = new Map(items.map((item) => [item.canonicalSessionId, item]));
      for (const canonicalSessionId of requested) {
        const binding = bySession.get(canonicalSessionId);
        write(stdout, binding
          ? `${canonicalSessionId}\t${binding.runId}\t${binding.workstreamId}\t${binding.status}`
          : `${canonicalSessionId}\t-\t-\tunbound`);
      }
      return 0;
    }

    const runId = argv[1];
    if (!runId || runId.startsWith('--')) { write(stderr, `Usage: margin run ${command} <runId>${command === 'bind' ? ' <sessionCanonicalId>' : ''}`); return 1; }
    const sessionCanonicalId = command === 'bind' ? argv[2] : null;
    if (command === 'bind' && (!sessionCanonicalId || sessionCanonicalId.startsWith('--'))) {
      write(stderr, 'Usage: margin run bind <runId> <sessionCanonicalId>');
      return 1;
    }

    // The version is read rather than asked for: a CLI caller has a Run id, not a version, and making
    // them look one up first would just be an extra step to get wrong. `--version` still overrides for
    // a caller that already knows it (and wants the optimistic-concurrency check to be meaningful).
    const override = flagValue(argv, '--version');
    let expectedVersion = override === undefined ? undefined : Number(override);
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
      write(stderr, 'Error: --version must be a positive integer');
      return 1;
    }
    if (expectedVersion === undefined) {
      const current = await call('query', 'run.get', { runId }, 'run:read');
      if (!current) { write(stderr, `Error: run not found: ${runId}`); return 1; }
      expectedVersion = current.version;
    }

    const run = await call('execute', 'run.bind_session', { runId, sessionCanonicalId }, CAPABILITIES['run.bind_session'], { expectedVersion });
    // The binding lives in the Run's runtimeReference, so report it from the DTO the Contract returned
    // rather than from what was sent — a caller must be able to see what was actually stored.
    const binding = run.runtimeReference?.canonicalSessionId ?? null;
    write(stdout, binding
      ? `Bound ${binding} -> ${run.id} (workstream ${run.workstreamId}, version ${run.version})`
      : `Unbound ${run.id} (workstream ${run.workstreamId}, version ${run.version})`);
    return 0;
  } catch (error) {
    write(stderr, `Error: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? 'run bridge failed'}`);
    return 1;
  } finally {
    if (owned) await core?.close?.().catch(() => {});
  }
}
