// `margin agent verify` — optional diagnostics regression suite.
//
// These tests reproduce the Claude Code Tier 1 trial failure mode
// (docs/research/agent-self-integration-tier1-trial.md): the native workspace field lives beyond
// the first line, a descriptor that emits `workspace: null` projects zero sessions, and the
// resulting `no_sessions` verdict must be fully explainable from the result document alone —
// without reading Margin source. They also pin:
//
//   - diagnostic output stability (exact keys, closed reason vocabulary)
//   - the corrected (native workspace + native timestamp) descriptor reaching verified
//   - diagnostics being absent when no discovery ran (none kind, no home)
//
// No new readers, capabilities, or descriptor keys are exercised: the fixture is a plain-file
// JSONL store read through the existing generic transcript adapter.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DIAGNOSTIC_DROP_REASONS,
  createDiscoveryDiagnostics,
} from '../src/agents/descriptor/readers.js';
import {
  formatVerifyResult,
  verifyAgentDescriptor,
} from '../src/agents/agentVerify.js';

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-verify-diag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { USERPROFILE: root, HOME: root };
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

// Claude Code-shaped sessions. The first two records of every file are queue bookkeeping
// (they carry sessionId + timestamp but no cwd); the native cwd first appears on the third
// record (the first `user` record). This is exactly the layout the Tier 1 trial observed.
const CLAUDE_SESSIONS = [
  { uuid: '57743963-86a9-4829-a692-5d1a6c28b509', start: '2026-10-14T16:52:18.331Z', end: '2026-10-14T17:37:05.033Z', title: 'Run the self-integration skill' },
  { uuid: 'ad6f3a48-e0c6-482b-ba09-b2df0173fdfa', start: '2026-10-14T17:02:00.000Z', end: '2026-10-14T17:04:00.000Z', title: 'Connectivity ping' },
  { uuid: 'c1ef090f-2a66-4a6d-a39f-e0734f3f4fea', start: '2026-10-14T17:30:00.000Z', end: '2026-10-14T17:36:00.000Z', title: 'Successful integration run' },
];

const PROJECT_DIR = 'C--Temp-margin-tier1-trial-agent-ws';

function claudeRecords(session, cwd) {
  return [
    { type: 'queue-operation', operation: 'enqueue', timestamp: session.start, sessionId: session.uuid },
    { type: 'queue-operation', operation: 'dequeue', timestamp: session.start, sessionId: session.uuid },
    { type: 'user', timestamp: session.start, sessionId: session.uuid, cwd, message: { role: 'user', content: [{ type: 'text', text: session.title }] } },
    { type: 'assistant', timestamp: session.end, sessionId: session.uuid, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model: 'claude-sonnet-4-6' } },
  ];
}

// A Claude Code home: one encoded project directory containing the three session files.
function writeClaudeHome(profileRoot, { sessions = CLAUDE_SESSIONS, files = {} } = {}) {
  const home = path.join(profileRoot, '.claude');
  const cwd = path.join(profileRoot, 'workspaces', 'agent-ws');
  fs.mkdirSync(cwd, { recursive: true });
  const projectRoot = path.join(home, 'projects', PROJECT_DIR);
  fs.mkdirSync(projectRoot, { recursive: true });
  for (const session of sessions) {
    const content = files[session.uuid] ?? jsonl(claudeRecords(session, cwd));
    fs.writeFileSync(path.join(projectRoot, `${session.uuid}.jsonl`), content);
  }
  return { home, projectRoot, cwd };
}

// The agent's own final descriptor from the trial (minus the trial-scoped machine specifics).
// `workspace: null` is the decisive authoring defect.
function claudeDescriptor(overrides = {}) {
  const descriptor = {
    specVersion: 1,
    type: 'claude_code',
    label: 'Claude Code',
    provider: 'anthropic',
    resourceAgent: 'claude_code',
    defaultSourceName: 'Claude Code',
    homeCandidates: [{ fallback: '{profile}/.claude' }],
    capabilities: {
      sessions: true, handoff: false, apiUsage: false, quota: false,
      executionStatus: false, attentionStatus: false, subscriptionQuota: false,
    },
    sessionCapabilities: { sessions: true },
    sessions: {
      kind: 'transcript',
      layout: 'file-per-session',
      roots: [`{home}/projects/${PROJECT_DIR}`],
      transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'record', where: { type: 'queue-operation', operation: 'enqueue' }, index: 0, path: 'sessionId' },
      createdAt: { kind: 'mtime', glob: '*.jsonl', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: '*.jsonl', pick: 'max' },
      workspace: null,
      title: null,
      model: null,
      provider: null,
    },
    executionStatus: { kind: 'none' },
    resources: { kind: 'none' },
    handoff: { kind: 'none' },
    probe: { anyOf: [{ glob: `{home}/projects/${PROJECT_DIR}/*.jsonl` }] },
  };
  return { ...descriptor, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// The Tier 1 failure mode, reproduced and explainable from the result document.
// ---------------------------------------------------------------------------------------------

test('diagnostics — the workspace-null descriptor reports every observed drop for no_sessions', async (t) => {
  const env = profile(t);
  const fixture = writeClaudeHome(env.USERPROFILE);
  const result = await verifyAgentDescriptor({ descriptor: claudeDescriptor(), env });

  // The verdict and reasonCode contract is unchanged.
  assert.equal(result.verdict, 'no_sessions');
  assert.equal(result.reasonCode, 'reader_returned_empty');
  assert.equal(result.sessions.observed, 0);
  assert.equal(result.sessions.checked, 0);

  const diagnostics = result.diagnostics;
  assert.deepEqual(Object.keys(diagnostics).sort(), [
    'candidateCount', 'dropped', 'entriesExamined', 'matchedFiles', 'projectedCount', 'roots', 'skippedLayout',
  ].sort());

  assert.deepEqual(diagnostics.roots, [{
    root: `{home}/projects/${PROJECT_DIR}`,
    expanded: `${fixture.home}/projects/${PROJECT_DIR}`,
    exists: true,
  }]);
  assert.equal(diagnostics.entriesExamined, 3);
  assert.equal(diagnostics.skippedLayout, 0);
  assert.equal(diagnostics.matchedFiles, 3, 'glob matched the three real session files');
  assert.equal(diagnostics.candidateCount, 3, 'all three reached the projection builder');
  assert.equal(diagnostics.projectedCount, 0);

  assert.equal(diagnostics.dropped.length, 3);
  for (const drop of diagnostics.dropped) {
    assert.deepEqual(Object.keys(drop).sort(), ['missing', 'nativeSessionId', 'path', 'reason'].sort());
    assert.equal(drop.reason, 'missing_workspace');
    assert.deepEqual(drop.missing, ['missing_workspace']);
    assert.equal(typeof drop.nativeSessionId, 'string', 'the id binding observed the native session id');
    assert.match(drop.path, /\.jsonl$/);
  }
  // The recorded paths are the three real session files.
  assert.deepEqual(
    diagnostics.dropped.map((drop) => path.basename(drop.path)).sort(),
    CLAUDE_SESSIONS.map((session) => `${session.uuid}.jsonl`).sort(),
  );
  // The reported native ids are the real ones (id bound, workspace not).
  assert.deepEqual(
    diagnostics.dropped.map((drop) => drop.nativeSessionId).sort(),
    CLAUDE_SESSIONS.map((session) => session.uuid).sort(),
  );
});

test('diagnostics — the failure is explainable from the human output alone', async (t) => {
  const env = profile(t);
  writeClaudeHome(env.USERPROFILE);
  const result = await verifyAgentDescriptor({ descriptor: claudeDescriptor(), env });
  const text = formatVerifyResult(result);

  assert.match(text, /verdict no_sessions/);
  assert.match(text, /3 glob match/);
  assert.match(text, /missing_workspace/);
  assert.match(text, /reader published nothing/);
  // The old "cannot distinguish" sentence is gone: observed drop reasons now exist.
  assert.doesNotMatch(text, /cannot distinguish/);
});

// ---------------------------------------------------------------------------------------------
// The corrected descriptor (diagnostic A in the trial): native workspace and native createdAt.
// ---------------------------------------------------------------------------------------------

test('diagnostics — the corrected descriptor verifies 3 sessions with an empty dropped list', async (t) => {
  const env = profile(t);
  const fixture = writeClaudeHome(env.USERPROFILE);
  const descriptor = claudeDescriptor({
    sessions: {
      ...claudeDescriptor().sessions,
      createdAt: { kind: 'record', where: { type: 'queue-operation', operation: 'enqueue' }, index: 0, path: 'timestamp' },
      workspace: { kind: 'record', where: { type: 'user' }, index: 0, path: 'cwd' },
    },
  });

  const result = await verifyAgentDescriptor({ descriptor, env });
  assert.equal(result.verdict, 'verified', JSON.stringify(result.refusals, null, 2));
  assert.equal(result.reasonCode, null);
  assert.equal(result.sessions.observed, 3);

  const diagnostics = result.diagnostics;
  assert.equal(diagnostics.matchedFiles, 3);
  assert.equal(diagnostics.candidateCount, 3);
  assert.equal(diagnostics.projectedCount, 3);
  assert.deepEqual(diagnostics.dropped, []);

  // Native evidence preserved through the existing adapter.
  const first = result.sessions.sample.find((row) => row.nativeSessionId === '57743963-86a9-4829-a692-5d1a6c28b509');
  assert.equal(first.createdAt, '2026-10-14T16:52:18.331Z');
  assert.equal(first.timestampSource, 'native');
  assert.equal(first.workspaceSource, 'native');
  assert.equal(first.workspace.name, path.basename(fixture.cwd));
  assert.match(first.workspace.key, /agent-ws$/);
});

// ---------------------------------------------------------------------------------------------
// Other observed drop reasons, one per decision point.
// ---------------------------------------------------------------------------------------------

test('diagnostics — a glob matching nothing yields no_transcript_match and an undetermined cause', async (t) => {
  const env = profile(t);
  writeClaudeHome(env.USERPROFILE);
  const descriptor = claudeDescriptor({
    sessions: {
      ...claudeDescriptor().sessions,
      transcript: { glob: '*.nope', format: 'jsonl' },
      createdAt: { kind: 'mtime', glob: '*.nope', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: '*.nope', pick: 'max' },
    },
  });

  const result = await verifyAgentDescriptor({ descriptor, env });
  assert.equal(result.verdict, 'no_sessions');
  assert.equal(result.diagnostics.matchedFiles, 0);
  assert.equal(result.diagnostics.dropped.length, 3);
  for (const drop of result.diagnostics.dropped) {
    assert.deepEqual(Object.keys(drop), ['path', 'reason']);
    assert.equal(drop.reason, 'no_transcript_match');
  }
  const text = formatVerifyResult(result);
  assert.match(text, /cause is not determined/);
});

test('diagnostics — an empty transcript records no_records', async (t) => {
  const env = profile(t);
  const uuid = CLAUDE_SESSIONS[0].uuid;
  writeClaudeHome(env.USERPROFILE, {
    sessions: [CLAUDE_SESSIONS[0]],
    files: { [uuid]: '' },
  });
  const result = await verifyAgentDescriptor({ descriptor: claudeDescriptor(), env });
  assert.equal(result.verdict, 'no_sessions');
  assert.equal(result.diagnostics.matchedFiles, 1);
  assert.equal(result.diagnostics.candidateCount, 0, 'empty files never reach the builder');
  assert.equal(result.diagnostics.dropped.length, 1);
  assert.equal(result.diagnostics.dropped[0].reason, 'no_records');
});

test('diagnostics — multiple missing bindings aggregate into missing_required_evidence', async (t) => {
  const env = profile(t);
  writeClaudeHome(env.USERPROFILE, { sessions: [CLAUDE_SESSIONS[0]] });
  // No workspace binding and no timestamp bindings: id alone is present.
  const descriptor = claudeDescriptor({
    sessions: {
      ...claudeDescriptor().sessions,
      workspace: null,
      createdAt: { kind: 'record', where: { type: 'nonexistent' }, index: 0, path: 'timestamp' },
      updatedAt: { kind: 'record', where: { type: 'nonexistent' }, index: 0, path: 'timestamp' },
    },
  });
  const result = await verifyAgentDescriptor({ descriptor, env });
  assert.equal(result.verdict, 'no_sessions');
  assert.equal(result.diagnostics.dropped.length, 1);
  const drop = result.diagnostics.dropped[0];
  assert.equal(drop.reason, 'missing_required_evidence');
  assert.deepEqual(drop.missing, ['missing_workspace', 'missing_created_at', 'missing_updated_at']);
  assert.equal(drop.nativeSessionId, CLAUDE_SESSIONS[0].uuid, 'the observed id is still reported');
});

test('diagnostics — two candidates with the same id record duplicate_session', async (t) => {
  const env = profile(t);
  const sharedId = 'shared-id-0001';
  const home = path.join(env.USERPROFILE, '.claude');
  const cwdA = path.join(env.USERPROFILE, 'workspaces', 'a');
  const cwdB = path.join(env.USERPROFILE, 'workspaces', 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  // directory-per-session: two session dirs whose id extractor yields the same native id.
  const root = path.join(home, 'projects', 'group');
  for (const [dirName, cwd] of [['sess-a', cwdA], ['sess-b', cwdB]]) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
      { kind: 'session.start', session: { id: sharedId, cwd, createdAt: '2026-05-04T09:00:00.000Z' } },
      { kind: 'session.end', session: { updatedAt: '2026-05-04T09:10:00.000Z' } },
    ]));
  }
  const descriptor = claudeDescriptor({
    sessions: {
      kind: 'transcript',
      layout: 'directory-per-session',
      roots: ['{home}/projects/group'],
      transcript: { glob: 'events.jsonl', format: 'jsonl' },
      id: { kind: 'record', where: { kind: 'session.start' }, index: 0, path: 'session.id' },
      createdAt: { kind: 'record', where: { kind: 'session.start' }, index: 0, path: 'session.createdAt' },
      updatedAt: { kind: 'record', where: { kind: 'session.end' }, index: 0, path: 'session.updatedAt' },
      workspace: { kind: 'record', where: { kind: 'session.start' }, index: 0, path: 'session.cwd' },
      title: null, model: null, provider: null,
    },
    probe: { anyOf: [{ glob: '{home}/projects/group/*/events.jsonl' }] },
  });

  const result = await verifyAgentDescriptor({ descriptor, env });
  assert.equal(result.verdict, 'verified');
  assert.equal(result.diagnostics.projectedCount, 1);
  assert.equal(result.diagnostics.dropped.length, 1);
  assert.equal(result.diagnostics.dropped[0].reason, 'duplicate_session');
  assert.equal(result.diagnostics.dropped[0].nativeSessionId, sharedId);
});

// ---------------------------------------------------------------------------------------------
// Stability: vocabulary, factory, and absence boundaries.
// ---------------------------------------------------------------------------------------------

test('diagnostics — the drop reason vocabulary is closed', () => {
  for (const reason of DIAGNOSTIC_DROP_REASONS) assert.match(reason, /^[a-z_]+$/);
  assert.deepEqual([...DIAGNOSTIC_DROP_REASONS].sort(), [
    'duplicate_session', 'missing_created_at', 'missing_native_session_id',
    'missing_required_evidence', 'missing_updated_at', 'missing_workspace',
    'no_records', 'no_transcript_match',
  ].sort());
});

test('diagnostics — the factory yields a zeroed, JSON-safe sink', () => {
  const sink = createDiscoveryDiagnostics();
  assert.equal(JSON.parse(JSON.stringify(sink)).projectedCount, 0);
  assert.deepEqual(sink.dropped, []);
  assert.deepEqual(sink.roots, []);
});

test('diagnostics — absent when no discovery ran (none kind and missing home)', async (t) => {
  const env = profile(t);
  const none = claudeDescriptor({ sessions: { kind: 'none' } });
  const noneResult = await verifyAgentDescriptor({ descriptor: none, env });
  assert.equal(noneResult.verdict, 'unavailable');
  assert.equal(noneResult.reasonCode, 'session_source_not_declared');
  assert.equal('diagnostics' in noneResult, false);

  const noHome = await verifyAgentDescriptor({ descriptor: claudeDescriptor(), env });
  assert.equal(noHome.verdict, 'unavailable');
  assert.equal(noHome.reasonCode, 'no_home_found');
  assert.equal('diagnostics' in noHome, false);
});
