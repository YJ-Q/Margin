import { createHash } from 'node:crypto';
import { MEMORY_EMBEDDINGS_MIGRATION } from './002-memory-embeddings.js';
import { PERSISTENT_WORK_MIGRATION } from './003-persistent-work.js';
import { APPLICATION_CONTRACT_MIGRATION } from './004-application-contract.js';
import { LEGACY_WORKSTREAM_TITLE_MIGRATION } from './005-legacy-workstream-title.js';
import { MEMORY_LIFECYCLE_MIGRATION } from './006-memory-lifecycle.js';
import { RUN_SESSION_BINDING_MIGRATION } from './007-run-session-binding.js';

const sql = `
CREATE TABLE IF NOT EXISTS margin_schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS margin_projects (
  id TEXT PRIMARY KEY, scenario TEXT NOT NULL CHECK (scenario IN ('learning_research','career_project')),
  goal TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','blocked','completed','archived')),
  version INTEGER NOT NULL CHECK (version > 0), source_session_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS margin_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES margin_projects(id), title TEXT NOT NULL,
  current_step TEXT NOT NULL, blocker TEXT, completion_condition TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','blocked','completed','cancelled')),
  version INTEGER NOT NULL CHECK (version > 0), source_session_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS margin_one_active_task_per_project
  ON margin_tasks(project_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS margin_decisions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES margin_projects(id), task_id TEXT REFERENCES margin_tasks(id),
  decision_key TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','superseded','revoked')),
  effective_at TEXT NOT NULL, expires_at TEXT, superseded_by TEXT REFERENCES margin_decisions(id),
  version INTEGER NOT NULL CHECK (version > 0), source_session_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS margin_one_confirmed_decision
  ON margin_decisions(project_id, decision_key) WHERE status = 'confirmed';
CREATE TABLE IF NOT EXISTS margin_memories (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES margin_projects(id), task_id TEXT REFERENCES margin_tasks(id),
  content TEXT NOT NULL, memory_type TEXT NOT NULL CHECK (memory_type IN ('fact','preference','constraint','context','sensitive')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('proposed','confirmed','rejected')),
  valid_from TEXT NOT NULL, expires_at TEXT, superseded_by TEXT REFERENCES margin_memories(id),
  version INTEGER NOT NULL CHECK (version > 0), source_session_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS margin_events (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, project_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('created','updated','completed','failed','superseded','revoked','deleted','restored','confirmation_requested','confirmation_rejected')),
  entity_version INTEGER, payload TEXT NOT NULL DEFAULT '{}', source_session_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS margin_actions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES margin_projects(id), task_id TEXT REFERENCES margin_tasks(id),
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('proposed','pending_confirmation','pending','active','completed','cancelled')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('read_only','internal_write','external_write','high_risk')),
  due_at TEXT, confirmation_required INTEGER NOT NULL CHECK (confirmation_required IN (0,1)), confirmation_ref TEXT,
  version INTEGER NOT NULL CHECK (version > 0), source_session_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS margin_audit_log (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, request_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')), project_id TEXT,
  entity_type TEXT, entity_id TEXT,
  permission_decision TEXT NOT NULL CHECK (permission_decision IN ('allowed','confirmation_required','denied')),
  result_code TEXT NOT NULL, input_digest TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
`;

export const MARGIN_CORE_MIGRATIONS = Object.freeze([{
  version: 1,
  name: 'margin-core-initial',
  sql,
  checksum: createHash('sha256').update(sql).digest('hex')
}, MEMORY_EMBEDDINGS_MIGRATION, PERSISTENT_WORK_MIGRATION, APPLICATION_CONTRACT_MIGRATION, LEGACY_WORKSTREAM_TITLE_MIGRATION, MEMORY_LIFECYCLE_MIGRATION, RUN_SESSION_BINDING_MIGRATION]);
