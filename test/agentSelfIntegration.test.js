// Agent self-integration validation — a synthetic "unknown future Agent" fixture.
//
// This test validates whether Margin's existing descriptor protocol can accept an Agent it has
// never seen, with NO Margin code change and NO hand-written adapter. It runs the six-stage
// workflow end to end:
//
//   Nova fixture  →  Integration Skill output (plugins/nova/agent.json)
//                 →  validateDescriptor
//                 →  installAgentDescriptor --dry-run
//                 →  install + composeAdapter (adapterFor)
//                 →  read-only verification (home resolution + probe + projection invariants)
//                 →  session discovery
//
// The fixture (below) is deliberately NOT shaped like the shipped 豆包 plugin. 豆包 has no native
// working directory and no native timestamps, so it leans on `scanAbsolutePaths` and `mtime`. Nova
// is the opposite and therefore a harder case for the catalogue: every projection field is a NATIVE
// value read from a nested record stream, and the native session id is deliberately different from
// the rollout directory name.
//
// Nothing in this file modifies Margin. Everything it installs goes into a fresh temp profile.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installAgentDescriptor, uninstallAgentDescriptor } from '../src/agents/agentInstall.js';
import { adapterFor } from '../src/agents/adapters.js';
import { hasBuiltinAdapter, resetDescriptorCache } from '../src/agents/descriptor/load.js';
import { normalizeDescriptor, validateDescriptor } from '../src/agents/descriptor/spec.js';
import { discoverTranscriptSessions, isPathContained, resolveAgentHome } from '../src/agents/descriptor/readers.js';
import { builtinDescriptors } from '../src/agents/descriptor/builtin.js';
import { detectAgentSources, readAgentSourceRegistry } from '../src/agents/sourceRegistry.js';

const novaDescriptorPath = new URL('../plugins/nova/agent.json', import.meta.url);
const readNovaDescriptor = () => JSON.parse(fs.readFileSync(novaDescriptorPath, 'utf8'));

const ADAPTER_METHODS = ['detect', 'validateSource', 'collectSessionSnapshots', 'readSessionSnapshots', 'getSessionRevision', 'getResourceStatus', 'collectResourceSnapshot', 'discoverSessions'];

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-self-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { USERPROFILE: root, HOME: root };
}

// ---------------------------------------------------------------------------------------------
// The fixture. A declarative spec of what the unknown Agent wrote to disk; `writeNovaFixture`
// materialises it. The `cwd` values are the only machine-local part — a real Agent records the
// absolute working directory it actually ran in, so the fixture builder writes real temp paths.
// ---------------------------------------------------------------------------------------------

const NOVA_FIXTURE_SESSIONS = [
  {
    dir: 'rollout_0001',
    nativeId: 'nova-7f3a1c9e',
    workspace: 'margin-core',
    createdAt: '2026-05-04T09:12:33.000Z',
    updatedAt: '2026-05-04T09:41:07.000Z',
    title: 'Wire descriptor validation harness',
    finishReason: 'stop',
    model: 'nova-2-large',
    provider: 'nova-labs',
  },
  {
    dir: 'rollout_0002',
    nativeId: 'nova-2b8d4f01',
    workspace: 'margin-web',
    createdAt: '2026-05-04T10:02:11.000Z',
    updatedAt: '2026-05-04T10:05:48.000Z',
    title: 'Fix workspace name resolution',
    finishReason: 'error',
    model: 'nova-1-small',
    provider: 'nova-labs',
  },
  {
    // A rollout that crashed before writing `session.end`. Its updatedAt cannot be read, so the
    // published-session rule (`buildTranscriptSession`) must DROP it rather than invent a timestamp.
    dir: 'rollout_0003',
    nativeId: 'nova-9c0e5a77',
    workspace: 'margin-core',
    createdAt: '2026-05-04T11:00:00.000Z',
    updatedAt: null,
    title: 'Interrupted rollout',
    finishReason: 'tool_use',
    model: 'nova-2-large',
    provider: 'nova-labs',
  },
];

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

function writeNovaFixture(profileRoot) {
  const home = path.join(profileRoot, 'nova-home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspaces = new Map();

  for (const session of NOVA_FIXTURE_SESSIONS) {
    const cwd = path.join(profileRoot, 'workspaces', session.workspace);
    if (!workspaces.has(session.workspace)) {
      fs.mkdirSync(cwd, { recursive: true });
      workspaces.set(session.workspace, cwd);
    }
    const dir = path.join(sessionsRoot, session.dir);
    fs.mkdirSync(dir, { recursive: true });
    const records = [
      { kind: 'session.start', seq: 1, session: { id: session.nativeId, cwd, createdAt: session.createdAt }, title: session.title },
      { kind: 'turn.user', seq: 2, text: session.title },
      { kind: 'turn.assistant', seq: 3, finishReason: session.finishReason, model: session.model, provider: session.provider },
    ];
    // `updatedAt: null` models the interrupted write: no session.end record at all.
    if (session.updatedAt) records.push({ kind: 'session.end', seq: 4, session: { updatedAt: session.updatedAt } });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl(records));
  }

  return { home, workspaces, sessionDir: (dirName) => path.join(sessionsRoot, dirName) };
}

// ---------------------------------------------------------------------------------------------
// Read-only verification. This is the harness for the PROPOSED `margin agent verify` verb (V4 in
// docs/research/s10.1b-decision.md), which does not exist yet. It uses only existing exports and
// performs no writes: it resolves the home, probes it, projects sessions, and checks the
// projection invariants the readers are supposed to guarantee.
// ---------------------------------------------------------------------------------------------

async function verifyNovaIntegration({ descriptor, env, adapter, source }) {
  const normalized = normalizeDescriptor(descriptor);
  const resolution = resolveAgentHome(normalized, { env, homedir: env.USERPROFILE, profile: env.USERPROFILE });
  const probe = adapter.probe(source, { env });
  const snapshots = await adapter.collectSessionSnapshots(source, { env });
  const envelope = await adapter.readSessionSnapshots(source, { env });

  const failures = [];
  for (const session of snapshots) {
    if (!session.nativeSessionId) failures.push(`${session.canonicalId}: missing nativeSessionId`);
    if (!session.cwd) failures.push(`${session.canonicalId}: missing cwd`);
    if (!session.workspaceKey || !session.workspaceName) failures.push(`${session.canonicalId}: unresolved workspace`);
    if (!Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt))) {
      failures.push(`${session.canonicalId}: unparseable timestamps`);
    }
  }

  return { resolution, probe, snapshots, envelope, failures };
}

// A helper that reads the resolved source exactly the way a host would, so verification never
// trusts in-memory state.
const novaSource = (env) => readAgentSourceRegistry({ env }).sources.find((source) => source.type === 'nova') ?? null;

// ---------------------------------------------------------------------------------------------

test('stage 2 — the skill-generated descriptor passes current hardened validation', () => {
  const descriptor = readNovaDescriptor();
  const result = validateDescriptor(descriptor);
  assert.equal(result.ok, true, result.errors.join('; '));

  // Closed top-level keys: the descriptor names only keys the spec knows.
  assert.equal(Object.keys(descriptor).some((key) => key.startsWith('$comment')), true);

  // Capability / resource consistency: sessions + transcript execution status are wired; the
  // resource family and handoff are not claimed because no reader delivers them.
  assert.equal(descriptor.capabilities.quota, false);
  assert.equal(descriptor.capabilities.handoff, false);
  assert.equal(descriptor.resources.kind, 'none');

  // Root containment: every root is anchored at {home}.
  for (const root of descriptor.sessions.roots) {
    assert.ok(root === '{home}' || root.startsWith('{home}/'), `${root} is anchored at {home}`);
  }
});

test('stage 3 — a dry-run install reports candidates and writes nothing', (t) => {
  const env = profile(t);
  const fixture = writeNovaFixture(env.USERPROFILE);
  const descriptor = readNovaDescriptor();

  const report = installAgentDescriptor({ descriptor, env: { ...env, NOVA_HOME: fixture.home }, dryRun: true });
  assert.equal(report.ok, true, JSON.stringify(report.error ?? {}));
  assert.equal(report.dryRun, true);
  assert.equal(report.type, 'nova');
  assert.equal(report.descriptorChange, 'created');
  assert.equal(report.home.path, path.resolve(fixture.home));
  assert.equal(report.sourceChange, 'registered');
  assert.equal(report.candidates[0].env, 'NOVA_HOME');
  assert.equal(report.candidates[0].exists, true);
  assert.equal(report.candidates[0].probe.valid, true);

  // Dry-run is genuinely side-effect free: neither the descriptor nor the registry was written.
  assert.equal(fs.existsSync(path.join(env.USERPROFILE, '.margin', 'agents', 'nova.json')), false);
  assert.equal(fs.existsSync(path.join(env.USERPROFILE, '.margin', 'agent-sources.json')), false);
});

test('stage 4+5+6 — install, compose, verify, and discover sessions with no Margin code change', async (t) => {
  const env = profile(t);
  const fixture = writeNovaFixture(env.USERPROFILE);
  const descriptor = readNovaDescriptor();
  // The machine-local part of a real self-integration: this machine keeps Nova where NOVA_HOME says.
  const installEnv = { ...env, NOVA_HOME: fixture.home };

  // The fixture Agent is genuinely unknown to Margin: no shipped descriptor, no built-in reader.
  assert.equal(hasBuiltinAdapter('nova'), false);
  assert.equal(builtinDescriptors.some((builtin) => builtin.type === 'nova'), false);

  // Stage 4 — install (into the temp profile).
  const install = installAgentDescriptor({ descriptor, env: installEnv });
  assert.equal(install.ok, true, JSON.stringify(install.error ?? {}));
  assert.equal(install.descriptorChange, 'created');
  assert.equal(install.sourceChange, 'registered');

  // Stage 5 — composition. This is the whole claim: a descriptor alone, no adapter code.
  const adapter = adapterFor('nova', { env: installEnv });
  assert.ok(adapter, 'the descriptor alone must compose an adapter');
  assert.equal(adapter.agentType, 'nova');
  assert.equal(adapter.label, 'Nova');
  assert.equal(adapter.usesDefaultCapture, undefined, 'a foreign Agent never inherits the Codex capture path');
  assert.equal(adapter.captureSession, undefined);
  for (const method of ADAPTER_METHODS) assert.equal(typeof adapter[method], 'function', `nova.${method}`);

  const source = novaSource(installEnv);
  assert.ok(source, 'install registered the resolved source');
  assert.equal(source.supportLevel, 'Session discovery');
  assert.equal(source.capabilities.executionStatus, true);
  assert.equal(source.capabilities.quota, false);

  // Stage 5 — read-only verification (the proposed `agent verify` shape).
  const verification = await verifyNovaIntegration({ descriptor, env: installEnv, adapter, source });
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.probe.valid, true, verification.probe.reason ?? '');
  assert.equal(verification.resolution.resolved.path, path.resolve(fixture.home));
  assert.equal(verification.envelope.ok, true);

  // Acceptance 3a — at least one session discovered.
  assert.ok(verification.snapshots.length >= 1, 'at least one session must be discovered');
  assert.equal(verification.snapshots.length, 2, 'the interrupted rollout is dropped, not published');

  const byNativeId = new Map(verification.snapshots.map((session) => [session.nativeSessionId, session]));
  assert.deepEqual([...byNativeId.keys()].sort(), ['nova-2b8d4f01', 'nova-7f3a1c9e']);

  // Acceptance 3b — native session identity preserved, and it is NOT the rollout directory name.
  const first = byNativeId.get('nova-7f3a1c9e');
  assert.equal(first.id, 'nova-7f3a1c9e');
  assert.equal(first.canonicalId, `nova:${source.sourceId}:nova-7f3a1c9e`);
  assert.notEqual(path.basename(path.dirname(first.originalPath)), 'nova-7f3a1c9e', 'the directory is a rollout folder, not the native id');

  // Acceptance 3c — workspace resolved from the Agent's native cwd.
  const expectedWorkspace = fixture.workspaces.get('margin-core');
  assert.equal(first.cwd, expectedWorkspace);
  assert.equal(first.workspaceName, 'margin-core');
  assert.match(first.workspaceKey, /margin-core$/);

  // Acceptance 3d — timestamps parsed from native fields, not file mtimes.
  assert.equal(first.createdAt, '2026-05-04T09:12:33.000Z');
  assert.equal(first.updatedAt, '2026-05-04T09:41:07.000Z');
  assert.equal(Number.isFinite(Date.parse(first.createdAt)), true);

  // Transcript-derived execution status and title survive the declarative path.
  assert.equal(first.executionStatus, 'idle');
  assert.equal(first.displayTitle, 'Wire descriptor validation harness');
  assert.equal(byNativeId.get('nova-2b8d4f01').executionStatus, 'error');
  assert.equal(first.model, 'nova-2-large');
  assert.equal(first.provider, 'nova-labs');

  // A cheap change signal is part of the composed contract, not an extra.
  const revision = await adapter.getSessionRevision(source, { env: installEnv });
  assert.equal(typeof revision, 'string');
  assert.equal(revision.length, 64);

  // No resource reader was declared, so the honest answer is unavailable — not an invented record.
  const resources = await adapter.getResourceStatus(source, { env: installEnv });
  assert.equal(resources.status, 'unavailable');
  assert.deepEqual(resources.agents, [{ agent: 'nova', provider: 'nova-labs', label: 'Nova', revision: null, freshAt: null, stale: false, unavailable: true, resources: [] }]);

  // Detection does not invent a second registration for the same home.
  const detected = detectAgentSources(readAgentSourceRegistry({ env: installEnv }), { env: installEnv });
  assert.equal(detected.registry.sources.filter((item) => item.type === 'nova').length, 1);
});

test('stage 5 (negative) — invalid declarations are refused by current validation', () => {
  const base = readNovaDescriptor();

  // (a) Claiming a resource capability with no declared resource reader.
  for (const capability of ['quota', 'apiUsage', 'subscriptionQuota']) {
    const result = validateDescriptor({ ...base, capabilities: { ...base.capabilities, [capability]: true } });
    assert.equal(result.ok, false, `${capability} must be refused`);
    assert.match(result.errors.join(' | '), new RegExp(`capabilities\\.${capability} is true but resources\\.kind is none`));
  }

  // (b) An unsafe session root: anchored outside {home}.
  const unsafe = validateDescriptor({ ...base, sessions: { ...base.sessions, roots: ['{profile}/.nova/sessions'] } });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.errors.join(' | '), /sessions\.roots\[0\] must be \{home\} or a path beneath it/);

  const driveRoot = validateDescriptor({ ...base, sessions: { ...base.sessions, roots: ['C:/nova/sessions'] } });
  assert.equal(driveRoot.ok, false);
  assert.match(driveRoot.errors.join(' | '), /must be \{home\} or a path beneath it/);

  // (c) Unknown top-level keys — including the research-proposed `generatedBy` and `runtime`.
  const generatedBy = validateDescriptor({ ...base, generatedBy: { kind: 'self-inspection', skillVersion: '0.1.0' } });
  assert.equal(generatedBy.ok, false);
  assert.match(generatedBy.errors.join(' |'), /unknown top-level key "generatedBy"/);

  const runtime = validateDescriptor({ ...base, runtime: { kind: 'none', control: false } });
  assert.equal(runtime.ok, false);
  assert.match(runtime.errors.join(' |'), /unknown top-level key "runtime"/);

  const typo = validateDescriptor({ ...base, resource: { kind: 'none' } });
  assert.equal(typo.ok, false);
  assert.match(typo.errors.join(' |'), /unknown top-level key "resource"; did you mean "resources"\?/);

  // (d) Handoff claimed without an implementation.
  const handoff = validateDescriptor({ ...base, capabilities: { ...base.capabilities, handoff: true } });
  assert.equal(handoff.ok, false);
  assert.match(handoff.errors.join(' |'), /capabilities\.handoff is true but handoff\.kind is none/);
});

test('an unsafe root that passes the static anchor is still refused at read time', async (t) => {
  const env = profile(t);
  const fixture = writeNovaFixture(env.USERPROFILE);
  const descriptor = readNovaDescriptor();

  // `{home}/../escape` begins with `{home}/`, so the static anchor check accepts it; containment is
  // re-checked after expansion, and that is the check that refuses the actual read.
  const escaper = normalizeDescriptor({ ...descriptor, type: 'nova-escape', sessions: { ...descriptor.sessions, roots: ['{home}/../escape'] } });
  assert.equal(isPathContained(path.join(fixture.home, '..', 'escape'), fixture.home), false);

  const source = { id: 'nova-escape-source', sourceId: 'nova-escape-source', type: 'nova-escape', agentType: 'nova-escape', path: fixture.home, enabled: true };
  await assert.rejects(
    () => discoverTranscriptSessions(escaper, source, { env }),
    (error) => error?.code === 'session_root_outside_home',
  );
});

test('the catalogue boundary is observable: a header held outside the transcript is not expressible', async (t) => {
  const env = profile(t);
  const home = path.join(env.USERPROFILE, 'nova-meta-home');
  const dir = path.join(home, 'sessions', 'rollout_meta');
  fs.mkdirSync(dir, { recursive: true });
  // The native id / cwd / timestamps live in a SIBLING metadata file, while the declared transcript
  // glob (`events.jsonl`) carries only turns. The `record` extractor reads records from the
  // transcript file only, so no projection field can be read and the session is dropped.
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    session: { id: 'nova-meta-0001', cwd: env.USERPROFILE, createdAt: '2026-05-04T12:00:00.000Z', updatedAt: '2026-05-04T12:05:00.000Z' },
  }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
    { kind: 'turn.user', seq: 1, text: 'header lives elsewhere' },
    { kind: 'turn.assistant', seq: 2, finishReason: 'stop' },
  ]));

  const descriptor = normalizeDescriptor(readNovaDescriptor());
  const source = { id: 'nova-meta-source', sourceId: 'nova-meta-source', type: 'nova', agentType: 'nova', path: home, enabled: true };
  const sessions = await discoverTranscriptSessions(descriptor, source, { env });

  // This is not a validation failure — the declaration is well-formed. It is a catalogue boundary:
  // the only transcript source a descriptor can read is the single file matched by `glob`.
  assert.deepEqual(sessions, [], 'the header-in-a-sibling-file layout projects zero sessions');
});

test('uninstall round trip leaves no trace and detection does not resurrect Nova', (t) => {
  const env = profile(t);
  const fixture = writeNovaFixture(env.USERPROFILE);
  const descriptor = readNovaDescriptor();

  assert.equal(installAgentDescriptor({ descriptor, env: { ...env, NOVA_HOME: fixture.home } }).ok, true);
  assert.equal(readAgentSourceRegistry({ env }).sources.filter((source) => source.type === 'nova').length, 1);

  const uninstall = uninstallAgentDescriptor({ type: 'nova', env });
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.descriptorChange, 'removed');
  assert.equal(uninstall.purgedSources, 1);
  resetDescriptorCache();
  assert.equal(adapterFor('nova', { env }), null);

  // Detection must not re-register the Agent once the descriptor is gone.
  const detected = detectAgentSources(readAgentSourceRegistry({ env }), { env });
  assert.equal(detected.registry.sources.some((source) => source.type === 'nova'), false);
});
