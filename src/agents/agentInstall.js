// Agent integration install / uninstall.
//
// This is the contract an Agent (or its installer) follows to configure itself against Margin:
//
//   install    validate the descriptor, resolve which of its candidate homes actually exists on this
//              machine, write the descriptor into the profile, and register the source.
//   uninstall  remove the descriptor and purge every registration for that type.
//
// Both are idempotent and both are dry-runnable, because the intended use is a repeatable loop —
// onboard an Agent, exercise it, remove it, repeat — not a one-shot setup wizard. Neither of them
// fetches anything over the network: obtaining the plugin is the Agent's job, so Margin never gains a
// download-and-execute surface.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinDescriptors } from './descriptor/builtin.js';
import { descriptorDirectory, resetDescriptorCache } from './descriptor/load.js';
import { resolveAgentHome } from './descriptor/readers.js';
import { normalizeDescriptor, validateDescriptor } from './descriptor/spec.js';
import { purgeAgentSources, readAgentSourceRegistry, registerAgentSource, writeAgentSourceRegistry } from './sourceRegistry.js';

const builtinTypes = new Set(builtinDescriptors.map((descriptor) => descriptor.type));
const profileOf = ({ env = process.env, homedir = os.homedir() } = {}) => env.USERPROFILE?.trim() || env.HOME?.trim() || homedir;

const readRegistry = (options) => {
  const registry = readAgentSourceRegistry(options);
  if (registry?.ok === false) {
    const error = new Error(registry.error?.message ?? 'Unable to read agent source registry');
    error.code = registry.error?.code ?? 'registry_unreadable';
    throw error;
  }
  return registry;
};

function writeDescriptorFile(dir, type, descriptor, dryRun) {
  const target = path.join(dir, `${type}.json`);
  const serialized = `${JSON.stringify(descriptor, null, 2)}\n`;
  let previous = null;
  try { previous = fs.readFileSync(target, 'utf8'); } catch { previous = null; }
  if (previous === serialized) return { target, changed: 'unchanged' };
  const changed = previous === null ? 'created' : 'updated';
  if (dryRun) return { target, changed };
  fs.mkdirSync(dir, { recursive: true });
  // Same publish-by-rename rule as the registry: a reader must never observe a half-written plugin.
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
    throw error;
  }
  return { target, changed };
}

function findDescriptorFile(type, options) {
  const dir = descriptorDirectory(options);
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json')); }
  catch { return null; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed?.type === type) return file;
    } catch { /* an unparseable file is reported by loadDescriptors, not by uninstall */ }
  }
  return null;
}

/**
 * Install one Agent descriptor into the current profile.
 *
 * `descriptor` may be the parsed object or a path to a JSON file (the shape an Agent would fetch).
 * Returns a report rather than throwing on the expected failures, so a test loop can branch on
 * `ok`/`error.code` without parsing messages.
 */
export function installAgentDescriptor({
  descriptor,
  path: explicitPath = null,
  env = process.env,
  homedir = os.homedir(),
  register = true,
  origin = 'manual',
  dryRun = false,
} = {}) {
  const options = { env, homedir };
  const validation = validateDescriptor(descriptor);
  if (!validation.ok) return { ok: false, error: { code: 'invalid_descriptor', errors: validation.errors } };
  const normalized = normalizeDescriptor(descriptor);
  if (builtinTypes.has(normalized.type)) {
    // A user-supplied file must never be able to replace an implementation Margin ships and verifies.
    return { ok: false, error: { code: 'builtin_type', type: normalized.type, message: `"${normalized.type}" is a built-in Agent type and cannot be installed from a descriptor` } };
  }

  const resolution = resolveAgentHome(normalized, { env, homedir, profile: profileOf(options) });
  const chosen = explicitPath ? { path: path.resolve(explicitPath), exists: true, probe: { valid: true, reason: null } } : resolution.resolved;
  const warnings = [];
  if (!chosen) {
    // Not an error: the descriptor is still worth installing so the integration is ready when the
    // Agent is. Saying so explicitly is what keeps "installed but not yet attached" from looking
    // like a broken install.
    warnings.push({ code: 'no_home_found', message: `No ${normalized.label} home was found on this machine; the descriptor is installed but no source was registered` });
  }

  const written = writeDescriptorFile(descriptorDirectory(options), normalized.type, descriptor, dryRun);

  let sourceChange = 'skipped';
  let source = null;
  if (register && chosen) {
    const registry = readRegistry(options);
    const before = registry.sources.find((item) => item.path === path.resolve(chosen.path) && item.type === normalized.type) ?? null;
    const next = registerAgentSource(registry, { type: normalized.type, path: chosen.path, name: normalized.label, origin }, options);
    source = next.sources.find((item) => item.path === path.resolve(chosen.path) && item.type === normalized.type) ?? null;
    // The report has to distinguish "already exactly like this" from "this install promoted an
    // auto-detected directory into an explicit registration", or a real state change shows up as
    // "unchanged" and the caller cannot tell a no-op from a first run.
    sourceChange = before === null ? 'registered'
      : (before.suppressed === true || before.enabled === false) ? 'enabled'
        : before.origin === 'auto' ? 'adopted'
          : 'unchanged';
    if (!dryRun) writeAgentSourceRegistry(next, options);
  }

  if (!dryRun) resetDescriptorCache();
  return {
    ok: true,
    type: normalized.type,
    label: normalized.label,
    dryRun,
    descriptorPath: written.target,
    descriptorChange: written.changed,
    home: chosen ? { path: path.resolve(chosen.path), probe: chosen.probe } : null,
    candidates: resolution.candidates,
    sourceId: source?.sourceId ?? null,
    sourceChange,
    warnings,
  };
}

/**
 * Remove an Agent integration: the descriptor plus every registration of its type.
 *
 * Registrations are purged rather than tombstoned because the descriptor that could recreate the
 * Agent is going away in the same operation — a tombstone would be permanent clutter with nothing
 * left to suppress. Removing a *built-in* Agent is refused: only its source can be removed.
 */
export function uninstallAgentDescriptor({ type, env = process.env, homedir = os.homedir(), dryRun = false } = {}) {
  const options = { env, homedir };
  if (typeof type !== 'string' || !type.trim()) return { ok: false, error: { code: 'invalid_agent_type' } };
  if (builtinTypes.has(type)) {
    return { ok: false, error: { code: 'builtin_type', type, message: `"${type}" is a built-in Agent type; remove its source instead` } };
  }

  const file = findDescriptorFile(type, options);
  const registry = readRegistry(options);
  const before = registry.sources.filter((source) => source.type === type).length;
  if (!dryRun) {
    if (file) fs.rmSync(file, { force: true });
    if (before) writeAgentSourceRegistry(purgeAgentSources(registry, type, options), options);
    resetDescriptorCache();
  }
  return {
    ok: true,
    type,
    dryRun,
    descriptorPath: file,
    descriptorChange: file ? 'removed' : 'absent',
    purgedSources: before,
    warnings: [],
  };
}
