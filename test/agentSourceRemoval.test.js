import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectAgentSources, enableAgentSource, readAgentSourceRegistry, registerAgentSource,
  removeAgentSource, writeAgentSourceRegistry,
} from '../src/agents/sourceRegistry.js';
import { installAgentDescriptor, uninstallAgentDescriptor } from '../src/agents/agentInstall.js';
import { descriptorFor, resetDescriptorCache } from '../src/agents/descriptor/load.js';
import { adapterFor } from '../src/agents/adapters.js';
import { createHandoffHttpAdapter } from '../src/core/handoff/httpAdapter.js';
import { runAgentSourceCli } from '../src/cli/agentSourceCli.js';

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-removal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { USERPROFILE: root, HOME: root };
}
const sink = () => { const parts = []; return { write: (value) => parts.push(String(value)), text: () => parts.join('') }; };
const withServer = async (app, run) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
};

// The central removal gap: an Agent that detection would recreate could not be removed at all, in any
// surface. Deleting the record merely postponed the problem to the next detection pass.
test('a source detection would recreate is removed as a tombstone that detection respects', (t) => {
  const env = profile(t);
  fs.mkdirSync(path.join(env.USERPROFILE, '.codex'), { recursive: true });
  const detected = detectAgentSources({ version: 1, sources: [] }, { env });
  const codex = detected.registry.sources.find((source) => source.type === 'codex');
  assert.equal(codex.enabled, true);
  assert.equal(codex.origin, 'auto');

  const removed = removeAgentSource(detected.registry, codex.id, { env });
  const tombstone = removed.sources.find((source) => source.id === codex.id);
  assert.equal(tombstone.suppressed, true, 'the record is kept precisely so detection cannot recreate it');
  assert.equal(tombstone.enabled, false);
  assert.ok(Number.isFinite(Date.parse(tombstone.suppressedAt)));

  // Detection runs on every host startup. It must not undo the user's removal.
  const again = detectAgentSources(removed, { env }).registry;
  assert.equal(again.sources.find((source) => source.id === codex.id).enabled, false);
  assert.equal(again.sources.find((source) => source.id === codex.id).suppressed, true);
  assert.equal(detectAgentSources(removed, { env }).detected.find((source) => source.type === 'codex').suppressed, true, 'the CLI must be able to say "found, but still removed"');

  // ...and the undo is a first-class operation, not a hand-edit of agent-sources.json.
  const enabled = enableAgentSource(again, codex.id, { env });
  assert.equal(enabled.sources.find((source) => source.id === codex.id).enabled, true);
  assert.equal(enabled.sources.find((source) => source.id === codex.id).suppressed, undefined);
  const stillEnabled = detectAgentSources(enabled, { env }).registry;
  assert.equal(stillEnabled.sources.find((source) => source.id === codex.id).enabled, true);
});

// The other direction: deleting a registration detection cannot recreate must not leave a tombstone
// behind forever, or a user's own manual entries accumulate as invisible clutter.
test('a manually registered source at a non-candidate path is deleted outright', (t) => {
  const env = profile(t);
  const manual = path.join(env.USERPROFILE, 'my-custom-pi');
  fs.mkdirSync(manual);
  const registry = registerAgentSource({ version: 1, sources: [] }, { type: 'pi', path: manual, origin: 'manual' }, { env });
  const id = registry.sources[0].id;
  const removed = removeAgentSource(registry, id, { env });
  assert.deepEqual(removed.sources, []);
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 0, 'removal is persisted, not just returned');
  // Removing something that is not there is a no-op, so a scripted loop can re-run safely.
  assert.deepEqual(removeAgentSource(removed, id, { env }).sources, []);
});

test('the CLI removes any origin and reports what it actually did', (t) => {
  const env = profile(t);
  fs.mkdirSync(path.join(env.USERPROFILE, '.codex'), { recursive: true });
  const stdout = sink(); const stderr = sink();
  assert.equal(runAgentSourceCli(['detect'], { env, stdout, stderr }), 0);
  const registry = readAgentSourceRegistry({ env });
  const codex = registry.sources.find((source) => source.type === 'codex');

  const removedOut = sink();
  assert.equal(runAgentSourceCli(['remove', codex.id], { env, stdout: removedOut, stderr }), 0, 'an auto-detected source is now removable');
  assert.match(removedOut.text(), /will not re-add/);

  const listed = sink();
  runAgentSourceCli(['list'], { env, stdout: listed, stderr });
  assert.match(listed.text(), /disabled/);
  assert.match(listed.text(), / removed/);

  assert.equal(runAgentSourceCli(['enable', codex.id], { env, stdout: sink(), stderr }), 0);
  assert.equal(readAgentSourceRegistry({ env }).sources.find((source) => source.type === 'codex').enabled, true);
  assert.equal(runAgentSourceCli(['remove', 'nope'], { env, stdout: sink(), stderr: sink() }), 1);
});

test('DELETE removes an auto source over HTTP and the enable endpoint undoes it', async (t) => {
  const env = profile(t);
  const codexHome = path.join(env.USERPROFILE, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  let store = registerAgentSource({ version: 1, sources: [] }, { type: 'codex', path: codexHome, origin: 'auto' }, { env });
  const id = store.sources[0].id;
  const app = createHandoffHttpAdapter({
    rootDir: os.tmpdir(),
    env,
    readRegistry: () => store,
    writeRegistry: (registry) => { store = registry; return registry; },
    getAgentResourceStatus: () => ({ agents: [] }),
  });
  await withServer(app, async (origin) => {
    const removed = await (await fetch(`${origin}/api/agent-sources/${id}`, { method: 'DELETE' })).json();
    assert.equal(removed.ok, true);
    assert.equal(removed.data.suppressed, true);
    assert.equal(store.sources.find((source) => source.id === id).enabled, false);

    const enabled = await (await fetch(`${origin}/api/agent-sources/${id}/enable`, { method: 'POST' })).json();
    assert.equal(enabled.ok, true);
    assert.equal(store.sources.find((source) => source.id === id).enabled, true);

    const missing = await fetch(`${origin}/api/agent-sources/nope`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
  });
});

test('uninstall removes the descriptor and purges registrations, and cannot touch a built-in', (t) => {
  const env = profile(t);
  const home = path.join(env.USERPROFILE, 'plugin-home');
  fs.mkdirSync(path.join(home, '.sessions', 's1', 'agents', 'm1', 'system'), { recursive: true });
  fs.writeFileSync(path.join(home, '.sessions', 's1', 'agents', 'm1', 'system', 'trajectory.jsonl'), `${JSON.stringify({ role: 'user', content: 'hi' })}\n`);
  const descriptor = {
    specVersion: 1, type: 'pluginagent', label: 'Plugin Agent', capabilities: { sessions: true },
    homeCandidates: [{ env: 'PLUGIN_HOME', fallback: '{profile}/plugin-home' }],
    sessions: {
      kind: 'transcript', layout: 'directory-per-session', roots: ['{home}/.sessions'],
      transcript: { glob: 'agents/*/system/trajectory.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' },
      createdAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'max' },
    },
  };
  const install = installAgentDescriptor({ descriptor, env });
  assert.equal(install.ok, true);
  assert.equal(install.descriptorChange, 'created');
  assert.equal(install.sourceChange, 'registered');
  assert.equal(install.home.path, path.resolve(home));
  assert.equal(install.candidates.length, 1);
  assert.equal(fs.existsSync(install.descriptorPath), true);
  assert.equal(adapterFor('pluginagent', { env })?.label, 'Plugin Agent');

  // Idempotent: a test loop re-installs constantly and must be able to tell "no change" from "applied".
  const again = installAgentDescriptor({ descriptor, env });
  assert.equal(again.descriptorChange, 'unchanged');
  assert.equal(again.sourceChange, 'unchanged');
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 1);

  // A dry run must not touch anything.
  const dry = installAgentDescriptor({ descriptor: { ...descriptor, label: 'Other' }, env, dryRun: true });
  assert.equal(dry.descriptorChange, 'updated');
  assert.equal(descriptorFor('pluginagent', { env }).label, 'Plugin Agent', 'dry run changed nothing');

  const uninstall = uninstallAgentDescriptor({ type: 'pluginagent', env });
  assert.equal(uninstall.ok, true);
  assert.equal(uninstall.descriptorChange, 'removed');
  assert.equal(uninstall.purgedSources, 1);
  assert.equal(fs.existsSync(install.descriptorPath), false);
  resetDescriptorCache();
  assert.equal(descriptorFor('pluginagent', { env }), null);
  assert.equal(adapterFor('pluginagent', { env }), null, 'an uninstalled Agent leaves no adapter behind');
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 0, 'no tombstone is left with nothing to suppress');
  assert.equal(detectAgentSources(readAgentSourceRegistry({ env }), { env }).detected.length, 0, 'detection cannot resurrect it: the descriptor is gone');

  // Idempotent in both directions, and a plugin can never take over a built-in type.
  assert.equal(uninstallAgentDescriptor({ type: 'pluginagent', env }).descriptorChange, 'absent');
  const shadow = installAgentDescriptor({ descriptor: { ...descriptor, type: 'codex', label: 'Fake Codex' }, env });
  assert.equal(shadow.ok, false);
  assert.equal(shadow.error.code, 'builtin_type');
  const builtin = uninstallAgentDescriptor({ type: 'codex', env });
  assert.equal(builtin.ok, false);
  assert.equal(builtin.error.code, 'builtin_type');
});

test('install reports locations rather than mechanisms, and calls adoption by its name', (t) => {
  const env = profile(t);
  const home = path.join(env.USERPROFILE, 'acme-home');
  fs.mkdirSync(path.join(home, '.sessions', 's1', 'agents', 'm1', 'system'), { recursive: true });
  fs.writeFileSync(path.join(home, '.sessions', 's1', 'agents', 'm1', 'system', 'trajectory.jsonl'), `${JSON.stringify({ role: 'user', content: 'hi' })}\n`);
  const descriptor = {
    specVersion: 1, type: 'acme', label: 'Acme', capabilities: { sessions: true },
    homeCandidates: [
      { env: 'ACME_HOME', fallback: '{profile}/acme-home' },
      { fallback: '{profile}/acme-home' },
      { fallback: '{profile}/elsewhere' },
    ],
    sessions: {
      kind: 'transcript', layout: 'directory-per-session', roots: ['{home}/.sessions'],
      transcript: { glob: 'agents/*/system/trajectory.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' },
      createdAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'max' },
    },
  };
  // Descriptor only: the case where a plugin is installed before anything has looked for the Agent.
  const installed = installAgentDescriptor({ descriptor, env, register: false });
  assert.equal(installed.sourceChange, 'skipped');
  // Two candidates described the same place by different means; a report that lists it twice makes a
  // working install look broken.
  assert.equal(installed.candidates.filter((candidate) => candidate.path === path.resolve(home)).length, 1);
  assert.equal(installed.candidates.length, 2);

  // A detection pass had found this directory on its own. Registering it now is an adoption: a real
  // state change, and it must not be reported as "unchanged".
  const detected = detectAgentSources({ version: 1, sources: [] }, { env });
  writeAgentSourceRegistry(detected.registry, { env });
  assert.equal(detected.registry.sources.find((source) => source.type === 'acme').origin, 'auto');
  assert.equal(installAgentDescriptor({ descriptor, env }).sourceChange, 'adopted');
  assert.equal(installAgentDescriptor({ descriptor, env }).sourceChange, 'unchanged');
  // Detection never demotes the now-explicit registration back to `auto`.
  assert.equal(detectAgentSources(readAgentSourceRegistry({ env }), { env }).registry.sources.find((source) => source.type === 'acme').origin, 'manual');
});

test('a plugin installed with no home found still installs, and says so', (t) => {
  const env = profile(t);
  const descriptor = { specVersion: 1, type: 'absentagent', label: 'Absent', capabilities: { sessions: true }, homeCandidates: [{ fallback: '{profile}/nope' }], sessions: { kind: 'transcript', roots: ['{home}/x'], transcript: { glob: '*.jsonl', format: 'jsonl' }, id: { kind: 'filename' }, createdAt: { kind: 'mtime', glob: '*.jsonl' }, updatedAt: { kind: 'mtime', glob: '*.jsonl' } } };
  const report = installAgentDescriptor({ descriptor, env });
  assert.equal(report.ok, true);
  assert.equal(report.home, null);
  assert.equal(report.sourceChange, 'skipped');
  assert.deepEqual(report.warnings.map((warning) => warning.code), ['no_home_found']);
  assert.equal(fs.existsSync(report.descriptorPath), true, 'the integration is ready for when the Agent is');
  assert.equal(readAgentSourceRegistry({ env }).sources.length, 0);
});
