import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { adapters, extractContext, generateHandoffMarkdown } from 'continues';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'output');
const read = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
const context = read('baseline-context.json');
const standard = read('continues-standard-context.json');
const evidence = context.phase0Evidence;
const capture = evidence.capture;
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = fs.readFileSync(capture.snapshotPath);
check('Frozen source SHA-256 matches recorded capture', sha(snapshot) === capture.sha256);
const original = fs.readFileSync(capture.originalPath);
check('Real session still contains exact captured prefix', sha(original.subarray(0, snapshot.length)) === capture.sha256);
const session = { ...context.session, createdAt: new Date(context.session.createdAt), updatedAt: new Date(context.session.updatedAt) };
const fresh = await extractContext(session);
check('Saved handoff byte-identical to public default extractContext',
  fs.readFileSync(path.join(output, 'baseline-continues-handoff.md'), 'utf8') === fresh.markdown);
check('Public standalone renderer matches default extraction', fresh.markdown === generateHandoffMarkdown(
  fresh.session, fresh.recentMessages, fresh.filesModified, fresh.pendingTasks,
  fresh.toolSummaries, fresh.sessionNotes, undefined, 'inline', fresh.timeline));
const records = snapshot.toString('utf8').trimEnd().split('\n').map(l => JSON.parse(l));
check('Evidence covers every valid JSONL record', evidence.records.length === records.length);
check('Non-reasoning evidence retains original event payloads', evidence.records.every(r =>
  r.reasoningBodyOmitted || JSON.stringify(r.event) === JSON.stringify(records[r.line - 1])));
check('Every tool call has a line-indexed evidence entry', evidence.indices.toolPairs.length === evidence.measurements.rawToolCalls);
check('Call/result pairs refer to matching source IDs', evidence.indices.toolPairs.every(p => p.resultLines.every(line =>
  records[line - 1].payload.call_id === records[p.callLine - 1].payload.call_id)));
check('Expanded context retains all default selected messages', standard.recentMessages.every(m =>
  context.recentMessages.some(c => c.role === m.role && c.content === m.content)));
const before = JSON.parse(fs.readFileSync(path.join(root, 'git-before.json'), 'utf8').replace(/^\uFEFF/, ''));
check('All pre-existing uncommitted files preserved byte-for-byte', before.files.every(f =>
  sha(fs.readFileSync(path.resolve(root, '../..', f.path))) === f.sha256.toLowerCase()));

// Native archive storage is absent. Test unchanged real bytes in an isolated layout,
// without moving, archiving, or modifying any original Codex Session.
const fixture = fs.mkdtempSync(path.join(output, 'archive-layout-'));
const active = path.join(fixture, 'sessions', '2026', '09', '05', path.basename(capture.snapshotPath));
const archived = path.join(fixture, 'archived_sessions', path.basename(capture.snapshotPath));
fs.mkdirSync(path.dirname(active), { recursive: true });
fs.mkdirSync(path.dirname(archived), { recursive: true });
const child = `import {adapters,extractContext} from 'continues';
const sessions=await adapters.codex.parseSessions();
const contexts=await Promise.all(sessions.map(s=>extractContext(s)));
console.log(JSON.stringify({sessions,contextMessages:contexts.map(c=>c.recentMessages.length)}));`;
const probe = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], {
  cwd: root, env: { ...process.env, CODEX_HOME: fixture }, encoding: 'utf8',
}));
fs.copyFileSync(capture.snapshotPath, archived);
const archiveOnly = probe();
check('Archived-only layout discovers the unchanged real session', archiveOnly.sessions.length === 1
  && archiveOnly.sessions[0].id === session.id && archiveOnly.sessions[0].originalPath === archived);
check('Archived real-copy context extraction succeeds', archiveOnly.contextMessages[0] === fresh.recentMessages.length);
fs.copyFileSync(capture.snapshotPath, active);
fs.utimesSync(archived, new Date('2026-09-05T09:00:00Z'), new Date('2026-09-05T09:00:00Z'));
fs.utimesSync(active, new Date('2026-09-05T10:00:00Z'), new Date('2026-09-05T10:00:00Z'));
const duplicate = probe();
check('Active/archive duplicates use one ID and newer mtime for this >1 MiB sample',
  duplicate.sessions.length === 1 && duplicate.sessions[0].originalPath === active);
check('Layout probe copies have unchanged content hashes', sha(fs.readFileSync(active)) === capture.sha256
  && sha(fs.readFileSync(archived)) === capture.sha256);
const nativeFiltered = await adapters.codex.parseSessions({ cwd: session.cwd });
const slashFiltered = await adapters.codex.parseSessions({ cwd: session.cwd.replaceAll('\\', '/') });
const windowsPathObservation = { nativeCount: nativeFiltered.length, forwardSlashCount: slashFiltered.length,
  nativeContainsSelected: nativeFiltered.some(s => s.id === session.id),
  forwardSlashContainsSelected: slashFiltered.some(s => s.id === session.id) };
let configSubpathError;
try { await import('continues/config'); }
catch (error) { configSubpathError = error.code; }
check('Config subpath is not public in pinned 4.1.1', configSubpathError === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
const result = { checkedAt: new Date().toISOString(), passed: checks.length, checks,
  windowsPathObservation, configSubpathError,
  archiveProbe: { kind: 'isolated copies of real session, not native archived history', fixture,
    archiveOnly: archiveOnly.sessions, deduplicated: duplicate.sessions },
  sourceSnapshotSha256: capture.sha256 };
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
