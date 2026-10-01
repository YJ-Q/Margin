import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveWorkspaceIdentity } from '../core/handoff/session-source.js';
import { titleDto } from './sessionTitle.js';
import { archiveStateRevision, readClaudeArchiveState } from './claude/claudeArchiveState.js';
import { readClaudeExecutionStatus, readPiExecutionStatus } from './executionStatus.js';

const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const string = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const programmaticEntrypoints = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);

function files(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isFile() && entry.name.endsWith('.jsonl') ? [path.join(dir, entry.name)] : []); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

// A partially appended final line is normal for both native writers.  Only newline-terminated,
// individually valid records participate in facts; one bad historical line does not poison a
// recoverable session.
function completeRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const end = text.lastIndexOf('\n');
  if (end < 0) return [];
  return text.slice(0, end + 1).split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function timestamp(record) { return validTime(record?.timestamp ?? record?.createdAt ?? record?.time); }
function nested(record, names) {
  const todo = [record];
  while (todo.length) {
    const value = todo.shift();
    if (!value || typeof value !== 'object') continue;
    for (const name of names) if (string(value[name])) return string(value[name]);
    for (const child of Object.values(value)) if (child && typeof child === 'object') todo.push(child);
  }
  return null;
}
function isProgrammaticOrInternal(record) {
  const entrypoint = nested(record, ['entrypoint']);
  const sessionKind = nested(record, ['sessionKind']);
  return (entrypoint && programmaticEntrypoints.has(entrypoint))
    || sessionKind === 'daemon'
    || sessionKind === 'daemon-worker';
}
function textContent(record) {
  if (record?.type !== 'user' && record?.message?.role !== 'user') return null;
  if (record?.isSidechain || record?.isMeta || record?.toolUseResult || (Array.isArray(record?.message?.content) && record.message.content.some((item) => item?.type === 'tool_result'))) return null;
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n') : null;
}
function projected({ agentType, sourceId, nativeSessionId, cwd, createdAt, updatedAt, originalPath, model = null, provider = null, nativeTitle = null, metadataTitle = null, firstUserMessage = null, executionStatus = 'unknown' }) {
  if (!nativeSessionId || !cwd || !createdAt || !updatedAt) return null;
  const identity = resolveWorkspaceIdentity({ cwd });
  return { id: nativeSessionId, nativeSessionId, sourceId, agentType, canonicalId: `${agentType}:${sourceId}:${nativeSessionId}`,
    cwd, createdAt, updatedAt, originalPath, model, provider, executionStatus, attentionStatus: 'none', ...titleDto({ nativeTitle, metadataTitle, firstUserMessage, nativeSessionId }), ...identity };
}

function collectRevisionStats(dir, entries) {
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) collectRevisionStats(file, entries);
      else if (item.isFile() && item.name.endsWith('.jsonl')) {
        const stat = fs.statSync(file);
        entries.push(`${file}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
      }
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

// Revisions use source file signatures, plus Claude's authoritative archive-state revision.
// They are re-read signals, never session truth: timestamps, titles, and status still come from
// complete native records.
export function computeExternalSessionRevision(source, relativeRoot, { archiveReader = readClaudeArchiveState } = {}) {
  const entries = [];
  collectRevisionStats(path.join(source.path, ...relativeRoot), entries);
  const context = JSON.stringify({ id: source.sourceId ?? source.id, type: source.type, path: source.path, enabled: source.enabled });
  const isClaudeProjects = source.type === 'claude' && relativeRoot.length === 1 && relativeRoot[0] === 'projects';
  const archive = isClaudeProjects ? `\narchive:${archiveStateRevision(archiveReader())}` : '';
  return createHash('sha256').update(`${context}\n${entries.sort().join('\n')}${archive}`).digest('hex');
}

export async function discoverClaudeSessions(source, { archiveReader = readClaudeArchiveState } = {}) {
  const output = [];
  const archive = archiveReader();
  if (!archive?.ok) throw Object.assign(new Error('Claude archive state read failed'), { code: archive?.reason ?? 'claude_archive_registry_read_failed' });
  const archivedIds = archive.authoritative ? new Set(archive.archivedIds) : new Set();
  let projects;
  try { projects = fs.readdirSync(path.join(source.path, 'projects'), { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return output; throw error; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    for (const file of files(path.join(source.path, 'projects', project.name))) {
      const records = completeRecords(file);
      if (!records.length) continue;
      // Explicit native subagent/sidechain markers are exclusion evidence, independent of path.
      if (records.some((record) => nested(record, ['agentId', 'agent_id']) || record?.isSidechain === true || record?.sidechain === true || /^(internal|sidechain)$/i.test(String(record?.type ?? '')))) continue;
      // Match Claude's native normal-session list: programmatic SDK sessions and daemon
      // workers are internal to their controller and must not enter Margin's global board.
      if (records.some(isProgrammaticOrInternal)) continue;
      const nativeSessionId = records.map((record) => nested(record, ['sessionId', 'session_id'])).find(Boolean) ?? string(path.basename(file, '.jsonl'));
      if (archivedIds.has(nativeSessionId)) continue;
      const cwd = records.map((record) => nested(record, ['cwd'])).find(Boolean);
      const times = records.map(timestamp).filter(Boolean);
      const assistants = records.filter((record) => record?.type === 'assistant' || record?.message?.role === 'assistant');
      const model = assistants.map((record) => string(record?.message?.model) ?? string(record?.model)).filter(Boolean).at(-1) ?? null;
      const nativeTitle = records.map((record) => string(record?.aiTitle)).find(Boolean);
      const metadataTitle = records.map((record) => string(record?.title) ?? string(record?.name) ?? string(record?.summary)).find(Boolean);
      const firstUserMessage = records.map(textContent).find(Boolean);
      const result = projected({ agentType: 'claude', sourceId: source.sourceId ?? source.id, nativeSessionId, cwd, createdAt: times[0], updatedAt: [...times].sort().at(-1), originalPath: file, model, nativeTitle, metadataTitle, firstUserMessage, executionStatus: readClaudeExecutionStatus(records) });
      if (result) output.push(result);
    }
  }
  return output.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function discoverPiSessions(source) {
  const output = [];
  let dirs;
  try { dirs = fs.readdirSync(path.join(source.path, 'agent', 'sessions'), { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return output; throw error; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const file of files(path.join(source.path, 'agent', 'sessions', dir.name))) {
      const records = completeRecords(file);
      const session = records.find((record) => record?.type === 'session' && string(record.id));
      if (!session) continue;
      const cwd = string(session.cwd) ?? records.map((record) => nested(record, ['cwd'])).find(Boolean);
      const times = records.map(timestamp).filter(Boolean);
      const changes = records.filter((record) => record?.type === 'model_change');
      const latest = changes.at(-1) ?? {};
      const metadataTitle = records.map((record) => string(record?.title) ?? string(record?.name) ?? string(record?.summary)).find(Boolean);
      const firstUserMessage = records.map(textContent).find(Boolean);
      const result = projected({ agentType: 'pi', sourceId: source.sourceId ?? source.id, nativeSessionId: string(session.id), cwd,
        createdAt: times[0], updatedAt: [...times].sort().at(-1), originalPath: file, provider: string(latest.provider) ?? nested(latest, ['provider']), model: string(latest.model) ?? string(latest.modelId) ?? nested(latest, ['model', 'modelId']), metadataTitle, firstUserMessage, executionStatus: readPiExecutionStatus(records) });
      if (result) output.push(result);
    }
  }
  return output.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
