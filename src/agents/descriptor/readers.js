// The bounded reader catalogue for declarative Agent descriptors.
//
// Every capability a descriptor can ask for is implemented here, once, and is deliberately small:
// two substitutions, one glob dialect (`*` and `**` inside a path segment list, no character
// classes, no braces), four field extractors, and one transcript format. There is no expression
// evaluator and no `eval`. A descriptor that needs more than this is telling Margin that the Agent
// needs a built-in adapter — which is a legitimate answer, not a gap to be papered over with a more
// powerful DSL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceIdentity } from '../../core/handoff/session-source.js';
import { normalizeDisplayTitle, titleDto } from '../sessionTitle.js';

const MAX_FILES_PER_SESSION = 4000;
const MAX_SESSIONS = 2000;

export function expandTemplate(template, { home = null, profile = null, env = process.env } = {}) {
  return String(template)
    .replace(/\{home\}/g, home ?? '')
    .replace(/\{profile\}/g, profile ?? '')
    .replace(/%ENV:([A-Z0-9_]+)%/g, (_match, name) => String(env?.[name] ?? '').trim());
}

// `*` never crosses a separator; `**` matches zero or more whole segments. Everything else is
// escaped, so a descriptor cannot smuggle a regex in through a glob.
export function globToRegExp(pattern) {
  const parts = String(pattern).split('/').filter((part) => part.length > 0);
  let source = '^';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const last = index === parts.length - 1;
    if (part === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    source += part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    if (!last) source += '/';
  }
  return new RegExp(`${source}$`);
}

export function matchesGlob(relativePath, pattern) {
  return globToRegExp(pattern).test(relativePath);
}

function listRelativeFiles(root, { maxFiles = MAX_FILES_PER_SESSION } = {}) {
  const found = [];
  const failed = { value: false };
  function walk(dir, prefix, depth) {
    if (found.length >= maxFiles || depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      // A vanished directory is a normal transient during native cleanup; anything else means this
      // session could not be read in full and must not be published as if it had been.
      if (error?.code !== 'ENOENT') failed.value = true;
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative, depth + 1);
      else if (entry.isFile()) found.push(relative);
    }
  }
  walk(root, '', 0);
  return { files: found.sort(), failed: failed.value };
}

const selectRelativeFiles = (files, pattern) => files.filter((file) => matchesGlob(file, pattern));

// Same completeness rule the native readers use: only newline-terminated records participate, and a
// single corrupt historical line never poisons an otherwise readable session.
export function readJsonlRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) {
    if (error?.code === 'ENOENT') return { records: [], failed: false };
    return { records: [], failed: true };
  }
  const end = text.lastIndexOf('\n');
  if (end < 0) return { records: [], failed: false };
  const records = text.slice(0, end + 1).split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return { records, failed: false };
}

const readPath = (record, dotted) => {
  let value = record;
  for (const key of String(dotted).split('.')) {
    if (!value || typeof value !== 'object') return null;
    value = value[key];
  }
  return value === undefined ? null : value;
};

const matchesWhere = (record, where) => {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    const actual = readPath(record, key);
    return actual === expected;
  });
};

const isoFromMs = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Absolute paths inside a transcript. URLs are stripped first, so a markdown link cannot be mistaken
// for a filesystem path, and both dialects require a real root (a drive letter, or a leading slash
// that is not a protocol separator).
const WINDOWS_ABSOLUTE = /[A-Za-z]:[\\/][^\s"'`,;:)\]}>|*?\r\n]*/g;
const POSIX_ABSOLUTE = /(?:^|[\s"'(=:,])(\/(?!\/)[^\s"'`,;:)\]}>|*?\r\n]+)/g;
const MAX_PATH_CANDIDATES = 200;

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || out.length > 400) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out, depth + 1); return out; }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) collectStrings(item, out, depth + 1); }
  return out;
}

// Recovers a workspace from the absolute paths a transcript happens to mention.
//
// This is the one extractor that reads meaning out of free text, so it stays as narrow as possible:
// no ordering rules, no priorities, no include/exclude patterns. Two bounded knobs are enough for a
// real Agent:
//   * `parentOf`     — the Agent records FILES, so the workspace is the containing directory.
//   * `requireMarker` — prefer the candidate that actually looks like a project (a `.git` directory)
//     over incidental paths such as a bundled skill's reference file. Without it, whichever path a
//     transcript mentions first wins, which is how a session ends up filed under "references".
// Marker preference is a preference, never a filter: a session whose workspace genuinely has no
// marker still resolves to its first path rather than disappearing.
function scanAbsolutePaths(records, { parentOf = false, requireMarker = null } = {}) {
  const candidates = [];
  outer: for (const record of records) {
    for (const raw of collectStrings(record, [])) {
      const text = raw.replace(/https?:\/\/\S+/gi, ' ');
      for (const pattern of [WINDOWS_ABSOLUTE, POSIX_ABSOLUTE]) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const found = (match[1] ?? match[0]).replace(/[.,]+$/, '');
          if (found.length < 4) continue;
          let candidate = found;
          if (parentOf) {
            const trimmed = found.replace(/[\\/]+$/, '');
            const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
            if (cut <= 0) continue;
            candidate = trimmed.slice(0, cut);
          }
          if (!candidates.includes(candidate)) candidates.push(candidate);
          if (candidates.length >= MAX_PATH_CANDIDATES) break outer;
        }
      }
    }
  }
  if (!candidates.length) return null;
  if (requireMarker) {
    const marked = candidates.find((candidate) => {
      try { return fs.existsSync(path.join(candidate, requireMarker)); } catch { return false; }
    });
    if (marked) return marked;
  }
  return candidates[0];
}

// `extractor` is already spec-validated; this function therefore only has to be correct, not
// defensive about its own shape.
export function extractField(extractor, context) {
  if (!extractor) return null;
  const { kind } = extractor;
  if (kind === 'directoryName') return context.sessionName ?? null;
  if (kind === 'filename') return context.basename ?? null;
  if (kind === 'mtime') {
    const candidates = selectRelativeFiles(context.relativeFiles, extractor.glob);
    const times = candidates.flatMap((relative) => {
      try { return [fs.statSync(path.join(context.sessionDir, relative)).mtimeMs]; } catch { return []; }
    });
    if (!times.length) return null;
    return isoFromMs(extractor.pick === 'min' ? Math.min(...times) : Math.max(...times));
  }
  if (kind === 'scanAbsolutePaths') return scanAbsolutePaths(context.records, extractor);
  if (kind === 'record') {
    const matches = context.records.filter((record) => matchesWhere(record, extractor.where));
    if (!matches.length) return null;
    const record = extractor.index === 'last' ? matches.at(-1) : matches[extractor.index ?? 0];
    if (!record || typeof record !== 'object') return null;
    const value = extractor.path ? readPath(record, extractor.path) : record;
    if (typeof value === 'string') return value.trim() || null;
    return value === undefined ? null : value;
  }
  return null;
}

const asString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// Extract executionStatus from transcript records using a declarative extractor.
//
// The extractor is the same bounded shape the spec validates: a `where` filter narrows to
// status-bearing records, `path` reads a dotted field, and `map` translates the raw value
// into one of the four Board status values ('unknown', 'working', 'idle', 'error').
// `pick` selects which matching record wins (default: last = most recent).
//
// Returns 'unknown' when no records match or the mapped value is not in the map — never
// invents a status from free text, the same completeness rule the title extractor follows.
export function extractExecutionStatus(spec, records) {
  if (!spec || spec.kind !== 'transcript') return 'unknown';
  const where = spec.where ?? {};
  const matching = records.filter((record) => matchesWhere(record, where));
  if (!matching.length) return 'unknown';
  const record = spec.pick === 'first' ? matching[0] : matching[matching.length - 1];
  const raw = readPath(record, spec.path);
  if (raw === null || raw === undefined) return 'unknown';
  return spec.map?.[String(raw)] ?? spec.map?.[raw] ?? 'unknown';
}

// Structural probe: does this directory actually look like this Agent's home? Registered-but-empty
// is otherwise indistinguishable from a mistyped path, which is what made onboarding opaque.
export function probeDescriptor(descriptor, home, { profile = null, env = process.env } = {}) {
  const probe = descriptor.probe;
  if (!probe?.anyOf?.length) return { valid: true, reason: null };
  // A probe is relative to the Agent home, so it can only run once the home exists.
  if (!home) return { valid: true, reason: null };
  for (const candidate of probe.anyOf) {
    const template = expandTemplate(candidate.glob, { home, profile, env });
    if (!template) continue;
    if (!template.includes('*') && !template.includes('?')) {
      if (fs.existsSync(template)) return { valid: true, reason: null };
      continue;
    }
    const normalised = template.split(path.sep).join('/');
    const wildcardIndex = normalised.search(/[*?]/);
    const head = normalised.slice(0, wildcardIndex);
    const base = head.slice(0, head.lastIndexOf('/')) || '/';
    const pattern = normalised.slice(base === '/' ? 1 : base.length + 1);
    // Bounded to the segments the pattern can actually reach rather than walking the whole home.
    const { files } = listRelativeFiles(base, { maxFiles: 512 });
    if (files.some((file) => matchesGlob(file, pattern))) return { valid: true, reason: null };
  }
  return { valid: false, reason: `Directory does not look like a ${descriptor.label} home` };
}

const TITLE_SOURCE_BY_AS = Object.freeze({
  native: 'native',
  metadata: 'metadata',
  'first-user-message': 'first-user-message',
});

// Resolves where this Agent actually lives on THIS machine.
//
// This is the "configure the interface from its own situation" step: the descriptor lists the places
// the Agent might be, in order, and install resolves that list against the real filesystem, reporting
// every candidate it tried. Nothing is guessed and nothing is silently skipped — a caller that gets no
// resolved home gets the full candidate report that explains why.
export function resolveAgentHome(descriptor, { env = process.env, homedir = os.homedir(), profile = null } = {}) {
  const resolvedProfile = profile ?? env.USERPROFILE?.trim() ?? env.HOME?.trim() ?? homedir;
  const candidates = [];
  const seen = new Set();
  for (const candidate of descriptor.homeCandidates ?? []) {
    const fromEnv = candidate.env ? String(env[candidate.env] ?? '').trim() : '';
    const expanded = fromEnv || expandTemplate(candidate.fallback, { home: null, profile: resolvedProfile, env });
    const target = expanded ? path.resolve(expanded) : null;
    // Two candidates often describe the SAME place by different means (an explicit env var and the
    // profile-relative default). Reporting the same directory twice makes a working install look
    // broken, so the report is keyed on resolved locations, not on how each was derived.
    const key = target ?? `env:${candidate.env ?? '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let exists = false;
    try { exists = Boolean(target) && fs.statSync(target).isDirectory(); } catch { exists = false; }
    const probe = exists ? probeDescriptor(descriptor, target, { profile: resolvedProfile, env }) : { valid: false, reason: 'Path does not exist' };
    candidates.push({ env: candidate.env ?? null, path: target, exists, probe });
  }
  // Prefer a candidate that both exists and passes the descriptor's own probe: a real directory that
  // does not look like the Agent is a far weaker signal than one that does.
  const resolved = candidates.find((candidate) => candidate.exists && candidate.probe.valid)
    ?? candidates.find((candidate) => candidate.exists)
    ?? null;
  return { profile: resolvedProfile, candidates, resolved };
}

export function buildTranscriptSession(descriptor, source, { sessionDir, sessionName, basename, relativeFiles, records, originalPath, env }) {
  const spec = descriptor.sessions;
  const context = { sessionDir, sessionName, basename, relativeFiles, records, env };
  const nativeSessionId = asString(extractField(spec.id, context));
  if (!nativeSessionId) return null;
  const cwd = asString(extractField(spec.workspace, context));
  const createdAt = asString(extractField(spec.createdAt, context));
  const updatedAt = asString(extractField(spec.updatedAt, context));
  // A session without a workspace, a start and an end cannot be placed on the Board or ordered, and
  // publishing it with invented values would be worse than omitting it.
  if (!cwd || !createdAt || !updatedAt) return null;

  const rawTitle = asString(extractField(spec.title, context));
  const titleSource = TITLE_SOURCE_BY_AS[spec.title?.as ?? 'first-user-message'] ?? 'first-user-message';
  const titleInput = titleSource === 'native' ? { nativeTitle: rawTitle }
    : titleSource === 'metadata' ? { metadataTitle: rawTitle }
    : { firstUserMessage: rawTitle };
  const sourceId = source.sourceId ?? source.id;
  const identity = resolveWorkspaceIdentity({ cwd });
  // executionStatus is extracted from the same transcript records the session discovery
  // already parses. A descriptor without an executionStatus section stays 'unknown', which
  // is the honest answer rather than a fabricated status.
  const executionStatus = descriptor.executionStatus?.kind === 'transcript'
    ? extractExecutionStatus(descriptor.executionStatus, records)
    : 'unknown';
  return {
    id: nativeSessionId,
    nativeSessionId,
    sourceId,
    agentType: descriptor.type,
    canonicalId: `${descriptor.type}:${sourceId}:${nativeSessionId}`,
    cwd,
    createdAt,
    updatedAt,
    originalPath,
    model: asString(extractField(spec.model, context)),
    provider: asString(extractField(spec.provider, context)),
    executionStatus,
    attentionStatus: 'none',
    ...titleDto({ ...titleInput, nativeSessionId }),
    ...identity,
  };
}

// Session discovery for `sessions.kind: "transcript"`.
//
// Read failures throw, matching the native readers: the caller's per-source envelope turns a throw
// into `ok: false`, so a transient failure can never be published as "this Agent has no sessions".
export async function discoverTranscriptSessions(descriptor, source, { profile = null, env = process.env, now = Date.now() } = {}) {
  const spec = descriptor.sessions;
  const home = source?.path ?? null;
  if (!home) return [];
  const output = [];
  const seen = new Set();

  for (const rootTemplate of spec.roots) {
    const root = expandTemplate(rootTemplate, { home, profile, env });
    if (!root) continue;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (output.length >= MAX_SESSIONS) break;
      const absolute = path.join(root, entry.name);
      let sessionDir; let sessionName; let basename; let relativeFiles; let transcriptFiles;
      if (spec.layout === 'file-per-session') {
        if (!entry.isFile()) continue;
        const listing = listRelativeFiles(root);
        if (listing.failed) throw Object.assign(new Error(`${descriptor.label} source read failed`), { code: 'source_read_failed' });
        sessionDir = root; sessionName = entry.name.replace(/\.[^.]+$/, ''); basename = entry.name;
        relativeFiles = listing.files;
        transcriptFiles = selectRelativeFiles(relativeFiles, spec.transcript.glob).filter((file) => file === entry.name);
      } else {
        if (!entry.isDirectory()) continue;
        const listing = listRelativeFiles(absolute);
        if (listing.failed) throw Object.assign(new Error(`${descriptor.label} source read failed`), { code: 'source_read_failed' });
        sessionDir = absolute; sessionName = entry.name; basename = entry.name;
        relativeFiles = listing.files;
        transcriptFiles = selectRelativeFiles(relativeFiles, spec.transcript.glob);
      }
      const transcript = transcriptFiles[0];
      if (!transcript) continue;
      const originalPath = path.join(sessionDir, transcript);
      const { records, failed } = readJsonlRecords(originalPath);
      if (failed) throw Object.assign(new Error(`${descriptor.label} source read failed`), { code: 'source_read_failed' });
      if (!records.length) continue;
      const session = buildTranscriptSession(descriptor, source, {
        sessionDir, sessionName, basename, relativeFiles, records, originalPath, env,
      });
      if (!session || seen.has(session.canonicalId)) continue;
      seen.add(session.canonicalId);
      output.push(session);
    }
  }
  return output.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function computeTranscriptRevision(descriptor, source, { profile = null, env = process.env } = {}) {
  const spec = descriptor.sessions;
  const home = source?.path ?? null;
  if (!home) return null;
  const entries = [];
  for (const rootTemplate of spec.roots) {
    const root = expandTemplate(rootTemplate, { home, profile, env });
    if (!root) continue;
    let top;
    try { top = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    for (const entry of top) {
      const absolute = path.join(root, entry.name);
      const target = spec.layout === 'file-per-session' ? root : absolute;
      const { files } = listRelativeFiles(target);
      for (const relative of selectRelativeFiles(files, spec.transcript.glob)) {
        try {
          const stat = fs.statSync(path.join(target, relative));
          entries.push(`${target}/${relative}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
        } catch { /* a file removed mid-walk simply does not contribute */ }
      }
    }
  }
  // A source with no transcript files at all still needs a stable, non-null revision, otherwise the
  // caller treats "readable but empty" as "unavailable".
  return entries.sort().join('\n');
}
