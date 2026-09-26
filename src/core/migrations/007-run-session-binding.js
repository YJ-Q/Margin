import { createHash } from 'node:crypto';

// The Session ↔ Run bridge (ADR 003).
//
// A Run already carries a `runtime_reference` (kind + runtime session id). What it could not express
// was which *agent session* the work came from — the Board reads sessions from the agents' own files,
// the Core owns Runs, and nothing joined them. This column is that join, and it is deliberately
// nullable: an unbound Run is the normal state, not an error.
//
// The index is UNIQUE over the bound rows only (`WHERE ... IS NOT NULL`, a SQLite partial index), so
// any number of Runs may be unbound while one agent session belongs to at most one Run. Enforcing it
// in the schema rather than in a service is what makes "which Run is this session?" a single-valued
// question with no tie to break.
const sql = `
ALTER TABLE margin_runs ADD COLUMN runtime_session_canonical_id TEXT;
CREATE UNIQUE INDEX margin_run_session_binding
  ON margin_runs(runtime_session_canonical_id) WHERE runtime_session_canonical_id IS NOT NULL;
`;

export const RUN_SESSION_BINDING_MIGRATION = Object.freeze({
  version: 7,
  name: 'run-session-binding',
  sql,
  checksum: createHash('sha256').update(sql).digest('hex')
});
