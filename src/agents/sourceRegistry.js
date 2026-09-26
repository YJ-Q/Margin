import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { builtinDescriptors } from './descriptor/builtin.js';
import { descriptorFor, descriptorsFor } from './descriptor/load.js';
import { expandTemplate, resolveAgentHome } from './descriptor/readers.js';

// The built-in Agent types. Derived from the descriptors rather than repeated here, so "add an
// Agent" can never again mean "remember to update this array too".
export const AGENT_TYPES = Object.freeze(builtinDescriptors.slice().sort((left, right) => (left.order - right.order) || left.type.localeCompare(right.type)).map((descriptor) => descriptor.type));

export const AGENT_CAPABILITIES = Object.freeze(['sessions', 'handoff', 'apiUsage', 'quota', 'executionStatus', 'attentionStatus', 'subscriptionQuota']);

// A type is now gated on its FORMAT, not on an allowlist. The allowlist was the single hard blocker
// for a new Agent — `margin agent add deepseek` failed outright and a hand-edited registry entry was
// dropped without a word. Registering an Agent whose adapter does not exist yet is a legitimate,
// inspectable state; registering a path that does not exist is not.
const TYPE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const ADAPTER_REQUIRED = 'Registered · Adapter required';

const cleanPath = (value) => path.resolve(String(value ?? '').trim());
const sourceId = (type, sourcePath) => `${type}-${createHash('sha256').update(`${type}:${sourcePath.toLowerCase()}`).digest('hex').slice(0, 12)}`;

const profileOf = ({ env = process.env, homedir = os.homedir } = {}) => env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();

export function registryPath({ env = process.env, homedir = os.homedir } = {}) {
  return path.join(profileOf({ env, homedir }), '.margin', 'agent-sources.json');
}

// Every capability and support-level answer now comes from the descriptor that owns the type. An
// unknown type is not an error: it is a registered Agent still waiting for its adapter, and saying so
// is what lets the UI explain the state instead of showing an empty list.
function capabilitiesFor(type, options) {
  const descriptor = descriptorFor(type, options);
  if (!descriptor) return Object.freeze({ sessions: false, handoff: false, apiUsage: false, quota: false, executionStatus: false, attentionStatus: false });
  return Object.freeze({ ...descriptor.capabilities });
}

function supportFor(type, options) {
  return descriptorFor(type, options)?.supportLevel ?? ADAPTER_REQUIRED;
}

function displayNameFor(type, options) {
  const descriptor = descriptorFor(type, options);
  return `${descriptor?.defaultSourceName ?? type} source`;
}

function normalizeSource(value, options = {}) {
  const type = typeof value?.agentType === 'string' ? value.agentType : value?.type;
  const rawPath = value?.home ?? value?.path;
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type) || typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const sourcePath = cleanPath(rawPath);
  const origin = value.origin === 'auto' ? 'auto' : 'manual';
  const id = typeof value.sourceId === 'string' && value.sourceId.trim() ? value.sourceId : (typeof value.id === 'string' ? value.id : sourceId(type, sourcePath));
  // `suppressed` is an explicit "removed by the user" tombstone. It stays in the registry on purpose:
  // deleting the record instead would let the next detection pass silently recreate it, which is
  // exactly why an auto-detected Agent could never be removed. A suppressed record is always
  // disabled, so every discovery path already ignores it.
  const suppressed = value.suppressed === true;
  return { id, sourceId: id, type, agentType: type,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : displayNameFor(type, options),
    path: sourcePath, home: sourcePath, origin, registration: origin, detected: origin === 'auto', manual: origin === 'manual',
    enabled: suppressed ? false : value.enabled !== false,
    ...(suppressed ? { suppressed: true, suppressedAt: typeof value.suppressedAt === 'string' ? value.suppressedAt : null } : {}),
    capabilities: capabilitiesFor(type, options), supportLevel: supportFor(type, options) };
}

export function readAgentSourceRegistry(options = {}) {
  const target = registryPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || (parsed.sources !== undefined && !Array.isArray(parsed.sources))) throw new TypeError('invalid_agent_source_registry');
    return { ok: true, version: 1, sources: (parsed.sources ?? []).map((source) => normalizeSource(source, options)).filter(Boolean) };
  } catch (error) {
    // A profile with no registry is the normal first-run case.  Anything else is
    // deliberately not treated as an empty registry: detection must never overwrite a
    // user's corrupt or temporarily unreadable configuration.
    if (error?.code === 'ENOENT') return { ok: true, version: 1, sources: [] };
    return { ok: false, version: 1, sources: [], error: { code: 'registry_unreadable', message: error?.message ?? 'Unable to read agent source registry' } };
  }
}

export function writeAgentSourceRegistry(registry, options = {}) {
  const target = registryPath(options);
  const sources = (registry?.sources ?? []).map((source) => normalizeSource(source, options)).filter(Boolean);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Adapter startup performs best-effort detection in every process.  A direct write lets a
  // reader in another test/host observe a truncated JSON document between open/write/close.
  // Write beside the target and publish with one rename so readers see either the old complete
  // registry or the new complete registry, never an intermediate buffer.
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sources }, null, 2), 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original write error */ }
    throw error;
  }
  return { version: 1, sources };
}

export function registerAgentSource(registry, { type, path: sourcePath, name, origin = 'manual', enabled = true }, options = {}) {
  // Only the type's FORMAT is validated. An Agent whose adapter is not installed yet registers
  // successfully and reports `Registered · Adapter required` — the registration is not the place to
  // decide whether an adapter exists.
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) throw new TypeError('invalid_agent_type');
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new TypeError('invalid_agent_source_path');
  const normalizedPath = cleanPath(sourcePath);
  const id = sourceId(type, normalizedPath);
  const source = normalizeSource({ id, type, path: normalizedPath, name, origin, enabled }, options);
  const existing = (registry?.sources ?? []).map((item) => normalizeSource(item, options)).filter(Boolean).find((item) => item.id === id);
  // Detection is additive convenience. It must not turn a disabled, suppressed, manual, or
  // custom-labelled record back on merely because it found the same directory. The previous
  // implementation only honoured that for `origin === 'manual'`, so a user's explicit removal of an
  // auto-detected Agent was undone by the very next detection pass.
  const sticky = Boolean(existing) && (existing.origin === 'manual' || existing.enabled === false || existing.suppressed === true);
  const preserved = origin === 'auto' && sticky ? existing : source;
  const others = (registry?.sources ?? []).map((item) => normalizeSource(item, options)).filter(Boolean).filter((item) => item.id !== id);
  return { version: 1, sources: [...others, preserved] };
}

// Removal has to mean the same thing for both origins. A source that detection would recreate gets a
// tombstone; one it cannot recreate is dropped outright. Guessing wrong in the other direction either
// loses a user's registration silently or makes an Agent impossible to get rid of.
function isReattachable(source, options) {
  return agentHomeCandidates(source.type, options).some((candidate) => candidate === source.path);
}

export function removeAgentSource(registry, id, options = {}) {
  const sources = (registry?.sources ?? []).map((source) => normalizeSource(source, options)).filter(Boolean);
  const target = sources.find((source) => source.id === id);
  if (!target) return { version: 1, sources };
  if (!isReattachable(target, options)) return { version: 1, sources: sources.filter((source) => source.id !== id) };
  return { version: 1, sources: sources.map((source) => source.id === id
    ? normalizeSource({ ...source, enabled: false, suppressed: true, suppressedAt: new Date().toISOString() }, options)
    : source) };
}

// The undo for a removal, so a mis-click is never a hand-edit of agent-sources.json.
export function enableAgentSource(registry, id, options = {}) {
  return { version: 1, sources: (registry?.sources ?? []).map((source) => normalizeSource(source, options)).filter(Boolean)
    .map((source) => source.id === id ? normalizeSource({ ...source, enabled: true, suppressed: false }, options) : source) };
}

// Drops every registration for a type, including tombstones. Used by uninstall, where the descriptor
// that could recreate the Agent is being removed in the same operation.
export function purgeAgentSources(registry, type, options = {}) {
  return { version: 1, sources: (registry?.sources ?? []).map((source) => normalizeSource(source, options)).filter(Boolean).filter((source) => source.type !== type) };
}

export function validateSource(source) {
  try { return fs.statSync(source.path).isDirectory() ? { valid: true, reason: null } : { valid: false, reason: 'Path is not a directory' }; }
  catch { return { valid: false, reason: 'Path does not exist' }; }
}

// Default homes come from the descriptors. The PRIMARY candidate is what the CLI offers as the path
// default; every candidate is what detection and install actually try, which is how one descriptor
// fits machines that keep the Agent in different places.
export function defaultSourcePaths(options = {}) {
  const env = options.env ?? process.env;
  const profile = profileOf(options);
  return descriptorsFor(options).descriptors
    .filter((descriptor) => descriptor.defaultHome)
    .map((descriptor) => ({
      type: descriptor.type,
      path: resolveCandidatePath(descriptor.defaultHome, { env, profile }),
      name: descriptor.label,
    }));
}

function resolveCandidatePath(candidate, { env, profile }) {
  const fromEnv = candidate.env ? String(env[candidate.env] ?? '').trim() : '';
  return fromEnv || expandTemplate(candidate.fallback, { home: null, profile, env });
}

// Every place a type could be attached, so "would detection recreate this?" is answered against the
// same candidate list detection itself uses rather than against one hardcoded path.
export function agentHomeCandidates(type, options = {}) {
  const descriptor = descriptorFor(type, options);
  if (!descriptor) return [];
  const env = options.env ?? process.env;
  const profile = profileOf(options);
  return (descriptor.homeCandidates ?? [])
    .map((candidate) => resolveCandidatePath(candidate, { env, profile }))
    .filter(Boolean)
    .map((value) => cleanPath(value));
}

// Detection only registers directories that are actually present. It never deletes manual choices,
// and — via registerAgentSource — it never resurrects a removed one.
export function detectAgentSources(registry, options = {}) {
  let next = registry ?? { version: 1, sources: [] };
  const detected = [];
  for (const descriptor of descriptorsFor(options).descriptors) {
    for (const candidate of resolveAgentHome(descriptor, { env: options.env ?? process.env, homedir: options.homedir, profile: profileOf(options) }).candidates) {
      if (!candidate.exists) continue;
      const source = normalizeSource({ type: descriptor.type, path: candidate.path, name: descriptor.label, origin: 'auto' }, options);
      if (!validateSource(source).valid) continue;
      next = registerAgentSource(next, source, options);
      const stored = next.sources.find((item) => item.id === source.id);
      // Report what actually happened to the record, not merely that a directory was seen: a removed
      // Agent is still on disk, and "Detected" without "still removed" is how a user concludes that
      // removal silently failed.
      detected.push({ ...source, enabled: stored?.enabled !== false, suppressed: stored?.suppressed === true });
      break;
    }
  }
  return { registry: next, detected };
}

// Explicit manual registration wins. Otherwise an auto record matching the Agent's declared home
// environment variable wins, followed by the normal detected default.
export function resolveActiveSource(registry, type, options = {}) {
  const sources = (registry?.sources ?? []).map((source) => normalizeSource(source, options)).filter((source) => source?.type === type && source.enabled);
  const manual = sources.filter((source) => source.origin === 'manual');
  if (manual.length) return manual[manual.length - 1];
  const envName = descriptorFor(type, options)?.envHome ?? null;
  const envPath = envName ? options.env?.[envName] ?? process.env?.[envName] : null;
  if (typeof envPath === 'string' && envPath.trim()) {
    const wanted = cleanPath(envPath);
    const match = sources.find((source) => source.path === wanted);
    if (match) return match;
  }
  return sources[sources.length - 1] ?? null;
}

// Diagnostics for a registered-but-unreadable Agent. The spec's own probe is the answer for a
// descriptor-backed Agent; a type with no descriptor has nothing to probe and says so.
export function describeSourceSupport(type, options = {}) {
  const descriptor = descriptorFor(type, options);
  return {
    type,
    supportLevel: descriptor?.supportLevel ?? ADAPTER_REQUIRED,
    adapterRequired: !descriptor,
    source: descriptor?.source ?? null,
  };
}

export function descriptorProblems(options = {}) {
  return descriptorsFor(options).problems;
}
