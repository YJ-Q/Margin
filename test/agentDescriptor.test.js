import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AGENT_TYPES, readAgentSourceRegistry, registerAgentSource, writeAgentSourceRegistry } from '../src/agents/sourceRegistry.js';
import { adapterFor } from '../src/agents/adapters.js';
import { builtinDescriptors } from '../src/agents/descriptor/builtin.js';
import { descriptorFor, loadDescriptors, resetDescriptorCache } from '../src/agents/descriptor/load.js';
import { normalizeDescriptor, validateDescriptor } from '../src/agents/descriptor/spec.js';
import { installAgentDescriptor, uninstallAgentDescriptor } from '../src/agents/agentInstall.js';

const pluginPath = (name) => new URL(`../plugins/${name}/agent.json`, import.meta.url);

// A profile whose USERPROFILE/HOME point at a fresh temp directory, plus the environment names the
// descriptors expand. Nothing here reads the real user profile.
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-descriptor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { USERPROFILE: root, HOME: root };
}

const ADAPTER_METHODS = ['detect', 'validateSource', 'collectSessionSnapshots', 'readSessionSnapshots', 'getSessionRevision', 'getResourceStatus', 'collectResourceSnapshot', 'discoverSessions'];

// A 豆包 Agent Mode workspace, reduced to what the reader actually consumes: one directory per
// session, one OpenAI-shaped trajectory JSONL per agent, an append-only assignment file, and — the
// interesting part — no recorded working directory anywhere.
function doubaoWorkspace(workspace, { sessionId = '38444176668977666', agentId = 'm_abc' } = {}) {
  const home = workspace;
  const system = path.join(home, '.sessions', sessionId, 'agents', agentId, 'system');
  fs.mkdirSync(system, { recursive: true });
  const records = [
    { role: 'user', content: '# Margin Smart Handoff\n继续做相册上传' },
    { role: 'assistant', content: '我先读 PLAN.md', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: { file_path: 'Q:\\margin-fixture\\project\\PLAN.md' } } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '1\t# 时光集' },
  ];
  fs.writeFileSync(path.join(system, 'trajectory.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(path.join(system, 'assignment.md'), `# Assignment\n- Agent ID: ${agentId}\n`);
  return home;
}

const doubaoHome = (root, options = {}) => doubaoWorkspace(path.join(root, 'doubao-home'), options);

test('every built-in descriptor validates and composes the full adapter contract', () => {
  for (const raw of builtinDescriptors) {
    const validation = validateDescriptor(raw);
    assert.equal(validation.ok, true, `built-in ${raw.type}: ${validation.errors.join('; ')}`);
    const adapter = adapterFor(raw.type);
    assert.ok(adapter, `no composed adapter for built-in ${raw.type}`);
    assert.equal(adapter.agentType, raw.type);
    for (const method of ADAPTER_METHODS) assert.equal(typeof adapter[method], 'function', `${raw.type}.${method}`);
  }
  // AGENT_TYPES is derived from the descriptors rather than maintained beside them.
  assert.deepEqual(AGENT_TYPES, builtinDescriptors.slice().sort((left, right) => (left.order - right.order) || left.type.localeCompare(right.type)).map((descriptor) => descriptor.type));
});

test('the spec rejects descriptors that would half-wire an Agent', () => {
  const base = { specVersion: 1, type: 'acme', label: 'Acme', capabilities: { sessions: true }, sessions: { kind: 'none' }, handoff: { kind: 'none' } };
  const cases = [
    [{ ...base, type: 'Acme' }, /type must match/],
    [{ ...base, specVersion: 2 }, /specVersion must be 1/],
    [{ ...base, label: '' }, /label must be a non-empty string/],
    [{ ...base, capabilities: { sessions: true, telepathy: true } }, /capabilities\.telepathy is not a known capability/],
    // A declared handoff with no implementation is exactly the silent half-wiring this spec exists to
    // prevent, so it is rejected up front rather than resolved to another Agent's capture path.
    [{ ...base, capabilities: { sessions: true, handoff: true } }, /capabilities\.handoff is true but handoff\.kind is none/],
    // A descriptor can never invent a reader for a format the catalogue does not implement.
    [{ ...base, capabilities: { sessions: true }, sessions: { kind: 'transcript', roots: ['{home}/x'], transcript: { glob: '*.jsonl', format: 'msgpack' }, id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*' }, updatedAt: { kind: 'mtime', glob: '*' } } }, /transcript\.format must be one of jsonl/],
    [{ ...base, resources: { kind: 'builtin' }, sessions: { kind: 'none' } }, /resources\.kind builtin requires sessions\.kind builtin/],
    [{ ...base, sessions: { kind: 'transcript', roots: ['{home}'], transcript: { glob: '*.jsonl', format: 'jsonl' } } }, /sessions\.id is required/],
    [{ ...base, probe: { anyOf: [] } }, /probe\.anyOf must be a non-empty array/],
  ];
  for (const [descriptor, expected] of cases) {
    const result = validateDescriptor(descriptor);
    assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(descriptor).slice(0, 80)}`);
    assert.match(result.errors.join(' | '), expected);
  }
});

test('an Agent with no adapter is registered and reported, never silently dropped', (t) => {
  const env = profile(t);
  const home = path.join(env.USERPROFILE, 'deepseek-home');
  fs.mkdirSync(path.join(env.USERPROFILE, '.margin'), { recursive: true });
  fs.mkdirSync(home);
  // Hand-written registry entry: the previous implementation returned null here and the source simply
  // vanished from the Board with no message anywhere.
  fs.writeFileSync(path.join(env.USERPROFILE, '.margin', 'agent-sources.json'), JSON.stringify({ version: 1, sources: [{ type: 'deepseek', path: home }] }));
  const registry = readAgentSourceRegistry({ env });
  assert.equal(registry.sources.length, 1);
  const [source] = registry.sources;
  assert.equal(source.agentType, 'deepseek');
  assert.equal(source.supportLevel, 'Registered · Adapter required');
  assert.equal(source.capabilities.sessions, false);
  assert.equal(source.path, path.resolve(home));
  assert.equal(adapterFor('deepseek', { env }), null, 'no adapter exists yet, and saying so is the point');
});

test('registering a format-valid Agent does not require its adapter to exist yet', (t) => {
  const env = profile(t);
  const home = path.join(env.USERPROFILE, 'acme-home');
  fs.mkdirSync(home);
  const next = registerAgentSource({ version: 1, sources: [] }, { type: 'acme', path: home, origin: 'manual' }, { env });
  assert.equal(next.sources[0].agentType, 'acme');
  assert.equal(next.sources[0].supportLevel, 'Registered · Adapter required');
  writeAgentSourceRegistry(next, { env });
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 1);
  // The type FORMAT is still enforced: this is not "anything goes".
  assert.throws(() => registerAgentSource({ version: 1, sources: [] }, { type: 'Acme!', path: home }, { env }), /invalid_agent_type/);
  assert.throws(() => registerAgentSource({ version: 1, sources: [] }, { type: 'acme', path: '' }, { env }), /invalid_agent_source_path/);
});

test('a descriptor alone makes a brand-new Agent discoverable, with no adapter code', async (t) => {
  const env = profile(t);
  const home = doubaoHome(env.USERPROFILE, { sessionId: 'fixture-1' });
  // A third-party Agent, described only by a file it (or its installer) dropped in the user profile.
  const descriptor = {
    specVersion: 1,
    type: 'acme',
    label: 'Acme',
    provider: 'acme',
    defaultSourceName: 'Acme',
    capabilities: { sessions: true, handoff: false },
    sessions: {
      kind: 'transcript',
      layout: 'directory-per-session',
      roots: ['{home}/.sessions'],
      transcript: { glob: 'agents/*/system/trajectory.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' },
      createdAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true },
      title: { kind: 'record', where: { role: 'user' }, index: 0, path: 'content', as: 'first-user-message' },
    },
  };
  fs.mkdirSync(path.join(env.USERPROFILE, '.margin', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(env.USERPROFILE, '.margin', 'agents', 'acme.json'), JSON.stringify(descriptor, null, 2));
  resetDescriptorCache();

  assert.equal(descriptorFor('acme', { env })?.label, 'Acme');
  const source = { id: 'acme-source', sourceId: 'acme-source', type: 'acme', agentType: 'acme', path: home, enabled: true };
  const adapter = adapterFor('acme', { env });
  assert.ok(adapter, 'a descriptor-backed Agent must compose without any code change');
  assert.equal(adapter.label, 'Acme');
  assert.equal(adapter.usesDefaultCapture, undefined, 'a foreign Agent never inherits the Codex capture path');
  assert.equal(adapter.captureSession, undefined);

  const sessions = await adapter.collectSessionSnapshots(source, { env });
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.nativeSessionId, 'fixture-1');
  assert.equal(session.agentType, 'acme');
  assert.equal(session.canonicalId, 'acme:acme-source:fixture-1');
  assert.equal(session.workspaceName, 'project', 'the workspace came from a path mentioned in the transcript');
  assert.match(session.cwd, /margin-fixture[\\/]project$/);
  assert.equal(session.titleSource, 'first-user-message');
  assert.match(session.displayTitle, /Margin Smart Handoff/);
  assert.ok(Number.isFinite(Date.parse(session.createdAt)) && Number.isFinite(Date.parse(session.updatedAt)));
  assert.equal(session.capabilities.sessions, true);
  assert.equal(session.capabilities.handoff, false);

  // A read envelope and a cheap change signal are part of the contract, not extras.
  const envelope = await adapter.readSessionSnapshots(source, { env });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.snapshots.length, 1);
  assert.equal(typeof await adapter.getSessionRevision(source, { env }), 'string');

  // No resource reader was declared, so the honest answer is unavailable — not an invented record.
  const resources = await adapter.getResourceStatus(source, { env });
  assert.equal(resources.status, 'unavailable');
  assert.deepEqual(resources.agents, [{ agent: 'acme', label: 'Acme', provider: 'acme', revision: null, freshAt: null, stale: false, unavailable: true, resources: [] }]);
});

// The exact loop the design is meant to support: an Agent arrives as a fetched plugin, configures
// itself against THIS machine's layout, is exercised, and is then removed without a trace.
test('the 豆包 plugin installs itself, reads a real workspace, and uninstalls cleanly', async (t) => {
  const env = profile(t);
  const home = doubaoHome(env.USERPROFILE);
  const plugin = JSON.parse(fs.readFileSync(pluginPath('doubao'), 'utf8'));
  // The shipped plugin must satisfy the shipped spec; drift between the two is a release bug.
  assert.equal(validateDescriptor(plugin).ok, true, validateDescriptor(plugin).errors.join('; '));

  // This machine keeps 豆包 where the env var says, which is candidate #1.
  const install = installAgentDescriptor({ descriptor: plugin, env: { ...env, DOUBAO_AGENT_HOME: home } });
  assert.equal(install.ok, true, JSON.stringify(install.error ?? {}));
  assert.equal(install.home.path, path.resolve(home));
  assert.equal(install.candidates[0].env, 'DOUBAO_AGENT_HOME');
  assert.equal(install.sourceChange, 'registered');

  const source = readAgentSourceRegistry({ env }).sources.find((item) => item.type === 'doubao');
  assert.ok(source, 'install registers the source it resolved');
  const adapter = adapterFor('doubao', { env });
  assert.ok(adapter, 'no code change was needed for this Agent');
  assert.equal(adapter.label, '豆包');
  assert.equal(adapter.capabilities.quota, false, 'a quota it cannot read is not claimed');
  assert.deepEqual(adapter.probe(source, { env }), { valid: true, reason: null });

  const sessions = await adapter.collectSessionSnapshots(source, { env });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].nativeSessionId, '38444176668977666');
  assert.equal(sessions[0].agentType, 'doubao');
  assert.match(sessions[0].displayTitle, /Margin Smart Handoff/);
  assert.equal(sessions[0].executionStatus, 'idle', 'the last assistant turn maps to idle even when a tool record trails it');
  assert.equal(sessions[0].capabilities.executionStatus, true);
  assert.equal(adapter.probe({ ...source, path: env.USERPROFILE }, { env }).valid, false, 'the probe rejects a wrong directory');

  const uninstall = uninstallAgentDescriptor({ type: 'doubao', env });
  assert.equal(uninstall.descriptorChange, 'removed');
  assert.equal(uninstall.purgedSources, 1);
  resetDescriptorCache();
  assert.equal(descriptorFor('doubao', { env }), null);
  assert.equal(adapterFor('doubao', { env }), null);
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 0);

  // Repeatable: the loop is run for every test session.
  assert.equal(installAgentDescriptor({ descriptor: plugin, env: { ...env, DOUBAO_AGENT_HOME: home } }).ok, true);
  assert.equal(adapterFor('doubao', { env })?.label, '豆包');
});

test('a plugin configures itself from whichever candidate home this machine actually has', (t) => {
  const env = profile(t);
  const plugin = JSON.parse(fs.readFileSync(pluginPath('doubao'), 'utf8'));
  // No DOUBAO_AGENT_HOME: the Agent lives where candidate #2 says it does, so install must find it
  // there instead of reporting "no home" for a machine that plainly has one.
  const secondCandidate = path.join(env.USERPROFILE, 'AppData', 'Local', 'Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace');
  doubaoWorkspace(secondCandidate);
  const install = installAgentDescriptor({ descriptor: plugin, env });
  assert.equal(install.home.path, path.resolve(secondCandidate));
  assert.equal(install.candidates[0].exists, false);
  assert.equal(install.candidates[1].exists, true);
  assert.equal(install.candidates[1].probe.valid, true);
  assert.equal(readAgentSourceRegistry({ env }).sources[0].path, path.resolve(secondCandidate));
});

test('an unsatisfiable or duplicate user descriptor is reported, and never takes effect', (t) => {
  const env = profile(t);
  const dir = path.join(env.USERPROFILE, '.margin', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  // Naming a built-in session reader it does not own: reported, not downgraded to silence.
  fs.writeFileSync(path.join(dir, 'needs-adapter.json'), JSON.stringify({ specVersion: 1, type: 'needs', label: 'Needs', capabilities: { sessions: true }, sessions: { kind: 'builtin' }, handoff: { kind: 'none' } }));
  // Claiming a built-in type: the verified adapter wins and the attempt is recorded.
  fs.writeFileSync(path.join(dir, 'shadow-codex.json'), JSON.stringify({ specVersion: 1, type: 'codex', label: 'Not Codex', capabilities: { sessions: true }, sessions: { kind: 'none' }, handoff: { kind: 'none' } }));
  // Unparseable: reported with its own code instead of being skipped.
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  resetDescriptorCache();

  const { descriptors, problems } = loadDescriptors({ env });
  const codes = problems.map((problem) => problem.code).sort();
  assert.deepEqual(codes, ['descriptor_adapter_missing', 'descriptor_duplicate_type', 'descriptor_unreadable']);
  assert.equal(descriptors.some((descriptor) => descriptor.type === 'needs'), false);
  assert.equal(adapterFor('needs', { env }), null);
  assert.equal(descriptorFor('codex', { env })?.label, 'Codex', 'the built-in Codex descriptor is untouched');
});

test('workspace recovery prefers the path that actually looks like a project', async (t) => {
  const env = profile(t);
  const incidental = path.join(env.USERPROFILE, 'incidental', 'references');
  const project = path.join(env.USERPROFILE, 'actual-project');
  fs.mkdirSync(incidental, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(incidental, 'notes.md'), 'x');
  fs.writeFileSync(path.join(project, 'index.js'), 'x');

  const home = path.join(env.USERPROFILE, 'marker-home');
  const system = path.join(home, '.sessions', 's1', 'agents', 'm1', 'system');
  fs.mkdirSync(system, { recursive: true });
  // The incidental path is mentioned first, exactly as a bundled skill's reference file would be.
  const records = [
    { role: 'user', content: '看看这个' },
    { role: 'assistant', tool_calls: [{ function: { name: 'Read', arguments: { file_path: path.join(incidental, 'notes.md') } } }] },
    { role: 'assistant', tool_calls: [{ function: { name: 'Read', arguments: { file_path: path.join(project, 'index.js') } } }] },
  ];
  fs.writeFileSync(path.join(system, 'trajectory.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const base = {
    specVersion: 1, capabilities: { sessions: true }, sessions: {
      kind: 'transcript', layout: 'directory-per-session', roots: ['{home}/.sessions'],
      transcript: { glob: 'agents/*/system/trajectory.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' },
      createdAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'max' },
    },
  };
  const dir = path.join(env.USERPROFILE, '.margin', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marked.json'), JSON.stringify({ ...base, type: 'marked', label: 'Marked', sessions: { ...base.sessions, workspace: { kind: 'scanAbsolutePaths', parentOf: true, requireMarker: '.git' } } }));
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify({ ...base, type: 'plain', label: 'Plain', sessions: { ...base.sessions, workspace: { kind: 'scanAbsolutePaths', parentOf: true } } }));
  resetDescriptorCache();

  const source = (type) => ({ id: `${type}-source`, sourceId: `${type}-source`, type, agentType: type, path: home, enabled: true });
  const [marked] = await adapterFor('marked', { env }).collectSessionSnapshots(source('marked'), { env });
  const [plain] = await adapterFor('plain', { env }).collectSessionSnapshots(source('plain'), { env });
  assert.equal(marked.cwd, project, 'the repo candidate wins over the incidental one');
  assert.equal(marked.workspaceName, 'actual-project');
  assert.equal(plain.cwd, incidental, 'without a declared marker, the first mentioned path is used');
});

test('a resolved descriptor is the same object the registry reports capabilities from', (t) => {
  const env = profile(t);
  const descriptor = normalizeDescriptor({ specVersion: 1, type: 'acme', label: 'Acme', capabilities: { sessions: true }, sessions: { kind: 'none' }, handoff: { kind: 'none' } });
  // Unstated capabilities stay unstated: the registry DTO shape for existing Agents must not grow.
  assert.deepEqual(descriptor.capabilities, { sessions: true });
  assert.equal(descriptor.supportLevel, 'Registered · Adapter required');
  assert.equal(descriptor.resourceAgent, 'acme');
  assert.equal(descriptor.quotaPrefix, null);
  assert.equal(descriptorFor('acme', { env }), null);
});
