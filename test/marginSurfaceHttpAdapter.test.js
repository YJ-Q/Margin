import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandoffHttpAdapter } from '../src/core/handoff/httpAdapter.js';
import { resumableSessions } from '../src/core/handoff/session-source.js';

async function withServer(app, action) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function withRepo(action) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'margin-surface-repo-'));
  try { return await action(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('GET /api/resources/status is independent, read-only, and fail-soft', async () => {
  const app = createHandoffHttpAdapter({
    rootDir: os.tmpdir(),
    readRegistry: () => ({ version: 1, sources: [] }),
    writeRegistry: (registry) => registry,
    getAgentResourceStatus: () => ({ agents: [{ agent: 'codex', resources: [{ windowDurationMinutes: 300, percentUsed: 59, resetsAt: 1 }] }, { agent: 'claude-code', unavailable: true }] })
  });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/resources/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ok');
    // Each agent carries the display metadata its descriptor declares, so the bar never has to infer
    // a label or a subscription prefix from a resource key.
    assert.deepEqual(body.agents, [{ agent: 'codex', label: 'Codex', resources: [{ windowDurationMinutes: 300, percentUsed: 59, resetsAt: 1 }] }, { agent: 'claude-code', label: 'Claude', quotaPrefix: 'Go', revision: null, freshAt: null, stale: false, unavailable: true, resources: [] }, { agent: 'pi', label: 'Pi', quotaPrefix: 'Go', provider: 'pi', revision: null, freshAt: null, stale: false, unavailable: true, resources: [] }]);
  });
  const failed = createHandoffHttpAdapter({ rootDir: os.tmpdir(), readRegistry: () => ({ version: 1, sources: [] }), writeRegistry: (registry) => registry, getAgentResourceStatus: () => { throw new Error('source failed'); } });
  await withServer(failed, async (origin) => {
    const body = await (await fetch(`${origin}/api/resources/status`)).json();
    assert.equal(body.agents[0].unavailable, true);
    assert.equal(body.agents[1].agent, 'claude-code');
  });
});

test('GET /api/resources/status folds an enabled Claude adapter result without exposing provider credentials', async () => {
  const claudeSource = { type: 'claude', agentType: 'claude', path: 'synthetic-claude-home', sourceId: 'claude-source', id: 'claude-source', enabled: true };
  let receivedSource;
  const app = createHandoffHttpAdapter({
    rootDir: os.tmpdir(),
    readRegistry: () => ({ version: 1, sources: [claudeSource] }),
    writeRegistry: (registry) => registry,
    getAgentResourceStatus: () => ({ agents: [{ agent: 'codex', resources: [] }] }),
    adapterResolver: (type) => type === 'claude' ? {
      getSessionRevision: () => 'claude-revision',
      collectResourceSnapshot: async (source) => {
        receivedSource = source;
        return { ok: true, status: 'ok', revision: 'claude-revision', agents: [{
          agent: 'claude-code', provider: 'opencode-go', subscriptionQuota: true, stale: false, freshAt: '2026-09-09T08:00:00.000Z',
          resources: [{ resourceType: 'quota', accessMode: 'subscription', window: '5h', windowDurationMinutes: 300, remaining: 86 }],
        }] };
      },
    } : null,
  });
  await withServer(app, async (origin) => {
    const body = await (await fetch(`${origin}/api/resources/status`)).json();
    assert.equal(body.ok, true);
    assert.equal(receivedSource.path, path.resolve(claudeSource.path));
    assert.deepEqual(body.agents.map((agent) => agent.agent), ['codex', 'claude-code', 'pi']);
    assert.deepEqual(body.agents.find((agent) => agent.agent === 'claude-code').resources.map((resource) => resource.remaining), [86]);
    assert.doesNotMatch(JSON.stringify(body), /credential|api[_-]?key|secret/i);
  });
});

test('GET /api/sessions returns only fields the discovery layer actually provided', async () => {
  const sessions = [{
    id: 's1', cwd: 'D:\\repo', branch: 'main', gitSha: 'abc', summary: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', originalPath: 'x.jsonl'
  }];
  const app = createHandoffHttpAdapter({ rootDir: os.tmpdir(), discoverSessions: async () => sessions });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/sessions`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    const [session] = body.data.sessions;
    assert.equal(session.id, 's1'); assert.equal(session.nativeSessionId, 's1'); assert.equal(session.agentType, 'codex');
    assert.equal(session.canonicalId, `codex:${session.sourceId}:s1`); assert.equal(session.agent, 'Codex'); assert.equal(session.cwd, 'D:\\repo');
    assert.deepEqual(session.workspace, { key: null, name: null }); assert.equal(session.branch, 'main');
    assert.deepEqual([session.displayTitle, session.titleSource], ['Untitled session · s1', 'fallback-id']);
    assert.deepEqual([session.createdAt, session.updatedAt, session.executionStatus, session.attentionStatus], ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'unknown', 'none']);
    assert.deepEqual(session.capabilities, { sessions: true, handoff: true, apiUsage: true, quota: true, executionStatus: true, attentionStatus: false });
  });
});

test('GET /api/sessions clamps and forwards the limit parameter', async () => {
  let receivedLimit;
  const app = createHandoffHttpAdapter({
    rootDir: os.tmpdir(),
    discoverSessions: async (_home, { limit } = {}) => { receivedLimit = limit; return []; }
  });
  await withServer(app, async (origin) => {
    await fetch(`${origin}/api/sessions?limit=500`);
  });
  assert.equal(receivedLimit, 20);
});

test('Slice 3.3: Workspace Overview uses the full resumable discovery result, not the global list cap', async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    id: `s${index}`, workspaceKey: 'git:repo', workspaceName: 'repo', cwd: 'D:\\repo',
    updatedAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
  }));
  let overviewSessions;
  const app = createHandoffHttpAdapter({
    rootDir: os.tmpdir(), discoverSessions: async (_home, options) => options?.limit ? sessions.slice(0, options.limit) : sessions,
    createWorkspaceOverview: ({ sessions: input }) => { overviewSessions = input; return { workspaceKey: 'git:repo', workspaceName: 'repo', otherResumableSessionCount: 11,
      latestSession: { id: 's11', label: 'Latest', updatedAt: null, historicalBranch: null, goal: { status: 'unknown', text: 'Unknown' }, progress: { text: 'Unknown' }, currentApplicability: { status: 'unknown', text: 'Unknown' } },
      repo: { observedAt: 'now', stableDuringObservation: true, branch: 'main', shortHead: 'abc', dirtyCount: 0 } }; }
  });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/workspace-overview?workspaceKey=git%3Arepo`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.latestSession.id, 's11');
  });
  assert.equal(overviewSessions.length, 12);
});

test('Slice 3.3: workspace session navigation returns all and only that workspace', async () => {
  const sessions = [
    { id: 'other', workspaceKey: 'git:other', workspaceName: 'other' },
    { id: 'old', workspaceKey: 'git:repo', workspaceName: 'repo' },
    { id: 'latest', workspaceKey: 'git:repo', workspaceName: 'repo' },
  ];
  const app = createHandoffHttpAdapter({ rootDir: os.tmpdir(), discoverSessions: async () => sessions });
  await withServer(app, async (origin) => {
    const body = await (await fetch(`${origin}/api/sessions?workspaceKey=git%3Arepo`)).json();
    assert.deepEqual(body.data.sessions.map((session) => session.id), ['old', 'latest']);
  });
});

test('POST /api/handoff/generate calls the real Core pipeline and returns only browser-safe checkpoint fields', async () => {
  await withRepo(async (repo) => {
    const meta = { id: 'abc', nativeSessionId: 'abc', canonicalId: 'codex:source-a:abc', sourceId: 'source-a', agentType: 'codex', cwd: repo, originalPath: 'orig.jsonl' };
    let capturedRepo, capturedSessionMeta;
    const app = createHandoffHttpAdapter({
      rootDir: os.tmpdir(),
      discoverSessions: async () => [meta],
      captureSession: (sessionMeta) => { capturedSessionMeta = sessionMeta; return { snapshotPath: 'x', sha256: 'x' }; },
      generateHandoff: (_capture, workspace) => { capturedRepo = workspace; return {
        markdown: '# Margin Smart Handoff\n\nreal core output',
        resumeSummary: { goal: { text: 'Historical goal', confidence: 'Inferred' }, progress: [], currentApplicability: { status: 'unknown', text: 'Check first' }, currentValidation: { status: 'unknown', text: 'Validation not rerun' } },
        evidence: { raw: 'must not leak' }, truth: { sourcePath: 'must not leak' }, state: { operations: ['must not leak'] }
      }; }
    });
    await withServer(app, async (origin) => {
      const response = await fetch(`${origin}/api/handoff/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: meta.canonicalId })
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.data.markdown, '# Margin Smart Handoff\n\nreal core output');
      assert.equal(body.data.session.id, 'abc');
      assert.equal(body.data.resumeSummary.goal.text, 'Historical goal');
      assert.deepEqual(Object.keys(body.data).sort(), ['markdown', 'resumeSummary', 'session']);
      assert.doesNotMatch(JSON.stringify(body.data), /must not leak/);
    });
    assert.equal(capturedRepo, repo);
    assert.equal(capturedSessionMeta.id, 'abc');
  });
});

test('POST /api/handoff/generate returns not_found for an unknown session id', async () => {
  const app = createHandoffHttpAdapter({ rootDir: os.tmpdir(), discoverSessions: async () => [] });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/handoff/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'missing' })
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'not_found');
  });
});

test('POST /api/handoff/generate never resolves a shared native id across sources', async () => {
  await withRepo(async (repo) => {
    const first = { id: 'same-native-id', nativeSessionId: 'same-native-id', canonicalId: 'codex:source-a:same-native-id', sourceId: 'source-a', agentType: 'codex', cwd: repo, originalPath: 'first.jsonl' };
    const second = { ...first, canonicalId: 'codex:source-b:same-native-id', sourceId: 'source-b', originalPath: 'second.jsonl' };
    let captured;
    const app = createHandoffHttpAdapter({
      rootDir: repo, discoverSessions: async () => [first, second],
      captureSession: (meta) => { captured = meta; return { snapshotPath: 'ignored', sha256: 'ignored' }; },
      generateHandoff: () => ({ markdown: '# exact', resumeSummary: {} }),
    });
    await withServer(app, async (origin) => {
      const exact = await fetch(`${origin}/api/handoff/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: second.canonicalId }),
      });
      assert.equal(exact.status, 200);
      assert.equal(captured.originalPath, second.originalPath);
      const ambiguous = await fetch(`${origin}/api/handoff/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: first.nativeSessionId }),
      });
      assert.equal(ambiguous.status, 404);
    });
  });
});

test('POST /api/handoff/save writes .margin/HANDOFF.md under the repo, creating the directory if needed', async () => {
  await withRepo(async (repo) => {
    const app = createHandoffHttpAdapter({ rootDir: os.tmpdir() });
    await withServer(app, async (origin) => {
      const response = await fetch(`${origin}/api/handoff/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, markdown: '# Checkpoint one' })
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.data.path, path.join(repo, '.margin', 'HANDOFF.md'));
    });
    const written = await readFile(path.join(repo, '.margin', 'HANDOFF.md'), 'utf8');
    assert.equal(written, '# Checkpoint one');
  });
});

test('POST /api/handoff/save overwrites an existing checkpoint with the new one (no history kept)', async () => {
  await withRepo(async (repo) => {
    const app = createHandoffHttpAdapter({ rootDir: os.tmpdir() });
    await withServer(app, async (origin) => {
      await fetch(`${origin}/api/handoff/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, markdown: '# First checkpoint' })
      });
      await fetch(`${origin}/api/handoff/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, markdown: '# Second checkpoint' })
      });
    });
    const written = await readFile(path.join(repo, '.margin', 'HANDOFF.md'), 'utf8');
    assert.equal(written, '# Second checkpoint');
  });
});

test('HTTP generation uses canonical identity, fresh capture, and saves the exact returned artifact', async () => {
  await withRepo(async (repo) => {
    const native = path.join(repo, 'rollout.jsonl');
    const canonicalId = 'codex:source-a:native:with:colon';
    await writeFile(native, '{"type":"first"}\n');
    const meta = { id: 'native:with:colon', nativeSessionId: 'native:with:colon', canonicalId, sourceId: 'source-a', agentType: 'codex', cwd: repo, originalPath: native };
    const app = createHandoffHttpAdapter({
      rootDir: repo,
      discoverSessions: async () => [meta],
      generateHandoff: (capture) => ({ markdown: fs.readFileSync(capture.snapshotPath, 'utf8'), resumeSummary: {} }),
    });
    await withServer(app, async (origin) => {
      const generate = async () => (await (await fetch(`${origin}/api/handoff/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: canonicalId }),
      })).json());
      const first = await generate();
      assert.equal(first.ok, true);
      await writeFile(native, '{"type":"first"}\n{"type":"new-complete"}\n{"type":"partial');
      const second = await generate();
      assert.equal(second.ok, true);
      assert.match(second.data.markdown, /new-complete/);
      assert.doesNotMatch(second.data.markdown, /partial/);
      assert.notEqual(second.data.markdown, first.data.markdown);
      const snapshotNames = await readdir(path.join(repo, 'handoff-output', 'web-sessions'));
      assert.ok(snapshotNames.every((name) => !name.includes(':')));
      const save = await fetch(`${origin}/api/handoff/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, markdown: second.data.markdown }),
      });
      assert.equal(save.status, 200);
      assert.equal(await readFile(path.join(repo, '.margin', 'HANDOFF.md'), 'utf8'), second.data.markdown);
    });
  });
});

test('POST /api/handoff/save rejects a repo path that is not a real directory', async () => {
  const app = createHandoffHttpAdapter({ rootDir: os.tmpdir() });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/handoff/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: path.join(os.tmpdir(), 'does-not-exist-xyz'), markdown: '# x' })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_repo');
  });
});

test('Slice 2.3: GET /api/sessions serves the already-filtered resumable list — an internal Codex thread never reaches the UI DTO', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'margin-resumable-http-'));
  try {
    // Real native rollout shapes: one explicit guardian_review thread, one normal user thread.
    const meta = (id, source, threadSource) => JSON.stringify({ timestamp: '2026-09-05T10:10:08.267Z', type: 'session_meta',
      payload: { session_id: id, id, cwd: 'D:\\Code\\margin', originator: 'Codex Desktop', cli_version: '0.153.4',
        source, ...(threadSource ? { thread_source: threadSource } : {}) } }) + '\n';
    const internal = path.join(dir, 'rollout-guardian.jsonl');
    const normal = path.join(dir, 'rollout-user.jsonl');
    await writeFile(internal, meta('g1', { subagent: { other: 'guardian' } }, 'guardian_review'));
    await writeFile(normal, meta('u1', 'vscode', 'user'));

    // The Core boundary (resumableSessions — what discoverSessions() applies to continues'
    // output) has already dropped g1 before this list reaches the adapter.
    const discovered = [
      { id: 'g1', cwd: 'D:\\Code\\margin', branch: 'main', createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-05T11:00:00.000Z'), originalPath: internal, threadSource: 'guardian_review' },
      { id: 'u1', cwd: 'D:\\Code\\margin', branch: 'main', createdAt: new Date('2026-01-02T00:00:00.000Z'),
        updatedAt: new Date('2026-09-05T12:00:00.000Z'), originalPath: normal, threadSource: 'user' },
    ];
    const app = createHandoffHttpAdapter({
      rootDir: os.tmpdir(),
      discoverSessions: async () => resumableSessions(discovered),
    });
    await withServer(app, async (origin) => {
      const response = await fetch(`${origin}/api/sessions`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.sessions.map((s) => s.id), ['u1']);
      // The adapter does not re-filter and never leaks the internal thread or its metadata.
      const raw = JSON.stringify(body.data);
      assert.ok(!raw.includes('g1'));
      assert.ok(!raw.includes('threadSource') && !raw.includes('thread_source'));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
