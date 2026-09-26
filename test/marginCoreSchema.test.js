import test from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createMarginCoreTestDb } from './helpers/marginCoreTestDb.js';
import { openMarginCoreStore } from '../src/core/marginCoreStore.js';
import { MARGIN_CORE_MIGRATIONS } from '../src/core/migrations/001-margin-core.js';

const TABLES = [
  'margin_schema_migrations', 'margin_projects', 'margin_tasks', 'margin_decisions',
  'margin_memories', 'margin_memory_embeddings', 'margin_events', 'margin_actions', 'margin_audit_log',
  'margin_runs', 'margin_artifacts', 'margin_checkpoints', 'margin_needs_owner', 'margin_event_cursors'
];

test('migration creates exactly the additive Margin Core tables and preserves legacy tables', async (t) => {
  const fixture = await createMarginCoreTestDb();
  t.after(() => fixture.cleanup());
  await fixture.store.db.exec('CREATE TABLE conversations (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO conversations(body) VALUES (\'legacy\');');
  await fixture.store.migrate();
  const names = (await fixture.store.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'margin_%' ORDER BY name"))
    .map((row) => row.name);
  assert.deepEqual(names, [...TABLES].sort());
  assert.equal((await fixture.store.db.get('SELECT body FROM conversations')).body, 'legacy');
  assert.equal((await fixture.store.db.get('PRAGMA foreign_keys')).foreign_keys, 1);
});

test('migration is idempotent and checksum-bound', async (t) => {
  const fixture = await createMarginCoreTestDb();
  t.after(() => fixture.cleanup());
  await fixture.store.migrate();
  // Derived from the declared migrations: the assertion is "every migration was recorded", not a count
  // that has to be edited every time one is added.
  assert.equal((await fixture.store.db.get('SELECT COUNT(*) count FROM margin_schema_migrations')).count, MARGIN_CORE_MIGRATIONS.length);
  await fixture.store.db.run("UPDATE margin_schema_migrations SET checksum = 'drift' WHERE version = 1");
  await assert.rejects(fixture.store.migrate(), /checksum mismatch/u);
});

test('foreign keys and one-active-task-per-project are enforced', async (t) => {
  const fixture = await createMarginCoreTestDb();
  t.after(() => fixture.cleanup());
  const now = '2026-08-20T00:00:00.000Z';
  await fixture.store.db.run(
    `INSERT INTO margin_projects
     (id, scenario, goal, phase, status, version, source_session_id, source_event_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'p1', 'learning_research', 'goal', 'phase', 'active', 1, 's1', 'e1', now, now, null
  );
  const task = ['t1', 'p1', 'title', 'step', null, 'done', 'active', 1, 's1', 'e1', now, now, null];
  await fixture.store.db.run('INSERT INTO margin_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...task);
  await assert.rejects(
    fixture.store.db.run('INSERT INTO margin_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...['t2', ...task.slice(1)]),
    /UNIQUE/u
  );
  await assert.rejects(
    fixture.store.db.run('INSERT INTO margin_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...['t3', 'missing', ...task.slice(2)]),
    /FOREIGN KEY/u
  );
});

test('recorded migration name drift is rejected on open', async (t) => {
  const fixture = await createMarginCoreTestDb();
  const dbPath = fixture.dbPath;
  await fixture.store.db.run("UPDATE margin_schema_migrations SET name = 'renamed' WHERE version = 1");
  await fixture.store.close();
  t.after(() => fixture.cleanup().catch(() => {}));
  await assert.rejects(openMarginCoreStore({ dbPath }), /migration identity mismatch/u);
  const raw = await open({ filename: dbPath, driver: sqlite3.Database });
  await raw.close();
});
