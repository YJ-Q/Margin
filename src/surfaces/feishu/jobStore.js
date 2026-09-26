import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function createJobStore({ dbPath }) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA foreign_keys = ON');
  await migrate(db);

  // ── Applications ────────────────────────────────────────────────────────────

  async function addApplication({ company, role, jdUrl = '', status = 'applied', notes = '', feishuDocId = '' }) {
    const id = `app-${randomUUID()}`;
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO job_applications (id, company, role, jd_url, status, notes, feishu_doc_id, applied_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, company, role, jdUrl, status, notes, feishuDocId, now, now);
    return db.get('SELECT * FROM job_applications WHERE id = ?', id);
  }

  async function findApplication({ company, role } = {}) {
    if (company && role) {
      return db.get('SELECT * FROM job_applications WHERE company = ? AND role = ? ORDER BY applied_at DESC LIMIT 1', company, role);
    }
    if (company) {
      return db.get('SELECT * FROM job_applications WHERE company LIKE ? ORDER BY applied_at DESC LIMIT 1', `%${company}%`);
    }
    return null;
  }

  async function listApplications({ statuses } = {}) {
    if (statuses && statuses.length > 0) {
      const ph = statuses.map(() => '?').join(',');
      return db.all(`SELECT * FROM job_applications WHERE status IN (${ph}) ORDER BY applied_at DESC`, ...statuses);
    }
    return db.all('SELECT * FROM job_applications ORDER BY applied_at DESC');
  }

  async function updateApplication(id, fields) {
    const allowed = ['status', 'notes', 'feishu_doc_id', 'jd_url'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k));
    if (sets.length === 0) return;
    const now = new Date().toISOString();
    const sql = `UPDATE job_applications SET ${sets.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    await db.run(sql, ...sets.map(k => fields[k]), now, id);
  }

  // ── Interview records ───────────────────────────────────────────────────────

  async function addInterview({ applicationId, round = '一面', interviewedAt, feishuDocId = '', summary = '' }) {
    const id = `iv-${randomUUID()}`;
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO interview_records (id, application_id, round, interviewed_at, feishu_doc_id, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, id, applicationId, round, interviewedAt || now, feishuDocId, summary, now);
    return db.get('SELECT * FROM interview_records WHERE id = ?', id);
  }

  async function listInterviews(applicationId) {
    return db.all('SELECT * FROM interview_records WHERE application_id = ? ORDER BY interviewed_at ASC', applicationId);
  }

  async function updateInterview(id, fields) {
    const allowed = ['round', 'interviewed_at', 'feishu_doc_id', 'summary'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k));
    if (sets.length === 0) return;
    const sql = `UPDATE interview_records SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    await db.run(sql, ...sets.map(k => fields[k]), id);
  }

  // ── Doc index ───────────────────────────────────────────────────────────────

  async function upsertDocIndex({ docType, title, feishuDocId, feishuUrl, folderToken = '' }) {
    const id = `doc-${randomUUID()}`;
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO doc_index (id, doc_type, title, feishu_doc_id, feishu_url, folder_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feishu_doc_id) DO UPDATE SET title = excluded.title, feishu_url = excluded.feishu_url
    `, id, docType, title, feishuDocId, feishuUrl, folderToken, now);
  }

  async function listDocIndex(docType) {
    if (docType) return db.all('SELECT * FROM doc_index WHERE doc_type = ? ORDER BY created_at DESC', docType);
    return db.all('SELECT * FROM doc_index ORDER BY created_at DESC');
  }

  // ── Folder registry ─────────────────────────────────────────────────────────

  async function setFolder(key, token) {
    await db.run('INSERT INTO folder_registry (key, token) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET token = excluded.token', key, token);
  }

  async function getFolder(key) {
    const row = await db.get('SELECT token FROM folder_registry WHERE key = ?', key);
    return row?.token ?? null;
  }

  async function close() { await db.close(); }

  return {
    addApplication, findApplication, listApplications, updateApplication,
    addInterview, listInterviews, updateInterview,
    upsertDocIndex, listDocIndex,
    setFolder, getFolder,
    close
  };
}

async function migrate(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS job_applications (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      jd_url TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'applied',
      notes TEXT DEFAULT '',
      feishu_doc_id TEXT DEFAULT '',
      applied_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interview_records (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES job_applications(id),
      round TEXT NOT NULL DEFAULT '一面',
      interviewed_at TEXT NOT NULL,
      feishu_doc_id TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doc_index (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      title TEXT NOT NULL,
      feishu_doc_id TEXT UNIQUE NOT NULL,
      feishu_url TEXT DEFAULT '',
      folder_token TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folder_registry (
      key TEXT PRIMARY KEY,
      token TEXT NOT NULL
    );
  `);
}
