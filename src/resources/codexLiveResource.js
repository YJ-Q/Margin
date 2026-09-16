import fs from 'node:fs';
import path from 'node:path';

// S3 Realtime Resource Telemetry — incremental, provider-backed live reader.
//
// This module owns the near-real-time token/quota view for the Agent Resource Bar. It reads only
// the ACTIVE `{codexHome}/sessions` tree (never `archived_sessions`, matching S1/S2 lifecycle
// semantics) and keeps per-rollout byte offsets so an append is read incrementally (O(appended),
// never O(file) per poll tick). It derives, from provider-reported native records only:
//   - quota (subscription 5h/7d windows) from `event_msg/payload.type="token_count"` `.rate_limits`
//   - token (foreground user session cumulative usage) from the same `token_count` `.info.total_token_usage`
//     plus the adjacent per-request `token_usage_record` `.usage` for S4 provenance
//
// It keeps an in-process revision-keyed cache plus a last-known-good quota snapshot so an unchanged
// revision never triggers a re-read and a session archive/switch never flashes quota to unavailable.
//
// Foreground selection: prefer active rollouts whose `session_meta.thread_source` is an end-user thread
// (missing => user, matching S1; explicit subagent/guardian/control rollouts are excluded), newest-mtime
// among those; max-mtime active rollout is only the fallback when no user thread exists. A subagent/
// control rollout therefore can never preempt the displayed user-session token state.

const USER_INTERNAL = (threadSource) => Boolean(threadSource) && threadSource !== 'user';

function posInt(value) { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : null; }

function parseModel(text) {
  const m = String(text ?? '').match(/(?:GPT-|gpt-)\d+(?:\.\d+)?(?:-[a-zA-Z0-9-]+)?|o\d+(?:-[a-zA-Z0-9-]+)?|grok-[\w.-]+|claude-[\w.-]+|deepseek[\w-]*/i);
  return m ? m[0] : null;
}

function metaFromSessionMeta(rec) {
  const payload = rec?.payload ?? {};
  const instructions = typeof payload.base_instructions === 'string'
    ? payload.base_instructions
    : (payload.base_instructions?.text ?? '');
  return {
    isUser: !USER_INTERNAL(payload.thread_source),
    sessionId: typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id : null,
    model: parseModel(instructions),
    provider: typeof payload.model_provider === 'string' && payload.model_provider.trim() ? payload.model_provider : 'openai',
  };
}

// Enumerate ACTIVE rollouts. A missing sessions tree is the legitimate empty case (fresh home);
// any other read error (EACCES/EIO/…) is a real read failure the caller must surface as stale LKG,
// never as a fresh empty view.
function enumerateActiveRollouts(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return; // vanished mid-walk: transient, not a truth
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!/^rollout-.+\.jsonl$/i.test(entry.name)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      out.push({ path: full, size: st.size, mtime: st.mtimeMs });
    }
  };
  const sessionsRoot = path.join(root, 'sessions');
  let st;
  try { st = fs.statSync(sessionsRoot); }
  catch (error) { if (error?.code === 'ENOENT') return out; throw error; } // no tree yet = legitimately empty
  if (!st.isDirectory()) return out;
  visit(sessionsRoot);
  return out;
}

export function createCodexLiveResourceReader({ now = () => new Date().toISOString() } = {}) {
  const homes = new Map();

  function ensure(home) {
    let s = homes.get(home);
    if (!s) {
      s = {
        seenOffset: new Map(),
        meta: new Map(),        // path -> { isUser, sessionId, model, provider }
        view: new Map(),        // path -> newest token view for that file
        quotaLkg: null,         // { timestamp(Date), rateLimits } newest trusted snapshot
        lastRevision: null,
        lastFreshAt: null,
        lastObservedAt: null,
        lastForeground: null,   // active rollout { path, mtime } whose token is shown
        lastStale: false,
      };
      homes.set(home, s);
    }
    return s;
  }

  function readRangeBytes(fd, start, length) {
    if (length <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      let n = 0; try { n = fs.readSync(fd, buf, done, length - done, start + done); } catch { break; }
      if (n === 0) break;
      done += n;
    }
    return buf.subarray(0, done);
  }

  function readHeadMeta(full) {
    let fd; try { fd = fs.openSync(full, 'r'); } catch { return null; }
    try {
      const probe = Buffer.allocUnsafe(64 * 1024);
      let n = 0; try { n = fs.readSync(fd, probe, 0, probe.length, 0); } catch { return null; }
      if (n <= 0) return null;
      const head = probe.subarray(0, n).toString('utf8').replace(/^﻿/, '');
      const nl = head.indexOf('\n');
      const first = (nl === -1 ? head : head.slice(0, nl)).trim();
      if (!first) return null;
      const rec = JSON.parse(first);
      return rec.type === 'session_meta' ? metaFromSessionMeta(rec) : null;
    } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  // Fold one native record into per-file token view + global quota LKG.
  function ingest(state, file, rec) {
    if (rec.type === 'session_meta') { state.meta.set(file.path, metaFromSessionMeta(rec)); return; }
    const ts = new Date(rec?.timestamp);
    const t = Number.isNaN(ts.getTime()) ? null : ts.getTime();
    const p = rec.payload || {};

    if (rec.type === 'token_usage_record') {
      if (p.usage && typeof p.usage === 'object') {
        const prev = state.view.get(file.path);
        const isNewer = t !== null && (!prev?.at || t >= prev.at);
        if (isNewer || !prev?.usage) {
          state.view.set(file.path, {
            ...(prev && prev.usage ? prev : {}),
            sessionId: (prev && prev.sessionId) || p.session_id || null,
            threadId: (prev && prev.threadId) || p.thread_id || null,
            responseId: p.response_id || (prev && prev.responseId) || null,
            at: isNewer ? t : (prev?.at ?? null),
            perRequest: p.usage,
          });
        }
      }
      return;
    }

    if (rec.type === 'event_msg' && p.type === 'token_count') {
      if (p.rate_limits && typeof p.rate_limits === 'object' && t !== null) {
        if (!state.quotaLkg || t > state.quotaLkg.timestamp.getTime()) {
          state.quotaLkg = { timestamp: ts, rateLimits: p.rate_limits };
        }
      }
      const total = p.info?.total_token_usage;
      if (total && typeof total === 'object' && t !== null) {
        const prev = state.view.get(file.path);
        const isNewer = !prev?.usageAt || t >= prev.usageAt;
        if (isNewer) {
          state.view.set(file.path, { ...(prev || {}), usage: total, usageAt: t, at: t });
        }
      }
      return;
    }
  }

  // Incrementally read complete new lines of one rollout; partial trailing line is never parsed.
  function ingestRollout(state, file) {
    const start = state.seenOffset.get(file.path) ?? 0;
    if (file.size < start) { state.seenOffset.set(file.path, 0); return; }
    if (file.size <= start) return;
    let fd; try { fd = fs.openSync(file.path, 'r'); } catch { return; }
    try {
      const chunk = readRangeBytes(fd, start, file.size - start);
      const nl = chunk.lastIndexOf(0x0a);
      const end = nl === -1 ? 0 : nl + 1;
      if (end > 0) {
        const text = chunk.subarray(0, end).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let rec; try { rec = JSON.parse(line); } catch { continue; }
          ingest(state, file, rec);
        }
        state.seenOffset.set(file.path, start + end);
      }
      // end === 0: nothing complete; keep the offset so the next append re-reads.
    } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  function pickForeground(state, files) {
    const known = files.filter((f) => (state.meta.get(f.path)?.isUser ?? true));
    const pool = known.length ? known : files;
    if (!pool.length) return null;
    pool.sort((a, b) => b.mtime - a.mtime);
    return pool[0];
  }

  function buildTokenRecord(state, foreground) {
    const view = foreground ? state.view.get(foreground.path) : null;
    const u = view?.usage;
    if (!view || !u) return null;
    const meta = foreground ? (state.meta.get(foreground.path) ?? {}) : {};
    return {
      resourceType: 'tokenUsage', agent: 'codex',
      provider: meta.provider ?? 'openai', model: view.model ?? meta.model ?? null,
      sessionId: view.sessionId ?? meta.sessionId ?? null,
      threadId: view.threadId ?? null, responseId: view.responseId ?? null,
      inputTokens: posInt(u.input_tokens), cachedInputTokens: posInt(u.cached_input_tokens),
      outputTokens: posInt(u.output_tokens), reasoningTokens: posInt(u.reasoning_output_tokens),
      totalTokens: posInt(u.total_tokens),
      lastInputTokens: posInt(view.perRequest?.input_tokens), lastCachedInputTokens: posInt(view.perRequest?.cached_input_tokens),
      lastOutputTokens: posInt(view.perRequest?.output_tokens), lastReasoningTokens: posInt(view.perRequest?.reasoning_output_tokens),
      lastTotalTokens: posInt(view.perRequest?.total_tokens),
    };
  }

  function currentView(state) {
    const quotaSnapshot = state.quotaLkg;
    const foreground = state.lastForeground;
    return { quotaSnapshot, token: buildTokenRecord(state, foreground), freshAt: state.lastFreshAt, observedAt: state.lastObservedAt, stale: state.lastStale };
  }

  function read({ codexHome, revision }) {
    const home = path.resolve(String(codexHome));
    const state = ensure(home);
    // Keep the clock used for this read with the view. The resource service uses it when
    // applying resetAt semantics; this is also what makes injected clocks deterministic.
    state.lastObservedAt = now();
    // Cache only a known-fresh view. A stale flag means the LAST read failed: the same revision
    // must be re-verified (full read) rather than served from cache, so recovery restores fresh
    // automatically without waiting for a revision change.
    if (revision != null && revision === state.lastRevision && !state.lastStale) {
      return { ...currentView(state), cached: true, revision };
    }
    // A real enumeration failure propagates to snapshot() so it is handled as a stale LKG read —
    // it must never reach the success path below (which would advance freshAt, clear stale and
    // commit the failed revision as truth).
    const files = enumerateActiveRollouts(home);
    for (const file of files) ingestRollout(state, file);
    for (const file of files) {
      if (!state.meta.has(file.path)) {
        const meta = readHeadMeta(file.path);
        state.meta.set(file.path, meta ?? { isUser: true, sessionId: null, model: null, provider: 'openai' });
      }
    }
    const foreground = pickForeground(state, files);
    state.lastForeground = foreground;
    state.lastFreshAt = now();
    state.lastStale = false;
    state.lastRevision = revision;
    return { ...currentView(state), cached: false, revision };
  }

  // Fail-safe entry: a transient read error returns the last-known-good marked stale — freshAt is
  // never advanced and the failed revision is never committed, so the SAME revision is retried on
  // the next call. Only a truly unavailable source with no LKG returns a cleared view.
  function snapshot({ codexHome, revision }) {
    try { return read({ codexHome, revision }); }
    catch {
      const state = homes.get(path.resolve(String(codexHome)));
      if (state) {
        state.lastStale = true;
        const view = currentView(state);
        if (view.quotaSnapshot || view.token) return { ...view, stale: true, readFailed: true, cached: false, revision };
      }
      return { quotaSnapshot: null, token: null, freshAt: null, stale: false, cached: false, revision, unavailable: true, readFailed: true };
    }
  }

  return { read, snapshot, reset() { homes.clear(); } };
}

// Shared module reader so offsets + last-known-good persist across HTTP requests within one process.
export const defaultCodexLiveResourceReader = createCodexLiveResourceReader();
