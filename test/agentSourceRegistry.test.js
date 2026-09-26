import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectAgentSources, readAgentSourceRegistry, registerAgentSource, resolveActiveSource, writeAgentSourceRegistry, AGENT_TYPES } from '../src/agents/sourceRegistry.js';
import { adapterFor } from '../src/agents/adapters.js';
import { runAgentSourceCli } from '../src/cli/agentSourceCli.js';

function profile(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-agent-registry-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { USERPROFILE: root, HOME: root }; }
function sink() { const parts = []; return { write: (value) => parts.push(String(value)), text: () => parts.join('') }; }

test('registry detects standard Codex, Claude, and Pi paths and manual Codex takes precedence over CODEX_HOME', (t) => {
  const env = profile(t); const standard = path.join(env.USERPROFILE, '.codex'); const envRoot = path.join(env.USERPROFILE, 'portable-codex'); const manual = path.join(env.USERPROFILE, 'manual-codex');
  fs.mkdirSync(standard, { recursive: true }); fs.mkdirSync(path.join(env.USERPROFILE, '.claude')); fs.mkdirSync(path.join(env.USERPROFILE, '.pi')); fs.mkdirSync(envRoot); fs.mkdirSync(manual);
  let registry = detectAgentSources({ version: 1, sources: [] }, { env: { ...env, CODEX_HOME: envRoot } }).registry;
  assert.equal(resolveActiveSource(registry, 'codex', { env: { ...env, CODEX_HOME: envRoot } })?.path, envRoot);
  registry = registerAgentSource(registry, { type: 'codex', path: manual });
  assert.equal(resolveActiveSource(registry, 'codex', { env: { ...env, CODEX_HOME: envRoot } })?.path, manual);
  assert.deepEqual([...new Set(registry.sources.map((source) => source.agentType))].sort(), ['claude', 'codex', 'pi']);
  const claude = registry.sources.find((source) => source.agentType === 'claude');
  assert.equal(claude.detected, true);
  assert.equal(claude.capabilities.sessions, true);
  const codex = registry.sources.find((source) => source.agentType === 'codex');
  assert.equal(codex.sourceId, codex.id);
  assert.equal(codex.home, codex.path);
  assert.deepEqual(codex.capabilities, { sessions: true, handoff: true, apiUsage: true, quota: true, executionStatus: true, attentionStatus: false });
});

test('CLI and another host read the same persisted Pi source and expose session discovery with resource status', async (t) => {
  const env = profile(t); const pi = path.join(env.USERPROFILE, 'pi'); fs.mkdirSync(pi);
  const stdout = sink(); const stderr = sink();
  assert.equal(runAgentSourceCli(['add', 'pi', '--path', pi], { env, stdout, stderr }), 0);
  const registry = readAgentSourceRegistry({ env });
  assert.equal(registry.sources[0].agentType, 'pi');
  assert.equal(registry.sources[0].manual, true);
  assert.equal(adapterFor('pi').agentType, 'pi');
  assert.deepEqual(await adapterFor('pi').collectSessionSnapshots(registry.sources[0]), []);
  assert.equal(typeof await adapterFor('pi').getSessionRevision(registry.sources[0]), 'string');
  const result = await adapterFor('pi').getResourceStatus(registry.sources[0]);
  assert.equal(result.ok, true); assert.equal(result.status, 'ok');
  assert.equal(result.agents.length, 1);
  const agent = result.agents[0];
  assert.equal(agent.agent, 'pi'); assert.deepEqual(agent.resources[0], { resourceType: 'tokenUsage', accessMode: 'api', scope: 'today', totalTokens: 0, trustedResponseCount: 0, coverage: { partial: false, excludedUnknownResponses: 0, excludedSubscriptionResponses: 0, readFailed: false }, provenance: { source: 'pi-jsonl', home: pi, files: 0, trustedApiResponses: 0, excludedSubscriptionResponses: 0, excludedUnknownResponses: 0 } });
  assert.doesNotMatch(JSON.stringify(registry), /apiKey|credential|secret/i);
  const listed = sink(); runAgentSourceCli(['list'], { env, stdout: listed, stderr });
  assert.match(listed.text(), /capabilities:sessions/);
  assert.equal(runAgentSourceCli(['remove', registry.sources[0].sourceId], { env, stdout, stderr }), 0);
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 0);
});

test('registry persistence is profile-scoped, not cwd-scoped', (t) => {
  const env = profile(t); const sourcePath = path.join(env.USERPROFILE, 'pi'); fs.mkdirSync(sourcePath);
  const saved = writeAgentSourceRegistry(registerAgentSource({ version: 1, sources: [] }, { type: 'pi', path: sourcePath }), { env });
  assert.equal(readAgentSourceRegistry({ env }).sources[0].sourceId, saved.sources[0].sourceId);
});

test('unified CLI detects and lists every default source, including PI_HOME', (t) => {
  const env = profile(t);
  const piHome = path.join(env.USERPROFILE, 'portable-pi');
  fs.mkdirSync(path.join(env.USERPROFILE, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(env.USERPROFILE, '.claude')); fs.mkdirSync(piHome);
  const stdout = sink(); const stderr = sink();
  assert.equal(runAgentSourceCli(['detect'], { env: { ...env, PI_HOME: piHome }, stdout, stderr }), 0);
  assert.match(stdout.text(), /Detected codex/); assert.match(stdout.text(), /Detected claude/); assert.match(stdout.text(), /Detected pi/);
  const listed = sink();
  assert.equal(runAgentSourceCli(['list'], { env: { ...env, PI_HOME: piHome }, stdout: listed, stderr }), 0);
  // Derived from the registry rather than a repeated literal: the point of the assertion is that the
  // CLI lists what was detected, not that a specific set of names was hardcoded somewhere.
  const registered = readAgentSourceRegistry({ env: { ...env, PI_HOME: piHome } }).sources.map((source) => source.agentType).sort();
  assert.deepEqual(registered, ['claude', 'codex', 'pi']);
  for (const agentType of registered) assert.match(listed.text(), new RegExp(`\\t${agentType}\\t`));
});

test('every supported agent has the same minimal adapter methods', () => {
  // The list is derived, so adding an Agent cannot leave this test silently behind — which is
  // exactly the failure mode the whole descriptor change removes.
  assert.ok(AGENT_TYPES.length >= 3);
  for (const agentType of AGENT_TYPES) {
    const adapter = adapterFor(agentType);
    assert.equal(adapter.agentType, agentType);
    for (const method of ['detect', 'validateSource', 'collectSessionSnapshots', 'getSessionRevision', 'getResourceStatus']) assert.equal(typeof adapter[method], 'function');
  }
});
