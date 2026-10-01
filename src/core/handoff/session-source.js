import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { titleDto } from '../../agents/sessionTitle.js';
import { readLatestCodexTurnStatus } from '../../agents/codex/codexTurnStatus.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');

// Read a .capture.json sidecar; returns null (not throw) if missing, unreadable, or malformed
// so the caller can fall back to re-capturing instead of crashing on a half-residual cache.
function readCapture(snapshotPath) {
  try { return JSON.parse(fs.readFileSync(snapshotPath + '.capture.json', 'utf8').replace(/^﻿/, '')); }
  catch { return null; }
}

// Codex session facts are read at the source boundary. The resumable projection admits only
// explicit foreground (`thread_source: "user"`) rollouts, so internal work can never advance
// a user-visible canonical session.
export function resolveCodexHome(codexHome, { env = process.env, homedir = os.homedir } = {}) {
  if (typeof codexHome === 'string' && codexHome.trim()) return path.resolve(codexHome);
  // Electron can be launched by a shell whose Node home resolves to a service or
  // packaging account. USERPROFILE is the Windows user profile that owns Codex's
  // native session directory, and is also what the CLI inherits. CODEX_HOME
  // remains an explicit, cross-host override for portable installations.
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()) return path.resolve(env.CODEX_HOME);
  const profile = env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? path.join(env.HOMEDRIVE, env.HOMEPATH) : null) || homedir();
  return path.join(profile, '.codex');
}

export async function discoverSessions(codexHome, { limit, env, homedir, sourceId, agentType = 'codex' } = {}) {
  const home = resolveCodexHome(codexHome, { env, homedir });
  // A discovery is one complete active-source snapshot.  Eligibility and
  // canonicalization deliberately happen before ordering and pagination.
  const sessions = resumableSessions(parseCodexSessions(home), { limit, sourceId, agentType });
  const tracker = trackerFor(home);
  return composeCodexTerminalStatuses(sessions, home, tracker);
}

function sessionFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sessionFiles(entryPath);
    return entry.isFile() && /^rollout-.+\.jsonl$/i.test(entry.name) ? [entryPath] : [];
  });
}

// Cheap stat-only traversal of the S1 default-resumable read tree under `{home}/sessions`.
// Mirrors sessionFiles() (recursive, rollout-*.jsonl only) but never reads file contents, so a
// full signature costs ≈1 ms. `archived_sessions` is deliberately excluded: it is not part of
// the default resumable projection, and an archive/delete is observed here as the rollout
// leaving this tree (its mtime/size changes as Codex appends, and file creation/moves change
// the enumerated set). A stat-only signature cannot miss a real Codex op: appends grow the
// file (size + mtime), and create/archive/delete/source-switch change the entry set.
function collectRolloutStats(dir, prefix, entries) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const item of items) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) { collectRolloutStats(path.join(dir, item.name), rel, entries); continue; }
    if (!/^rollout-.+\.jsonl$/i.test(item.name)) continue;
    let stat;
    try { stat = fs.statSync(path.join(dir, item.name)); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    entries.push(`${rel}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
  }
}

// Content-independent source revision used by the S2 live sync contract. It hashes the source's
// own config (active source identity/type/path/enabled) together with the stat list of the active
// sessions tree, so it changes exactly when a native create/update/archive/delete or an
// active-source switch could change the S1 projection, and is computable in ≈1 ms. The revision
// carries no session data: it only tells a caller "re-read".
export function computeSourceRevision({ codexHome, source = null } = {}) {
  const entries = [];
  if (codexHome) collectRolloutStats(path.join(codexHome, 'sessions'), '', entries);
  // Desktop's user/auto-generated thread name is indexed separately from rollouts. Its stat is
  // only a reconciliation signal; timestamps and lifecycle still come exclusively from JSONL.
  if (codexHome) { try { const stat = fs.statSync(path.join(codexHome, 'session_index.jsonl')); entries.push(`session_index.jsonl|${stat.size}|${Math.floor(stat.mtimeMs)}`); } catch {} }
  entries.sort();
  const context = source
    ? JSON.stringify({ id: source.id, type: source.type, path: source.path, enabled: source.enabled })
    : '';
  return createHash('sha256').update(`${context}\n${entries.join('\n')}`).digest('hex');
}

function parseFilename(filePath) {
  const match = path.basename(filePath).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, id] = match;
  return { id, createdAt: new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`) };
}

// continues 4.1.1 captures CODEX_HOME when its module is imported and silently
// ignores parseSessions({ codexRoot }). Keep the Codex source adapter here so
// the supplied root is authoritative for both CLI and every UI host.
function validNativeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Runtime state deliberately belongs to this Margin process only. A tracker is created with a
// cold baseline for every rollout that already exists, then advances byte cursors only when the
// source appends complete records during this process lifetime. Recreating Margin recreates the
// tracker, so an old unmatched `task_started` can never revive a green dot after restart.
const runtimeTrackersByHome = new Map();

// Per-home runtime tracker, exported so the adapter contract can wire a post-discovery
// executionStatus refresh without re-running full session discovery.
export function trackerFor(codexHome) {
  let tracker = runtimeTrackersByHome.get(codexHome);
  if (!tracker) {
    tracker = { initialized: false, rollouts: new Map(), executionStatus: new Map(), lifecycleWatermark: new Map(), terminalLkg: new Map() };
    runtimeTrackersByHome.set(codexHome, tracker);
  }
  return tracker;
}

function validRecordTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;
}

function lifecycleExecutionStatus(record) {
  if (record?.type !== 'event_msg') return null;
  if (!validRecordTime(record.timestamp)) return null;
  if (record.payload?.type === 'task_started') return 'working';
  if (record.payload?.type === 'task_complete' || record.payload?.type === 'turn_aborted') return 'idle';
  // The locally observed Codex schema currently has no explicit failed/error lifecycle record.
  // Keep `error` in the DTO/UI, but do not turn generic messages, tool failures, or unknown
  // events into red without a source-backed native event contract.
  return null;
}

// Reads complete JSONL records only. The byte cursor advances through valid complete lines even
// when a trailing line is partial: a complete `task_started` immediately before streamed output
// is therefore observed, while the partial line waits for a later reconciliation to complete.
function readRolloutFacts(originalPath, file, tracker) {
  const info = fs.statSync(originalPath);
  const previous = tracker.rollouts.get(originalPath);
  const signature = `${info.size}:${Math.floor(info.mtimeMs)}`;
  if (previous?.signature === signature) return { ...previous.facts, lifecycleEvents: [], tracker };

  const rawText = fs.readFileSync(originalPath, 'utf8');
  const bomBytes = rawText.charCodeAt(0) === 0xFEFF ? Buffer.byteLength(rawText[0]) : 0;
  const raw = bomBytes ? rawText.slice(1) : rawText;
  const lastNewline = raw.lastIndexOf('\n');
  const complete = lastNewline < 0 ? '' : raw.slice(0, lastNewline + 1);
  const hasPartialTail = lastNewline !== raw.length - 1;
  const records = [];
  let offset = bomBytes;
  let malformed = false;
  for (const line of complete.split('\n')) {
    const bytes = Buffer.byteLength(`${line}\n`);
    const endOffset = offset + bytes;
    offset = endOffset;
    if (!line.trim()) continue;
    try { records.push({ record: JSON.parse(line), endOffset }); }
    catch { malformed = true; }
  }
  const meta = records.find(({ record }) => record.type === 'session_meta')?.record?.payload ?? {};
  const timestamps = records.map(({ record }) => validRecordTime(record.timestamp)).filter(Boolean);
  const previousCompleteBytes = previous?.facts.completeBytes ?? 0;
  const lifecycleEvents = tracker.initialized
    ? records.filter(({ endOffset }) => !previous || endOffset > previousCompleteBytes)
      .flatMap(({ record }) => {
        const executionStatus = lifecycleExecutionStatus(record);
        return executionStatus ? [{ executionStatus, at: validRecordTime(record.timestamp), turnId: record.payload?.turn_id ?? null }] : [];
      })
    : [];
  const facts = {
    signature,
    completeBytes: bomBytes + Buffer.byteLength(complete),
    id: validNativeSessionId(meta.session_id) ?? file.id,
    nativeSessionId: validNativeSessionId(meta.session_id) ?? file.id,
    rolloutId: file.id,
    lifecycle: 'active',
    threadSource: meta.thread_source ?? null,
    cwd: meta.cwd ?? '', branch: meta.git?.branch ?? null,
    gitSha: meta.git?.commit_hash ?? meta.git?.sha ?? null, summary: null,
    createdAt: timestamps.length ? new Date(Math.min(...timestamps.map(Number))) : null,
    updatedAt: timestamps.length ? new Date(Math.max(...timestamps.map(Number))) : null,
    originalPath,
    hasPartialTail,
    malformed,
  };
  tracker.rollouts.set(originalPath, { signature, facts });
  return { ...facts, lifecycleEvents, tracker };
}

function parseCodexSessions(codexHome) {
  const sessions = [];
  const titles = new Map();
  try {
    for (const line of fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8').split(/\r?\n/)) {
      try { const item = JSON.parse(line); if (validNativeSessionId(item.id) && typeof item.thread_name === 'string' && item.thread_name.trim()) titles.set(item.id, item.thread_name); } catch {}
    }
  } catch { /* title index is optional; rollout fallback remains available */ }
  const tracker = trackerFor(codexHome);
  const foundPaths = new Set();
  // The default resumable projection is active-only. archived_sessions has a
  // separate native lifecycle and must never be admitted as a fallback.
  for (const originalPath of sessionFiles(path.join(codexHome, 'sessions'))) {
    const file = parseFilename(originalPath);
    if (!file) continue;
    try {
      foundPaths.add(originalPath);
      const parsed = readRolloutFacts(originalPath, file, tracker);
      sessions.push({ ...parsed, nativeTitle: titles.get(parsed.nativeSessionId) ?? null });
    } catch {
      // Codex can briefly hold its active rollout with restrictive Windows sharing flags. Keep
      // the last complete snapshot visible; the next revision reconciliation will retry from
      // its byte cursor rather than resetting this session's runtime state.
      const cached = tracker.rollouts.get(originalPath)?.facts;
      if (cached) sessions.push({ ...cached, lifecycleEvents: [], tracker, nativeTitle: titles.get(cached.nativeSessionId) ?? null });
    }
  }
  for (const originalPath of tracker.rollouts.keys()) {
    if (!foundPaths.has(originalPath)) tracker.rollouts.delete(originalPath);
  }
  tracker.initialized = true;
  return sessions;
}

const MAX_META_PROBE_BYTES = 256 * 1024; // bounded metadata head read; never the conversation

// Map one continues UnifiedSession to the plain session shape Margin's boundaries consume.
export function canonicalizeWorkspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* paths from old sessions may no longer exist */ }
  resolved = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Per-canonical-cwd git-root identity cache. A session's cwd is immutable and its repo root /
// basename are stable, so repeat full discoveries (now driven near-real-time by the S2 revision
// poll) must not re-spawn `git rev-parse` once per session per refresh — that was ≈390 ms of a
// ≈480 ms discovery on the real source. A short TTL bounds memory and lets a cwd that lacked Git
// (or that later becomes a repo) recover within the TTL. The projection is unaffected: identity
// is a deterministic function of the canonicalized cwd alone. Exported only so tests can isolate
// cache state between fixture runs.
const WORKSPACE_IDENTITY_TTL_MS = 10_000;
const workspaceIdentityCache = new Map();
export function resetWorkspaceIdentityCache() { workspaceIdentityCache.clear(); }

function probeWorkspaceIdentity(cwd) {
  let repoRoot = null;
  try {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && result.stdout?.trim()) repoRoot = canonicalizeWorkspacePath(result.stdout.trim());
  } catch { /* non-Git or unavailable Git falls back to cwd */ }
  const root = repoRoot ?? cwd;
  return { workspaceKey: `${repoRoot ? 'git' : 'cwd'}:${root}`, workspaceName: path.basename(root) || root };
}

export function resolveWorkspaceIdentity(session) {
  const cwd = canonicalizeWorkspacePath(session.cwd);
  if (!cwd) return { workspaceKey: 'cwd:unknown', workspaceName: 'Unknown workspace' };
  const now = Date.now();
  const cached = workspaceIdentityCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.identity;
  const identity = probeWorkspaceIdentity(cwd);
  workspaceIdentityCache.set(cwd, { expiresAt: now + WORKSPACE_IDENTITY_TTL_MS, identity });
  return identity;
}

const withoutMarkdownPrefix = value => String(value ?? '').trimStart().replace(/^#{1,6}\s+/, '');
const WRAPPER_PREFIX = /^(?:<recommended_plugins>|<environment_context>|files (?:pasted|mentioned) by the user\b|pasted text contains\b|the following is\b|the following content\b)/i;

function shortLabel(text) {
  const lines = String(text).split(/\r?\n/);
  // Pasted implementation briefs commonly begin with a short routing sentence and then a
  // Markdown Slice heading; the heading is the more stable identifying requirement.
  const headings = lines.filter(line => /^#{1,6}\s+\S/.test(line.trim()))
    .map(line => line.trim().replace(/^#{1,6}\s+/, ''));
  const heading = headings.find(line => !isLowQualityLabel(line));
  const first = heading ?? lines.find(line => line.trim() && !/^#{1,6}\s+/.test(line.trim()))?.trim()
    ?? headings[0] ?? '';
  const sentence = first.match(/^(.+?[.!?](?:\s|$))/)?.[1]?.trim() ?? first;
  return sentence.length > 80 ? `${sentence.slice(0, 79).trimEnd()}…` : sentence;
}

function isLowQualityLabel(value) {
  return /^(?:goal|[a-z]\.)$/i.test(withoutMarkdownPrefix(value));
}

function usableText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !WRAPPER_PREFIX.test(withoutMarkdownPrefix(text)) ? text : null;
}

// Codex Desktop represents a pasted text file as a small platform envelope followed by
// its local attachment path. Reading that explicit, user-provided text file is the smallest
// source-side recovery needed to make the card identifiable; other wrappers remain skipped.
export function pastedAttachmentRequirement(text) {
  if (!/^files pasted by the user\b/i.test(withoutMarkdownPrefix(text))) return null;
  const attachment = text.match(/:\s*([A-Za-z]:[^\r\n]+?\.txt)(?:\r?\n|$)/)?.[1]?.trim();
  if (!attachment) return null;
  try { return usableText(fs.readFileSync(attachment, 'utf8')); } catch { return null; }
}

// The source boundary has one deterministic definition of a usable end-user
// requirement. Both discovery labels and downstream Evidence use it so an
// explicit pasted-text attachment cannot acquire a different meaning later in
// the pipeline.
export function normalizeUserRequirement(text) {
  return usableText(text) ?? pastedAttachmentRequirement(text);
}

function firstEligibleUserRequirement(originalPath) {
  try {
    const lines = fs.readFileSync(originalPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event.type === 'response_item' ? event.payload : null;
      if (payload?.type !== 'message' || payload.role !== 'user') continue;
      for (const content of payload.content ?? []) {
        const raw = content?.text ?? (content?.type === 'input_text' ? content.text : null);
        const candidate = normalizeUserRequirement(raw);
        if (candidate) return candidate;
      }
    }
  } catch { /* missing historical source: deterministic id fallback */ }
  return null;
}

export function sessionLabel(session) {
  const summary = usableText(session.summary);
  // Codex occasionally supplies structural placeholders as a summary. They are
  // not useful identifiers, so preserve the established deterministic user
  // requirement fallback instead of presenting "Goal" or "A." as a title.
  const usableSummary = summary && !isLowQualityLabel(summary) ? summary : null;
  const requirement = usableSummary ?? firstEligibleUserRequirement(session.originalPath);
  return requirement ? shortLabel(requirement) : `Untitled session · ${String(session.id).slice(0, 8)}`;
}

function toPlainSession(s) {
  const identity = resolveWorkspaceIdentity(s);
  const title = titleDto({ nativeTitle: s.nativeTitle, metadataTitle: s.summary, firstUserMessage: firstEligibleUserRequirement(s.originalPath), nativeSessionId: s.nativeSessionId ?? s.id });
  return {
    id: s.id,
    nativeSessionId: s.nativeSessionId ?? s.id,
    rolloutId: s.rolloutId ?? null,
    sourceId: s.sourceId ?? 'default',
    agentType: s.agentType ?? 'codex',
    canonicalId: s.canonicalId ?? `${s.agentType ?? 'codex'}:${s.sourceId ?? 'default'}:${s.nativeSessionId ?? s.id}`,
    cwd: s.cwd,
    branch: s.branch ?? null,
    gitSha: s.gitSha ?? null,
    summary: s.summary ?? null,
    createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
    updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
    executionStatus: s.executionStatus ?? 'unknown',
    attentionStatus: 'none',
    originalPath: s.originalPath,
    ...identity,
    ...title,
    label: title.displayTitle,
  };
}

// Build canonical foreground sessions from Codex rollouts. Exported so tests drive the exact
// transform used by discoverSessions; threadSource is a source fact, never UI metadata.
export function resumableSessions(discovered, { limit, sourceId = 'default', agentType = 'codex' } = {}) {
  const byCanonicalId = new Map();
  for (const s of discovered) {
    // Lifecycle is a source fact. Unknown legacy callers remain active for
    // backwards-compatible direct helper use, but an explicit archived record
    // can never consume a slot or win a collision.
    if ((s.lifecycle ?? 'active') !== 'active') continue;
    // Recency and live state are deliberately stricter than historical list visibility:
    // only Codex's explicit foreground-user marker is trusted to belong to the main session.
    // This prevents a guardian/subagent/control rollout sharing an id from advancing it.
    if (s.threadSource !== 'user') continue;
    const nativeSessionId = validNativeSessionId(s.nativeSessionId) ?? validNativeSessionId(s.id);
    if (!nativeSessionId) continue;
    const resolvedSourceId = s.sourceId ?? sourceId;
    const resolvedAgentType = s.agentType ?? agentType;
    const canonicalId = `${resolvedAgentType}:${resolvedSourceId}:${nativeSessionId}`;
    const candidate = { ...s, id: nativeSessionId, nativeSessionId, sourceId: resolvedSourceId, agentType: resolvedAgentType, canonicalId };
    const previous = byCanonicalId.get(canonicalId);
    if (!previous) {
      byCanonicalId.set(canonicalId, { ...candidate,
        lifecycleEvents: candidate.lifecycleEvents ?? [] });
      continue;
    }
    const createdTimes = [previous.createdAt, candidate.createdAt].map((value) => Number(value)).filter(Number.isFinite);
    const createdAt = createdTimes.length ? new Date(Math.min(...createdTimes)) : null;
    const candidateIsNewest = new Date(candidate.updatedAt ?? 0) > new Date(previous.updatedAt ?? 0);
    byCanonicalId.set(canonicalId, {
      ...(candidateIsNewest ? candidate : previous),
      createdAt,
      updatedAt: candidateIsNewest ? candidate.updatedAt : previous.updatedAt,
      lifecycleEvents: [...(previous.lifecycleEvents ?? []), ...(candidate.lifecycleEvents ?? [])]
        .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0)),
    });
  }
  const sessions = [...byCanonicalId.values()].map((session) => {
    // Only foreground candidates reach this point, so an internal rollout cannot mutate the
    // canonical runtime state even if it shares a native session id.
    for (const event of session.lifecycleEvents ?? []) {
      session.tracker?.executionStatus.set(session.canonicalId, event.executionStatus);
      session.tracker?.lifecycleWatermark.set(session.canonicalId, event.at);
    }
    return { ...session, executionStatus: session.tracker?.executionStatus.get(session.canonicalId) ?? 'unknown', attentionStatus: 'none' };
  })
    .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0) || a.canonicalId.localeCompare(b.canonicalId))
    .map(toPlainSession);
  return limit ? sessions.slice(0, limit) : sessions;
}

// Post-discovery terminal status enrichment, exported so the adapter contract can wire
// a `readExecutionStatus` step for Codex without re-running full session discovery.
export async function composeCodexTerminalStatuses(sessions, home, tracker) {
  const composed = [];
  for (const session of sessions) {
    const native = await readLatestCodexTurnStatus(home, session.nativeSessionId);
    const liveAt = tracker.lifecycleWatermark.get(session.canonicalId);
    const liveStatus = tracker.executionStatus.get(session.canonicalId);
    let status = session.executionStatus;
    if (native.ok && native.available) {
      tracker.terminalLkg.set(session.canonicalId, native);
      const terminalAt = native.terminal?.at ? new Date(native.terminal.at * 1000) : null;
      const liveWins = Boolean(liveAt && terminalAt && liveAt >= terminalAt);
      if (liveWins) status = liveStatus ?? status;
      else if (native.executionStatus === 'error') status = 'error';
    } else if (!native.ok) {
      const lkg = tracker.terminalLkg.get(session.canonicalId);
      if (lkg?.executionStatus === 'error' && !liveAt) status = 'error';
      if (liveAt) status = liveStatus ?? status;
    }
    composed.push({ ...session, executionStatus: status });
  }
  return composed;
}

// Capture a stable snapshot of one session. User-facing handoff generation passes
// refreshSnapshot=true and therefore never treats a self-consistent old sidecar
// as proof that the native source is current. Reuse remains opt-in for callers
// that explicitly need a previously frozen checkpoint.
// A snapshot without a readable, matching .capture.json (deleted, partial, or corrupt) is
// treated as incomplete and re-captured rather than throwing — a normal rerun should never
// crash on a half-residual cache from a previous interrupted run.
export function captureSession(sessionMeta, snapshotPath, { refreshSnapshot = false } = {}) {
  if (fs.existsSync(snapshotPath) && !refreshSnapshot) {
    const existing = readCapture(snapshotPath);
    if (existing) {
      const raw = fs.readFileSync(snapshotPath);
      if (sha256(raw) === existing.sha256) return existing;
    }
  }
  const bytes = fs.readFileSync(sessionMeta.originalPath);
  // Freeze at last complete line to avoid partial JSONL records from a live session.
  const boundary = bytes.lastIndexOf(10) + 1;
  if (!boundary) throw new Error('No complete JSONL record found in session file');
  const prefix = bytes.subarray(0, boundary);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, prefix);
  const capture = {
    capturedAt: new Date().toISOString(),
    originalPath: sessionMeta.originalPath,
    snapshotPath,
    bytes: prefix.length,
    sha256: sha256(prefix),
    omittedTrailingBytes: bytes.length - prefix.length,
    sessionId: sessionMeta.id,
    canonicalId: sessionMeta.canonicalId ?? null,
    sourceId: sessionMeta.sourceId ?? null,
    agentType: sessionMeta.agentType ?? null,
    nativeSessionId: sessionMeta.nativeSessionId ?? sessionMeta.id,
    cwd: sessionMeta.cwd,
  };
  fs.writeFileSync(snapshotPath + '.capture.json', JSON.stringify(capture, null, 2));
  return capture;
}

// Codex's own recorder (codex-rs/protocol/src/protocol.rs, struct SessionMeta) writes a
// stable `thread_source` field on the session_meta line: "user" for a normal end-user
// thread, or "guardian_review" / "subagent" / "memory_consolidation" / a feature name for
// Codex's own internal threads. A guardian_review thread judges another thread's history —
// its role="user" turn is Guardian's own task input, addressed to that internal reviewer,
// not a real end-user requirement, even though it is structurally identical to one. Older
// captures may not have this field at all; absence is not itself a signal one way or the
// other, so callers should treat it as "unknown, assume normal" rather than "not user".
function findThreadSource(records) {
  const meta = records.find((r) => r.event?.type === 'session_meta');
  return meta?.event?.payload?.thread_source ?? null;
}

// Metadata-only enrichment for discovery: probe the session_meta record of one session's
// native JSONL for payload.thread_source. Reads at most MAX_META_PROBE_BYTES from the head of
// the file and stops at the first session_meta line — it never parses the conversation, tool
// calls, or Evidence. Fail-open: a missing/unreadable path, a live session still being written
// (trailing partial record), or malformed/truncated metadata all return null, so enrichment
// can never hide a session it could not positively classify as internal.
function readThreadSourceFromPath(originalPath) {
  let handle;
  try {
    handle = fs.openSync(originalPath, 'r');
    const buffer = Buffer.allocUnsafe(MAX_META_PROBE_BYTES);
    const { bytesRead } = fs.readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '');
    // Freeze at the last complete line so a half-written trailing record never parses.
    const end = text.lastIndexOf('\n');
    const head = end === -1 ? text : text.slice(0, end + 1);
    const records = [];
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try { records.push({ event: JSON.parse(line) }); }
      catch { return null; } // malformed metadata — unknown, fail open to visible
      if (records[records.length - 1].event.type === 'session_meta') break;
    }
    return findThreadSource(records);
  } catch {
    return null;
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* already closed */ } }
  }
}

// Read and parse a captured snapshot into { records, capture, session }.
// This is the plain-object format that evidence.js consumes.
export function readSessionSource(capture) {
  const raw = fs.readFileSync(capture.snapshotPath);
  if (sha256(raw) !== capture.sha256) throw new Error('Snapshot hash mismatch; re-capture with refreshSnapshot=true');
  const physicalLines = raw.toString('utf8').split('\n');
  const records = [];
  for (const [i, line] of physicalLines.entries()) {
    if (!line.trim()) continue;
    records.push({ line: i + 1, event: JSON.parse(line) });
  }
  return { records, capture, session: { cwd: capture.cwd ?? '', threadSource: findThreadSource(records) } };
}

// Read a frozen complete-line view directly from a native session file. Unlike
// captureSession this intentionally creates no snapshot or sidecar: read-only
// overview requests must not write into the workspace or handoff output.
export function readSessionMetaSource(sessionMeta) {
  const bytes = fs.readFileSync(sessionMeta.originalPath);
  const boundary = bytes.lastIndexOf(10) + 1;
  if (!boundary) throw new Error('No complete JSONL record found in session file');
  const prefix = bytes.subarray(0, boundary);
  const physicalLines = prefix.toString('utf8').split('\n');
  const records = [];
  for (const [i, line] of physicalLines.entries()) {
    if (!line.trim()) continue;
    records.push({ line: i + 1, event: JSON.parse(line) });
  }
  return {
    records,
    capture: {
      capturedAt: new Date().toISOString(), originalPath: sessionMeta.originalPath,
      snapshotPath: sessionMeta.originalPath, bytes: prefix.length, sha256: sha256(prefix),
      sessionId: sessionMeta.id, cwd: sessionMeta.cwd,
    },
    session: { cwd: sessionMeta.cwd ?? '', threadSource: findThreadSource(records) },
  };
}
