// `margin agent verify` — MVP regression suite.
//
// The command is read-only and its whole purpose is to turn "installed" into "observed". These tests
// pin the four verdicts, the explicit probe state, the safety-rejection passthrough, the no-write
// property, the dry-run-can't-fake-it property, and the result schema.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateDescriptor } from '../src/agents/descriptor/spec.js';
import { builtinDescriptors } from '../src/agents/descriptor/builtin.js';
import { adapterFor } from '../src/agents/adapters.js';
import { installAgentDescriptor } from '../src/agents/agentInstall.js';
import { readAgentSourceRegistry } from '../src/agents/sourceRegistry.js';
import {
  PROBE_STATES,
  REASON_CODES,
  RESULT_VERSION,
  formatVerifyResult,
  verifyAgentDescriptor,
  verifyExitCode,
  verifyManifestError,
} from '../src/agents/agentVerify.js';
import { runAgentSourceCli } from '../src/cli/agentSourceCli.js';

const novaDescriptorPath = fileURLToPath(new URL('../plugins/nova/agent.json', import.meta.url));
const readNovaDescriptor = () => JSON.parse(fs.readFileSync(novaDescriptorPath, 'utf8'));

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-agent-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { USERPROFILE: root, HOME: root };
}

function sink() {
  const parts = [];
  return { write: (value) => parts.push(String(value)), text: () => parts.join('') };
}

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

const GOOD = { dir: 'rollout_0001', nativeId: 'nova-7f3a1c9e', workspace: 'margin-core', createdAt: '2026-05-04T09:12:33.000Z', updatedAt: '2026-05-04T09:41:07.000Z', title: 'Wire descriptor validation harness', finishReason: 'stop' };
const ERROR = { dir: 'rollout_0002', nativeId: 'nova-2b8d4f01', workspace: 'margin-web', createdAt: '2026-05-04T10:02:11.000Z', updatedAt: '2026-05-04T10:05:48.000Z', title: 'Fix workspace name resolution', finishReason: 'error' };
const INTERRUPTED = { dir: 'rollout_0003', nativeId: 'nova-9c0e5a77', workspace: 'margin-core', createdAt: '2026-05-04T11:00:00.000Z', updatedAt: null, title: 'Interrupted rollout', finishReason: 'tool_use' };

// A Nova home. A session with `updatedAt: null` has no session.end record at all, exactly like a
// rollout that crashed before writing one; it is dropped, not published with invented values.
function writeNovaHome(profileRoot, sessions = [GOOD, ERROR, INTERRUPTED]) {
  const home = path.join(profileRoot, 'nova-home');
  fs.mkdirSync(home, { recursive: true });
  const workspaces = new Map();
  for (const session of sessions) {
    const cwd = path.join(profileRoot, 'workspaces', session.workspace);
    if (!workspaces.has(session.workspace)) { fs.mkdirSync(cwd, { recursive: true }); workspaces.set(session.workspace, cwd); }
    const dir = path.join(home, 'sessions', session.dir);
    fs.mkdirSync(dir, { recursive: true });
    const records = [
      { kind: 'session.start', seq: 1, session: { id: session.nativeId, cwd, createdAt: session.createdAt }, title: session.title },
      { kind: 'turn.user', seq: 2, text: session.title },
      { kind: 'turn.assistant', seq: 3, finishReason: session.finishReason, model: 'nova-2-large', provider: 'nova-labs' },
    ];
    if (session.updatedAt) records.push({ kind: 'session.end', seq: 4, session: { updatedAt: session.updatedAt } });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl(records));
  }
  return { home, workspaces };
}

function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.push(`${relative}/`); walk(path.join(dir, entry.name), relative); }
      else out.push(relative);
    }
  };
  walk(root, '');
  return out;
}

// A legal descriptor that declares NO session source: sessions.kind is "none". Built from Nova so
// everything except the session surface stays realistic, including home candidates and a probe.
function noneSessionDescriptor() {
  const source = readNovaDescriptor();
  return {
    ...source,
    type: 'novatwo',
    capabilities: { sessions: false, handoff: false, apiUsage: false, quota: false, executionStatus: false, attentionStatus: false },
    sessions: { kind: 'none' },
    executionStatus: { kind: 'none' },
  };
}

// -------------------------------------------------------------------------------------------
// Positive case — verified, native evidence preserved.
// -------------------------------------------------------------------------------------------

test('verify — a valid descriptor with a real session is verified and preserves native evidence', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  const descriptor = readNovaDescriptor();

  const result = await verifyAgentDescriptor({ descriptor, env: { ...env, NOVA_HOME: fixture.home }, input: { kind: 'file', path: 'margin-agent.json', sha256: 'a'.repeat(64) } });

  assert.equal(result.resultVersion, RESULT_VERSION);
  assert.equal(result.verdict, 'verified');
  assert.equal(result.reasonCode, null, 'verified carries no reason code');
  assert.equal(result.installation.state, 'not_installed');
  assert.equal(result.source.origin, 'resolved');
  assert.equal(result.source.path, path.resolve(fixture.home));
  assert.equal(result.source.unsafe, false);
  assert.equal(result.source.probe.state, 'passed', result.source.probe.reason ?? '');
  assert.equal(result.sessions.observed, 2, 'the interrupted rollout is dropped, not published');
  assert.equal(result.sessions.checked, 2);
  assert.deepEqual(result.sessions.invariantFailures, []);
  assert.equal(result.sessions.revision, null, 'pre-install has no registered source');
  assert.ok(result.notes.some((note) => note.code === 'no_registered_source'));

  const byId = new Map(result.sessions.sample.map((session) => [session.nativeSessionId, session]));
  assert.deepEqual([...byId.keys()].sort(), ['nova-2b8d4f01', 'nova-7f3a1c9e']);

  const first = byId.get('nova-7f3a1c9e');
  assert.equal(first.canonicalId, null, 'no invented Margin identity before registration');
  assert.equal(first.createdAt, '2026-05-04T09:12:33.000Z');
  assert.equal(first.updatedAt, '2026-05-04T09:41:07.000Z');
  assert.equal(first.timestampSource, 'native');
  assert.equal(first.workspaceSource, 'native');
  assert.equal(first.workspace.name, 'margin-core');
  assert.match(first.workspace.key, /margin-core$/);
  assert.equal(first.executionStatus, 'idle');
  assert.equal(first.titlePresent, true);

  // Capabilities are a function of observation: sessions and transcript executionStatus verified.
  const capabilities = new Map(result.capabilities.map((entry) => [entry.name, entry]));
  assert.equal(capabilities.get('sessions').status, 'verified');
  assert.equal(capabilities.get('executionStatus').status, 'verified');
  assert.equal(capabilities.get('quota').status, 'unsupported');
  assert.equal(capabilities.get('handoff').status, 'unsupported');
});

test('verify — post-install reads the registered source and reports Margin identity', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  const installEnv = { ...env, NOVA_HOME: fixture.home };
  const descriptor = readNovaDescriptor();
  assert.equal(installAgentDescriptor({ descriptor, env: installEnv }).ok, true);

  const result = await verifyAgentDescriptor({ descriptor, env: installEnv });
  assert.equal(result.verdict, 'verified');
  assert.equal(result.installation.state, 'installed_match');
  assert.equal(result.source.origin, 'registry');
  const source = readAgentSourceRegistry({ env: installEnv }).sources.find((entry) => entry.type === 'nova');
  assert.equal(result.sessions.sample[0].canonicalId, `nova:${source.sourceId}:${result.sessions.sample[0].nativeSessionId}`);
  assert.equal(typeof result.sessions.revision, 'string');
  assert.equal(result.sessions.revision.length, 64);
  assert.equal(result.capabilities.find((entry) => entry.name === 'sessions').status, 'verified');
});

// -------------------------------------------------------------------------------------------
// The other three verdicts.
// -------------------------------------------------------------------------------------------

test('verify — a clean-probing home with no publishable session returns no_sessions', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE, [INTERRUPTED]);
  const result = await verifyAgentDescriptor({ descriptor: readNovaDescriptor(), env: { ...env, NOVA_HOME: fixture.home } });

  assert.equal(result.verdict, 'no_sessions');
  assert.equal(result.reasonCode, 'reader_returned_empty', 'an empty reader is no_sessions with its own reason code');
  assert.equal(result.source.probe.state, 'passed', 'the probe sees the events.jsonl even though no session is publishable');
  assert.equal(result.sessions.observed, 0);
  assert.equal(verifyExitCode(result.verdict), 2);
});

test('verify — an absent home returns unavailable and an explicit unavailable probe state', async (t) => {
  const env = profile(t);
  const result = await verifyAgentDescriptor({ descriptor: readNovaDescriptor(), env });

  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.reasonCode, 'no_home_found');
  assert.equal(result.source.origin, null);
  assert.equal(result.source.path, null);
  assert.equal(result.source.probe.state, 'unavailable');
  assert.ok(PROBE_STATES.includes(result.source.probe.state));
  assert.equal(result.notes.some((note) => note.code === 'no_home_found'), true);
  assert.equal(result.installation.state, 'not_installed');
  assert.equal(verifyExitCode(result.verdict), 3);
});

test('verify — a statically unsafe root is rejected at validation', async (t) => {
  const env = profile(t);
  const descriptor = { ...readNovaDescriptor(), sessions: { ...readNovaDescriptor().sessions, roots: ['{profile}/.nova/sessions'] } };
  const result = await verifyAgentDescriptor({ descriptor, env });

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.reasonCode, 'invalid_descriptor');
  assert.equal(result.stages.find((stage) => stage.stage === 'descriptor').status, 'failed');
  assert.equal(result.refusals[0].authority, 'spec.root_containment');
  assert.equal(verifyExitCode(result.verdict), 4);
  // A refusal outranks unavailability: the descriptor is wrong whether or not the Agent is installed.
  assert.notEqual(result.verdict, 'unavailable');
});

test('verify — an unsafe root at read time is rejected, never unavailable', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  // `{home}/../escape` begins with `{home}/`, so it passes the static anchor check; containment is
  // re-checked after expansion and that is the check that must surface as rejected.
  const descriptor = { ...readNovaDescriptor(), sessions: { ...readNovaDescriptor().sessions, roots: ['{home}/../escape'] } };
  const result = await verifyAgentDescriptor({ descriptor, env: { ...env, NOVA_HOME: fixture.home } });

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.reasonCode, 'session_root_outside_home');
  assert.equal(result.source.probe.state, 'passed', 'the read-time escape is not a source failure');
  assert.equal(result.refusals.some((refusal) => refusal.code === 'session_root_outside_home' && refusal.authority === 'readers.containment'), true);
  assert.notEqual(result.verdict, 'unavailable');
});

// -------------------------------------------------------------------------------------------
// Case A — no session provider declared (sessions.kind none). Must NOT be no_sessions.
// -------------------------------------------------------------------------------------------

test('verify — sessions.kind none is unavailable/session_source_not_declared, never no_sessions', async (t) => {
  const env = profile(t);
  const result = await verifyAgentDescriptor({ descriptor: noneSessionDescriptor(), env });

  assert.equal(result.verdict, 'unavailable');
  assert.notEqual(result.verdict, 'no_sessions', '"no reader declared" is not "reader returned zero"');
  assert.equal(result.reasonCode, 'session_source_not_declared');
  assert.equal(result.source.probe.state, 'not_applicable');
  assert.equal(result.source.validate.valid, false);
  assert.equal(result.source.path, null, 'no home is resolved or walked for a source-less declaration');
  assert.equal(result.source.candidates.length, 0);
  assert.equal(result.stages.find((stage) => stage.stage === 'source').status, 'skipped');
  assert.equal(result.stages.find((stage) => stage.stage === 'projection').status, 'skipped');
  assert.equal(result.notes.some((note) => note.code === 'session_source_not_declared'), true);
  assert.equal(result.refusals.length, 0, 'declaring no session source is not a descriptor fault');
  assert.equal(verifyExitCode(result.verdict), 3);

  const sessions = result.capabilities.find((entry) => entry.name === 'sessions');
  assert.equal(sessions.status, 'unsupported');
  assert.equal(sessions.origin, 'session_source_not_declared');
  assert.equal(sessions.declared, false);
});

test('verify — sessions.kind none stays not_declared even when a real home is present', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  // A matching home exists on disk; the classification is about the declaration, not the machine.
  const result = await verifyAgentDescriptor({ descriptor: noneSessionDescriptor(), env: { ...env, NOVA_HOME: fixture.home } });

  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.reasonCode, 'session_source_not_declared');
  assert.equal(result.source.probe.state, 'not_applicable');
  assert.equal(result.source.path, null);
});

test('verify — reason code vocabulary is closed and stays aligned with verdicts', () => {
  assert.deepEqual(REASON_CODES.no_sessions, ['reader_returned_empty']);
  for (const code of REASON_CODES.unavailable) assert.match(code, /^[a-z_]+$/);
  assert.ok(REASON_CODES.unavailable.includes('session_source_not_declared'));
  assert.ok(PROBE_STATES.includes('not_applicable'));
});

// -------------------------------------------------------------------------------------------
// Probe state, explicitly.
// -------------------------------------------------------------------------------------------

test('verify — probe state is explicit, never a boolean', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);

  const notDeclared = { ...readNovaDescriptor() };
  delete notDeclared.probe;
  const declared = await verifyAgentDescriptor({ descriptor: notDeclared, env: { ...env, NOVA_HOME: fixture.home } });
  assert.equal(declared.verdict, 'verified');
  assert.equal(declared.source.probe.state, 'not_declared');

  const mismatch = { ...readNovaDescriptor(), probe: { anyOf: [{ glob: '{home}/nope/*.nothing' }] } };
  const failed = await verifyAgentDescriptor({ descriptor: mismatch, env: { ...env, NOVA_HOME: fixture.home } });
  assert.equal(failed.source.probe.state, 'failed');
  assert.equal(failed.verdict, 'rejected');
  assert.equal(failed.refusals.some((refusal) => refusal.authority === 'readers.probe'), true);

  // No probe result anywhere in the output is a raw boolean `valid`.
  assert.equal('valid' in declared.source.probe, false);
  assert.equal('valid' in failed.source.probe, false);
});

// -------------------------------------------------------------------------------------------
// Installation dry-run proves composition only.
// -------------------------------------------------------------------------------------------

test('verify — installation dry-run cannot fake verification success', async (t) => {
  const env = profile(t);
  const descriptor = readNovaDescriptor();
  const missing = path.join(env.USERPROFILE, 'not-a-home');

  // The dry-run's explicit-path branch fabricates `{ exists: true, probe: { valid: true } }` without
  // touching the filesystem. That is fine for an install (the user asserted the path) and useless as
  // evidence.
  const dry = installAgentDescriptor({ descriptor, path: missing, env, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.home.path, path.resolve(missing));
  assert.equal(dry.home.probe.valid, true, 'the synthetic candidate claims a passing probe');

  const result = await verifyAgentDescriptor({ descriptor, path: missing, env });
  assert.equal(result.verdict, 'unavailable', 'verify must not trust the dry-run probe metadata');
  assert.equal(result.source.origin, 'explicit');
  assert.equal(result.source.probe.state, 'unavailable');
  assert.equal(result.source.validate.valid, false);
});

// -------------------------------------------------------------------------------------------
// Read-only guarantee.
// -------------------------------------------------------------------------------------------

test('verify — writes nothing anywhere, including on rejection', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  const before = listTree(env.USERPROFILE);
  const verifyEnv = { ...env, NOVA_HOME: fixture.home };

  assert.equal((await verifyAgentDescriptor({ descriptor: readNovaDescriptor(), env: verifyEnv })).verdict, 'verified');
  const unsafe = { ...readNovaDescriptor(), sessions: { ...readNovaDescriptor().sessions, roots: ['{home}/../escape'] } };
  assert.equal((await verifyAgentDescriptor({ descriptor: unsafe, env: verifyEnv })).verdict, 'rejected');

  assert.deepEqual(listTree(env.USERPROFILE), before, 'verify created or removed a file');
  assert.equal(fs.existsSync(path.join(env.USERPROFILE, '.margin', 'agents', 'nova.json')), false);
  assert.equal(fs.existsSync(path.join(env.USERPROFILE, '.margin', 'agent-sources.json')), false);
});

// -------------------------------------------------------------------------------------------
// JSON schema stability.
// -------------------------------------------------------------------------------------------

test('verify — the result document schema is stable', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  const result = await verifyAgentDescriptor({ descriptor: readNovaDescriptor(), env: { ...env, NOVA_HOME: fixture.home }, input: { kind: 'file', path: 'x.json', sha256: 'b'.repeat(64) } });

  assert.deepEqual(Object.keys(result).sort(), [
    'capabilities', 'diagnostics', 'evidenceSources', 'generatedAt', 'input', 'installation', 'notes', 'reasonCode', 'refusals',
    'resultVersion', 'scope', 'sessions', 'source', 'stages', 'tool', 'verdict',
  ].sort());
  assert.deepEqual(Object.keys(result.input).sort(), ['kind', 'label', 'path', 'sha256', 'specVersion', 'type'].sort());
  assert.deepEqual(Object.keys(result.installation).sort(), ['descriptorDigest', 'descriptorPath', 'descriptorSha256', 'source', 'state'].sort());
  assert.deepEqual(Object.keys(result.source).sort(), ['candidates', 'origin', 'path', 'probe', 'unsafe', 'validate'].sort());
  assert.deepEqual(Object.keys(result.source.probe).sort(), ['reason', 'state'].sort());
  assert.deepEqual(Object.keys(result.sessions).sort(), ['checked', 'evidence', 'invariantFailures', 'observed', 'revision', 'sample'].sort());
  // The optional diagnostics block is an additive, observed-only debugging surface.
  assert.deepEqual(Object.keys(result.diagnostics).sort(), ['candidateCount', 'dropped', 'entriesExamined', 'matchedFiles', 'projectedCount', 'roots', 'skippedLayout'].sort());
  assert.deepEqual(Object.keys(result.diagnostics.roots[0]).sort(), ['exists', 'expanded', 'root'].sort());
  assert.equal(result.diagnostics.projectedCount, result.sessions.observed, 'projected count equals what the reader published');
  assert.equal(result.diagnostics.matchedFiles, 3, 'all three rollout files matched the glob');
  assert.equal(result.diagnostics.candidateCount, 3, 'all three reached the builder');
  assert.equal(result.diagnostics.dropped.length, 1, 'the interrupted rollout has an observed builder drop');
  assert.equal(result.diagnostics.dropped[0].reason, 'missing_updated_at');
  assert.deepEqual(result.diagnostics.dropped[0].missing, ['missing_updated_at']);
  assert.deepEqual(result.stages.map((stage) => stage.stage), ['load', 'descriptor', 'installation', 'source', 'projection']);
  assert.equal(result.tool.command, 'agent verify');
  assert.equal(PROBE_STATES.includes(result.source.probe.state), true);
  assert.equal(['verified', 'no_sessions', 'unavailable', 'rejected'].includes(result.verdict), true);
  // A number is never outside an object carrying evidence.
  assert.equal(result.sessions.evidence[0].source, 'adapter');
  assert.equal(JSON.parse(JSON.stringify(result)).verdict, 'verified');
});

test('verify — a parse failure still emits a rejected document with a failed load stage', () => {
  const result = verifyManifestError({ input: { kind: 'file', path: 'broken.json', sha256: null }, message: 'Unexpected token' });
  assert.equal(result.verdict, 'rejected');
  assert.equal(result.reasonCode, 'invalid_descriptor');
  assert.equal(result.stages[0].stage, 'load');
  assert.equal(result.stages[0].status, 'failed');
  assert.equal('sessions' in result, false);
  assert.equal('installation' in result, false);
  assert.match(formatVerifyResult(result), /verdict rejected/);
});

// -------------------------------------------------------------------------------------------
// Baseline regressions: the shipped descriptors and the Nova fixture stay valid.
// -------------------------------------------------------------------------------------------

test('regression — built-in Codex/Claude/Pi descriptors stay valid and composable', () => {
  for (const raw of builtinDescriptors) {
    const validation = validateDescriptor(raw);
    assert.equal(validation.ok, true, `${raw.type}: ${validation.errors.join('; ')}`);
    assert.ok(adapterFor(raw.type), `${raw.type} must compose`);
  }
  // Verifying a built-in descriptor is refused by the builtin guard, because Margin ships its reader.
  assert.equal(validateDescriptor(readNovaDescriptor()).ok, true, validateDescriptor(readNovaDescriptor()).errors.join('; '));
});

test('regression — Codex/Claude/Pi remain builtin-guarded under verify; Nova still observes', async (t) => {
  const env = profile(t);
  for (const raw of builtinDescriptors) {
    const result = await verifyAgentDescriptor({ descriptor: raw, env });
    assert.equal(result.verdict, 'rejected', `${raw.type} stays a builtin-guarded type`);
    assert.equal(result.reasonCode, 'builtin_type', `${raw.type} names the guard in reasonCode`);
    assert.equal(result.refusals.some((refusal) => refusal.authority === 'install.builtin_guard'), true);
  }
  // The registered-plugin path (Nova) is the supported verify surface and must stay green.
  const fixture = writeNovaHome(env.USERPROFILE);
  const nova = await verifyAgentDescriptor({ descriptor: readNovaDescriptor(), env: { ...env, NOVA_HOME: fixture.home } });
  assert.equal(nova.verdict, 'verified');
  assert.equal(nova.reasonCode, null);
});

// -------------------------------------------------------------------------------------------
// CLI surface.
// -------------------------------------------------------------------------------------------

test('CLI — human and JSON output, and the exit-code contract', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE);
  const verifyEnv = { ...env, NOVA_HOME: fixture.home };

  const human = sink();
  const humanCode = await runAgentSourceCli(['verify', novaDescriptorPath], { env: verifyEnv, stdout: human, stderr: sink() });
  assert.equal(humanCode, 0, human.text());
  assert.match(human.text(), /verdict verified/);
  assert.match(human.text(), /probe passed/);
  assert.match(human.text(), /2 sessions observed/);

  const json = sink();
  const jsonCode = await runAgentSourceCli(['verify', novaDescriptorPath, '--json', '--sample', '1'], { env: verifyEnv, stdout: json, stderr: sink() });
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(json.text());
  assert.equal(parsed.verdict, 'verified');
  assert.equal(parsed.sessions.observed, 2);
  assert.equal(parsed.sessions.checked, 1, '--sample bounds the checked rows, not the observed count');

  // no_sessions → 2
  const quietRoot = profile(t);
  const quiet = writeNovaHome(quietRoot.USERPROFILE, [INTERRUPTED]);
  const quietEnv = { ...quietRoot, NOVA_HOME: quiet.home };
  assert.equal(await runAgentSourceCli(['verify', novaDescriptorPath], { env: quietEnv, stdout: sink(), stderr: sink() }), 2);

  // unavailable → 3 (no home present)
  assert.equal(await runAgentSourceCli(['verify', novaDescriptorPath], { env, stdout: sink(), stderr: sink() }), 3);

  // rejected → 4 (unsafe root)
  const unsafePath = path.join(env.USERPROFILE, 'unsafe.json');
  fs.writeFileSync(unsafePath, JSON.stringify({ ...readNovaDescriptor(), sessions: { ...readNovaDescriptor().sessions, roots: ['{profile}/.nova/sessions'] } }));
  assert.equal(await runAgentSourceCli(['verify', unsafePath], { env, stdout: sink(), stderr: sink() }), 4);

  // usage → 1
  assert.equal(await runAgentSourceCli(['verify'], { env, stdout: sink(), stderr: sink() }), 1);
  assert.equal(await runAgentSourceCli(['verify', novaDescriptorPath, '--sample', '0'], { env, stdout: sink(), stderr: sink() }), 1);
  assert.equal(await runAgentSourceCli(['verify', novaDescriptorPath, '--nope'], { env, stdout: sink(), stderr: sink() }), 1);

  // --help states the read-only guarantee and the non-guarantees, and exits 0.
  const help = sink();
  assert.equal(await runAgentSourceCli(['verify', '--help'], { env, stdout: help, stderr: sink() }), 0);
  assert.match(help.text(), /no writes anywhere/i);
  assert.match(help.text(), /no credential copying/i);
  assert.match(help.text(), /Does not guarantee/i);
  assert.match(help.text(), /session_source_not_declared/);
  assert.match(help.text(), /docs\/agent-verify\.md/);

  // sessions.kind none → unavailable (3) with the dedicated reason code, never no_sessions (2)
  const nonePath = path.join(env.USERPROFILE, 'none.json');
  fs.writeFileSync(nonePath, JSON.stringify(noneSessionDescriptor()));
  const noneOut = sink();
  assert.equal(await runAgentSourceCli(['verify', nonePath, '--json'], { env, stdout: noneOut, stderr: sink() }), 3);
  const noneParsed = JSON.parse(noneOut.text());
  assert.equal(noneParsed.verdict, 'unavailable');
  assert.equal(noneParsed.reasonCode, 'session_source_not_declared');
  assert.equal(noneParsed.source.probe.state, 'not_applicable');

  // unparseable JSON → rejected (4) with a failed load stage and no typed blocks
  const brokenPath = path.join(env.USERPROFILE, 'broken.json');
  fs.writeFileSync(brokenPath, '{ not json');
  const brokenOut = sink();
  assert.equal(await runAgentSourceCli(['verify', brokenPath, '--json'], { env, stdout: brokenOut, stderr: sink() }), 4);
  const broken = JSON.parse(brokenOut.text());
  assert.equal(broken.verdict, 'rejected');
  assert.equal(broken.stages[0].status, 'failed');
  assert.equal('sessions' in broken, false);
});

test('CLI — stdin input and the no-session human diagnosis', async (t) => {
  const env = profile(t);
  const fixture = writeNovaHome(env.USERPROFILE, [INTERRUPTED]);
  const out = sink();
  const code = await runAgentSourceCli(['verify', '-'], { env: { ...env, NOVA_HOME: fixture.home }, stdin: fs.readFileSync(novaDescriptorPath, 'utf8'), stdout: out, stderr: sink() });
  assert.equal(code, 2);
  assert.match(out.text(), /reader published nothing/);
});
