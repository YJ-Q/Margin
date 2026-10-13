import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { builtinDescriptors } from '../src/agents/descriptor/builtin.js';
import { descriptorsFor, loadDescriptors, resetDescriptorCache } from '../src/agents/descriptor/load.js';
import { normalizeDescriptor, validateDescriptor } from '../src/agents/descriptor/spec.js';
import {
  isPathContained,
  isUnsafeIntegrationRoot,
  resolveAgentHome,
} from '../src/agents/descriptor/readers.js';
import { adapterFor } from '../src/agents/adapters.js';
import { detectAgentSources } from '../src/agents/sourceRegistry.js';

const pluginPath = (name) => new URL(`../plugins/${name}/agent.json`, import.meta.url);

// A fresh profile. Nothing here reads the real user profile.
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-descriptor-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { USERPROFILE: root, HOME: root };
}

// A descriptor that is valid under today's rules: a declarative transcript Agent.
function transcriptDescriptor(overrides = {}) {
  return {
    specVersion: 1,
    type: 'acme',
    label: 'Acme',
    capabilities: { sessions: true },
    sessions: {
      kind: 'transcript',
      layout: 'directory-per-session',
      roots: ['{home}/.sessions'],
      transcript: { glob: 'agents/*/system/trajectory.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' },
      createdAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'min' },
      updatedAt: { kind: 'mtime', glob: 'agents/*/system/*', pick: 'max' },
    },
    handoff: { kind: 'none' },
    ...overrides,
  };
}

// ---- 1. Closed top-level key set ---------------------------------------------------------

test('an unknown top-level key is a validation error with an actionable suggestion', () => {
  // The motivating typo: `resource` instead of `resources` silently disables the resource reader.
  const typo = validateDescriptor(transcriptDescriptor({ resource: { kind: 'builtin' } }));
  assert.equal(typo.ok, false);
  assert.match(typo.errors.join(' | '), /unknown top-level key "resource"/);
  assert.match(typo.errors.join(' | '), /did you mean "resources"\?/);

  // Another top-level typo that would silently drop a whole section.
  const capabilitiesTypo = validateDescriptor(transcriptDescriptor({ capabilites: { sessions: true } }));
  assert.equal(capabilitiesTypo.ok, false);
  assert.match(capabilitiesTypo.errors.join(' | '), /unknown top-level key "capabilites"/);

  // A key with no near neighbour is still refused, just without a suggestion.
  const nonsense = validateDescriptor(transcriptDescriptor({ zzzzzzzzzzz: 1 }));
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.errors.join(' | '), /unknown top-level key "zzzzzzzzzzz"/);
});

test('comment keys remain reserved and do not trip the closed key set', () => {
  const descriptor = transcriptDescriptor({
    $comment: 'top level',
    $comment_home: 'candidate notes',
    $comment_probe: 'structural check notes',
  });
  const result = validateDescriptor(descriptor);
  assert.equal(result.ok, true, result.errors.join('; '));
});

// ---- 2. Capability / resource cross-field rules ------------------------------------------

test('resource-family capabilities require declared resource wiring', () => {
  for (const capability of ['quota', 'apiUsage', 'subscriptionQuota']) {
    const result = validateDescriptor(transcriptDescriptor({ capabilities: { sessions: true, [capability]: true } }));
    assert.equal(result.ok, false, `${capability} with no resources must fail`);
    assert.match(result.errors.join(' | '), new RegExp(`capabilities\\.${capability} is true but resources\\.kind is none`), capability);
  }

  // Wiring a resource reader makes the flag legitimate. This is the shape Codex uses, so the rule
  // is about consistency, not about forbidding the capability.
  const wired = validateDescriptor({
    specVersion: 1,
    type: 'acme',
    label: 'Acme',
    capabilities: { sessions: true, quota: true, apiUsage: true },
    sessions: { kind: 'builtin' },
    resources: { kind: 'builtin' },
    handoff: { kind: 'none' },
  });
  assert.equal(wired.ok, true, wired.errors.join('; '));

  // A declared but unwired resource reader is still allowed: Claude ships resources.kind builtin
  // while correctly reporting quota/apiUsage false because an external proof gates the read.
  const declaredOnly = validateDescriptor(transcriptDescriptor({ resources: { kind: 'none' }, capabilities: { sessions: true, quota: false } }));
  assert.equal(declaredOnly.ok, true, declaredOnly.errors.join('; '));
});

// ---- 3. Session root containment ---------------------------------------------------------

test('a session root must be anchored at {home}', () => {
  for (const root of ['{profile}', 'C:/', '/etc', '%ENV:HOME%']) {
    const result = validateDescriptor(transcriptDescriptor({ sessions: { ...transcriptDescriptor().sessions, roots: [root] } }));
    assert.equal(result.ok, false, `root ${root} must be rejected`);
    assert.match(result.errors.join(' | '), /must be \{home\} or a path beneath it/, root);
  }

  for (const root of ['{home}', '{home}/.sessions', '{home}\\.sessions']) {
    const result = validateDescriptor(transcriptDescriptor({ sessions: { ...transcriptDescriptor().sessions, roots: [root] } }));
    assert.equal(result.ok, true, `${root}: ${result.errors.join('; ')}`);
  }
});

test('the containment helpers treat only real children as contained', () => {
  const root = path.resolve(os.tmpdir(), 'margin-boundary', 'home');
  assert.equal(isPathContained(root, root), true);
  assert.equal(isPathContained(path.join(root, '.sessions'), root), true);
  assert.equal(isPathContained(path.join(root, '..', 'escape'), root), false);
  assert.equal(isPathContained(`${root}-evil`, root), false);

  const profileRoot = path.resolve(os.tmpdir(), 'margin-boundary');
  assert.equal(isUnsafeIntegrationRoot(profileRoot, profileRoot), true);
  assert.equal(isUnsafeIntegrationRoot(path.parse(profileRoot).root, profileRoot), true);
  assert.equal(isUnsafeIntegrationRoot(path.join(profileRoot, 'agent-home'), profileRoot), false);
});

test('a session root that escapes its home is refused at read time', async (t) => {
  const env = profile(t);
  const home = path.join(env.USERPROFILE, 'escape-home');
  fs.mkdirSync(home, { recursive: true });
  const dir = path.join(env.USERPROFILE, '.margin', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  // Passes the static anchor check but resolves to the parent directory after expansion: the
  // dynamic containment read is what refuses it.
  const descriptor = transcriptDescriptor({
    type: 'escaper',
    label: 'Escaper',
    sessions: { ...transcriptDescriptor().sessions, roots: ['{home}/../escape'] },
  });
  assert.equal(validateDescriptor(descriptor).ok, true);
  fs.writeFileSync(path.join(dir, 'escaper.json'), JSON.stringify(descriptor));
  resetDescriptorCache();

  const adapter = adapterFor('escaper', { env });
  assert.ok(adapter);
  const source = { id: 'escaper-source', sourceId: 'escaper-source', type: 'escaper', path: home, enabled: true };
  await assert.rejects(
    () => adapter.collectSessionSnapshots(source, { env }),
    (error) => error?.code === 'session_root_outside_home',
  );
});

test('an unsafe declared home is never resolved and never detected', (t) => {
  const env = profile(t);
  const descriptor = normalizeDescriptor({
    specVersion: 1,
    type: 'rooty',
    label: 'Rooty',
    capabilities: { sessions: false },
    defaultHome: { fallback: '{profile}' },
    sessions: { kind: 'none' },
    handoff: { kind: 'none' },
  });

  const resolution = resolveAgentHome(descriptor, { env, homedir: env.USERPROFILE, profile: env.USERPROFILE });
  assert.equal(resolution.candidates.length, 1);
  assert.equal(resolution.candidates[0].unsafe, true, 'the profile root is an unsafe Agent home');
  assert.equal(resolution.candidates[0].exists, true, 'existence is still reported honestly');
  assert.equal(resolution.resolved, null, 'an unsafe candidate is never resolved');

  // Detection uses the same candidate list, so it must not register the profile root as a source.
  const dir = path.join(env.USERPROFILE, '.margin', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rooty.json'), JSON.stringify({
    specVersion: 1, type: 'rooty', label: 'Rooty', capabilities: { sessions: false },
    defaultHome: { fallback: '{profile}' }, sessions: { kind: 'none' }, handoff: { kind: 'none' },
  }));
  resetDescriptorCache();
  assert.equal(descriptorsFor({ env }).descriptors.some((item) => item.type === 'rooty'), true);
  const detected = detectAgentSources({ version: 1, sources: [] }, { env });
  assert.equal(detected.detected.some((source) => source.type === 'rooty'), false);
  assert.equal(detected.registry.sources.some((source) => source.type === 'rooty'), false);
});

// ---- 4. Built-in compatibility -----------------------------------------------------------

test('the built-in Codex/Claude/Pi descriptors and the shipped plugin still validate', () => {
  for (const raw of builtinDescriptors) {
    const validation = validateDescriptor(raw);
    assert.equal(validation.ok, true, `built-in ${raw.type}: ${validation.errors.join('; ')}`);
    assert.ok(adapterFor(raw.type), `no composed adapter for built-in ${raw.type}`);
  }
  // Codex and Pi exercise the resource-family rule as a positive case, not a breakage.
  const codex = builtinDescriptors.find((descriptor) => descriptor.type === 'codex');
  assert.equal(codex.capabilities.quota, true);
  assert.equal(codex.capabilities.apiUsage, true);
  assert.equal(codex.resources.kind, 'builtin');
  const pi = builtinDescriptors.find((descriptor) => descriptor.type === 'pi');
  assert.equal(pi.capabilities.subscriptionQuota, true);
  assert.equal(pi.resources.kind, 'builtin');

  const doubao = JSON.parse(fs.readFileSync(pluginPath('doubao'), 'utf8'));
  const pluginValidation = validateDescriptor(doubao);
  assert.equal(pluginValidation.ok, true, pluginValidation.errors.join('; '));
});

test('a fresh profile loads every built-in descriptor with no problems', (t) => {
  const env = profile(t);
  resetDescriptorCache();
  const { descriptors, problems } = loadDescriptors({ env });
  assert.deepEqual(problems, []);
  assert.deepEqual(descriptors.map((descriptor) => descriptor.type).sort(), ['claude', 'codex', 'pi']);
});
