import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createMarginCore } from '../createMarginCore.js';

const DEFAULT_DB_PATH = path.join('data', 'terminal-pilot', 'margin-core.sqlite');

// The host owns both contexts. The Board receives only this Contract-backed reader,
// never a repository or a writable Core object.
export async function createRunBindingReader({ rootDir = path.resolve('.'), env = process.env, dbPath, openCore = createMarginCore } = {}) {
  const resolvedDbPath = path.resolve(rootDir, dbPath ?? env.MARGIN_CORE_DB_PATH ?? DEFAULT_DB_PATH);
  await mkdir(path.dirname(resolvedDbPath), { recursive: true });
  const core = await openCore({ enabled: true, dbPath: resolvedDbPath });
  const contract = core.createApplicationContract({});
  let closed = false;
  return Object.freeze({
    async resolveRuns(canonicalSessionIds) {
      if (closed) return [];
      const ids = [...new Set(canonicalSessionIds.filter((id) => typeof id === 'string' && id))];
      const items = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const requestId = `board_resolve_${randomUUID()}`;
        const context = core.bindHostContext({
          actor: { type: 'user', subjectId: 'local-board-user' },
          surface: { kind: 'web', instanceId: 'margin-board' },
          requestId, correlationId: requestId, capabilities: ['run:read'],
        });
        const result = await contract.query({
          type: 'session.resolve_runs', requestId, payload: { canonicalSessionIds: ids.slice(offset, offset + 100) },
        }, context);
        if (!result?.ok) throw new Error(result?.error?.code ?? 'run_binding_read_failed');
        items.push(...result.data.items);
      }
      return items;
    },
    async close() {
      if (closed) return;
      closed = true;
      await core.close();
    },
  });
}
