import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createMarginCoreTestDb } from './helpers/marginCoreTestDb.js';
import { MARGIN_CORE_MIGRATIONS } from '../src/core/migrations/001-margin-core.js';
import { PERSISTENT_WORK_MIGRATION } from '../src/core/migrations/003-persistent-work.js';
import { createMarginCore } from '../src/core/createMarginCore.js';
import { createTerminalPilotController } from '../src/pilot/terminalPilotController.js';

const legacyContext = {
  requestId: 'legacy-create', actorType: 'user', sourceSessionId: 'legacy-session',
  sourceEventId: 'legacy-event', inputDigest: 'a'.repeat(64), permissionDecision: 'allowed'
};

function readContext(requestId) {
  return {
    actor: { type: 'user', subjectId: 'legacy-upgrade-test' },
    surface: { kind: 'cli', instanceId: 'legacy-upgrade-test' },
    requestId,
    correlationId: 'legacy-upgrade-correlation',
    capabilities: ['workstream:read']
  };
}

function terminalCore(core) {
  return {
    createApplicationContract: core.createApplicationContract,
    bindHostContext: core.bindHostContext,
    continuity: core.continuity,
    v1Tools: core.v1Tools,
    confirmMemory: core.confirmMemory
  };
}

function terminalRuntime() {
  let sequence = 0;
  return {
    async createSession() {
      return {
        id: `legacy-session-${++sequence}`,
        async send() { return { text: 'ok', toolResults: [] }; },
        async close() {}
      };
    },
    async haltSession() {},
    async close() {}
  };
}

async function createPopulatedLegacyDatabase(schemaVersion) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `margin-v${schemaVersion}-upgrade-`));
  const dbPath = path.join(directory, 'legacy.sqlite');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  const appliedAt = '2026-08-23T00:00:00.000Z';
  for (const migration of MARGIN_CORE_MIGRATIONS.slice(0, schemaVersion)) {
    await db.exec(migration.sql);
    await db.run(
      'INSERT INTO margin_schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)',
      migration.version, migration.name, migration.checksum, appliedAt
    );
  }
  const workstreamId = `legacy-v${schemaVersion}`;
  const goal = `Legacy goal from v${schemaVersion}`;
  await db.run(
    `INSERT INTO margin_projects
     (id,scenario,goal,phase,status,version,source_session_id,source_event_id,created_at,updated_at,deleted_at)
     VALUES (?, 'career_project', ?, 'legacy', 'active', 1, 'legacy-session', 'legacy-event', ?, ?, NULL)`,
    workstreamId, goal, appliedAt, appliedAt
  );
  await db.close();
  return { directory, dbPath, workstreamId, goal };
}

test('migration 3 adds persistent work tables and workstream fields', async () => {
  const fixture = await createMarginCoreTestDb();
  try {
    const tables = (await fixture.store.db.all("SELECT name FROM sqlite_master WHERE type='table'")).map((row) => row.name);
    for (const name of ['margin_runs', 'margin_artifacts', 'margin_checkpoints']) assert.equal(tables.includes(name), true, name);
    const columns = (await fixture.store.db.all('PRAGMA table_info(margin_projects)')).map((row) => row.name);
    for (const name of ['title', 'workstream_status', 'current_plan', 'next_action', 'blockers', 'dependencies', 'workspace_path', 'autonomy_level', 'artifact_refs', 'last_checkpoint_id']) {
      assert.equal(columns.includes(name), true, name);
    }
    // Derived from the declared migrations rather than restated, so adding one does not require editing
  // this test — the assertion is about "every declared migration was applied", not about the count.
  assert.deepEqual((await fixture.store.getSchemaEvidence()).map((row) => row.version), MARGIN_CORE_MIGRATIONS.map((migration) => migration.version));
  } finally {
    await fixture.cleanup();
  }
});

test('legacy createProject derives a bounded non-empty Workstream title from title or goal', async () => {
  const fixture = await createMarginCoreTestDb();
  try {
    const fromGoal = await fixture.store.createProject({
      scenario: 'career_project', goal: 'Legacy goal title', phase: 'legacy'
    }, legacyContext);
    const fromBlankTitle = await fixture.store.createProject({
      scenario: 'learning_research', title: '   ', goal: 'Fallback goal title', phase: 'legacy'
    }, { ...legacyContext, requestId: 'legacy-create-blank', sourceEventId: 'legacy-event-blank' });
    assert.equal(fromGoal.title, 'Legacy goal title');
    assert.equal(fromBlankTitle.title, 'Fallback goal title');
  } finally { await fixture.cleanup(); }
});

test('populated v1 v2 and v3 databases upgrade one Workstream through Gateway and CLI restart', async (t) => {
  for (const schemaVersion of [1, 2, 3]) {
    await t.test(`v${schemaVersion} populated upgrade`, async () => {
      const legacy = await createPopulatedLegacyDatabase(schemaVersion);
      const registry = {
        value: legacy.workstreamId,
        async load() { return this.value; },
        async save(value) { this.value = value; }
      };
      let ids = 0;
      const options = {
        enabled: true,
        dbPath: legacy.dbPath,
        clock: () => '2026-08-24T00:00:00.000Z',
        idFactory: (kind = 'id') => `upgrade-v${schemaVersion}-${kind}-${++ids}`
      };
      let core = await createMarginCore(options);
      try {
        const requestId = `read-v${schemaVersion}`;
        const queried = await core.createApplicationContract().query(
          { type: 'workstream.get', requestId, payload: { workstreamId: legacy.workstreamId } },
          readContext(requestId)
        );
        assert.equal(queried.ok, true);
        assert.equal(queried.data.id, legacy.workstreamId);
        assert.equal(queried.data.title, legacy.goal);
        assert.equal(queried.data.version, 1);

        let controller = createTerminalPilotController({
          core: terminalCore(core), runtime: terminalRuntime(), registry,
          clock: options.clock, idFactory: options.idFactory
        });
        const started = await controller.start();
        assert.equal(started.projectId, legacy.workstreamId);
        await controller.close();
        await core.close();

        core = await createMarginCore(options);
        controller = createTerminalPilotController({
          core: terminalCore(core), runtime: terminalRuntime(), registry,
          clock: options.clock, idFactory: options.idFactory
        });
        const restarted = await controller.start();
        assert.equal(restarted.projectId, legacy.workstreamId);
        assert.equal(registry.value, legacy.workstreamId);
        const row = await core.store.db.get('SELECT id,title,version FROM margin_projects WHERE id=?', legacy.workstreamId);
        assert.deepEqual(row, { id: legacy.workstreamId, title: legacy.goal, version: 1 });
        await controller.close();
      } finally {
        await core.close().catch(() => {});
        await rm(legacy.directory, { recursive: true, force: true });
      }
    });
  }
});

test('Migration 004 backfills historical Event cursors by row order before trigger assignment and restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-historical-cursor-upgrade-'));
  const dbPath = path.join(directory, 'legacy.sqlite');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  const appliedAt = '2026-08-23T00:00:00.000Z';
  for (const migration of MARGIN_CORE_MIGRATIONS.slice(0, 3)) {
    await db.exec(migration.sql);
    await db.run(
      'INSERT INTO margin_schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)',
      migration.version, migration.name, migration.checksum, appliedAt
    );
  }
  await db.run(
    `INSERT INTO margin_projects
     (id,scenario,goal,phase,status,version,source_session_id,source_event_id,created_at,updated_at,deleted_at)
     VALUES ('historical-workstream','career_project','Historical cursor','legacy','active',1,'legacy','legacy',?,?,NULL)`,
    appliedAt, appliedAt
  );
  for (const eventId of ['historical-event-a', 'historical-event-b', 'historical-event-c']) {
    await db.run(
      `INSERT INTO margin_events
       (id,entity_type,entity_id,project_id,event_type,entity_version,payload,source_session_id,source_event_id,created_at)
       VALUES (?,'project','historical-workstream','historical-workstream','updated',1,'{}','legacy','legacy',?)`,
      eventId, appliedAt
    );
  }
  await db.close();

  let core = await createMarginCore({ enabled: true, dbPath });
  try {
    assert.deepEqual(
      await core.store.db.all('SELECT sequence,event_id FROM margin_event_cursors ORDER BY sequence'),
      [
        { sequence: 1, event_id: 'historical-event-a' },
        { sequence: 2, event_id: 'historical-event-b' },
        { sequence: 3, event_id: 'historical-event-c' }
      ]
    );
    await core.store.db.run(
      `INSERT INTO margin_events
       (id,entity_type,entity_id,project_id,event_type,entity_version,payload,source_session_id,source_event_id,created_at)
       VALUES ('post-migration-event','project','historical-workstream','historical-workstream','updated',2,'{}','legacy','legacy',?)`,
      appliedAt
    );
    assert.deepEqual(
      await core.store.db.get("SELECT sequence,event_id FROM margin_event_cursors WHERE event_id='post-migration-event'"),
      { sequence: 4, event_id: 'post-migration-event' }
    );
    await core.close();
    core = await createMarginCore({ enabled: true, dbPath });
    assert.deepEqual(
      (await core.store.db.all('SELECT sequence FROM margin_event_cursors ORDER BY sequence')).map((row) => row.sequence),
      [1, 2, 3, 4]
    );
  } finally {
    await core.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration 3 maps legacy project statuses into Workstream semantics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-migration-map-'));
  const db = await open({ filename: path.join(directory, 'legacy.sqlite'), driver: sqlite3.Database });
  try {
    await db.exec(MARGIN_CORE_MIGRATIONS[0].sql);
    await db.exec(MARGIN_CORE_MIGRATIONS[1].sql);
    for (const status of ['active', 'blocked', 'completed', 'archived']) {
      await db.run('INSERT INTO margin_projects VALUES (?,?,?,?,?,?,?,?,?,?,NULL)', status, 'career_project', status, 'legacy', status, 1, 'session', 'event', '2026-08-23', '2026-08-23');
    }
    await db.exec(PERSISTENT_WORK_MIGRATION.sql);
    const rows = await db.all('SELECT id,workstream_status FROM margin_projects ORDER BY id');
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.workstream_status])), {
      active: 'running', archived: 'completed', blocked: 'blocked', completed: 'completed'
    });
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});
