// Descriptor loading: the built-in set plus whatever an Agent's own installer dropped into the
// profile-scoped user directory.
//
// Two properties matter more than convenience here:
//   * a malformed or unsatisfiable descriptor is REPORTED, never silently skipped. "Registered but
//     reads nothing" was the single most confusing part of onboarding, and it is exactly what an
//     ignored file produces.
//   * a user descriptor can never take over a built-in type. Overriding a verified adapter from a
//     file the user did not read would be a privilege escalation dressed up as extensibility.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinDescriptors } from './builtin.js';
import { compositionProblems } from './compose.js';
import { normalizeDescriptor, validateDescriptor } from './spec.js';

const profileOf = ({ env = process.env, homedir = os.homedir } = {}) => env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();

export function descriptorDirectory(options = {}) {
  return path.join(profileOf(options), '.margin', 'agents');
}

// Re-reading a directory of a handful of small JSON files on every source normalization would be
// wasteful, but caching without a signature would pin a stale descriptor across an Agent upgrade.
// The signature is the file set plus each file's size and mtime.
function directorySignature(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch { return null; }
  return entries.filter((name) => name.toLowerCase().endsWith('.json')).sort()
    .map((name) => {
      try { const stat = fs.statSync(path.join(dir, name)); return `${name}:${stat.size}:${Math.floor(stat.mtimeMs)}`; }
      catch { return `${name}:?`; }
    })
    .join('|');
}

const userCache = new Map();

function readUserDescriptors(options = {}) {
  const dir = descriptorDirectory(options);
  const signature = directorySignature(dir);
  if (signature === null) return [];
  const cached = userCache.get(dir);
  if (cached?.signature === signature) return cached.entries;
  const entries = [];
  for (const name of fs.readdirSync(dir).filter((item) => item.toLowerCase().endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      entries.push({ file, raw: null, parseError: error?.message ?? 'unreadable descriptor' });
      continue;
    }
    entries.push({ file, raw });
  }
  userCache.set(dir, { signature, entries });
  return entries;
}

export function resetDescriptorCache() { userCache.clear(); }

// Returns { descriptors, problems }. `descriptors` is ordered: built-ins first in declaration order,
// then user descriptors by their declared order. `problems` is the diagnostic surface a CLI or the
// Settings panel renders instead of leaving the user to guess why a registered Agent is empty.
// Whether a type has a built-in adapter module is a static fact, not a caller-supplied opinion: a
// built-in descriptor is the only thing that can name one, and a user descriptor can never own a
// built-in type (see the duplicate check below). Deriving it here removes a parameter that callers
// could disagree about, and with it a whole class of "works in the CLI, not in the app" bugs.
const builtinTypeSet = new Set(builtinDescriptors.map((descriptor) => descriptor.type));
export const hasBuiltinAdapter = (type) => builtinTypeSet.has(type);

export function loadDescriptors({
  env = process.env,
  homedir = os.homedir,
  builtin = builtinDescriptors,
} = {}) {
  const problems = [];
  const collected = [];
  const builtinTypes = new Set();

  for (const raw of builtin) {
    const validation = validateDescriptor(raw);
    if (!validation.ok) {
      problems.push({ type: typeof raw?.type === 'string' ? raw.type : null, code: 'invalid_descriptor', source: 'builtin', errors: validation.errors });
      continue;
    }
    builtinTypes.add(raw.type);
    collected.push({ descriptor: normalizeDescriptor({ ...raw, source: 'builtin' }), hasBuiltinAdapter: true });
  }

  for (const entry of readUserDescriptors({ env, homedir })) {
    if (entry.parseError) {
      problems.push({ type: null, code: 'descriptor_unreadable', source: entry.file, errors: [entry.parseError] });
      continue;
    }
    const type = typeof entry.raw?.type === 'string' ? entry.raw.type : null;
    const validation = validateDescriptor(entry.raw);
    if (!validation.ok) {
      problems.push({ type, code: 'invalid_descriptor', source: entry.file, errors: validation.errors });
      continue;
    }
    if (builtinTypes.has(entry.raw.type)) {
      problems.push({ type: entry.raw.type, code: 'descriptor_duplicate_type', source: entry.file, errors: ['a built-in descriptor already owns this type; the built-in one is used'] });
      continue;
    }
    collected.push({ descriptor: normalizeDescriptor({ ...entry.raw, source: entry.file }), hasBuiltinAdapter: hasBuiltinAdapter(entry.raw.type) });
  }

  // An unsatisfiable descriptor is reported with the reason composition would have thrown, so the
  // user sees "this needs a built-in adapter for type X" rather than an unexplained empty Board.
  const usable = [];
  for (const entry of collected) {
    const issues = compositionProblems(entry.descriptor, { hasBuiltinAdapter: entry.hasBuiltinAdapter });
    if (issues.length) {
      problems.push({ type: entry.descriptor.type, code: 'descriptor_adapter_missing', source: entry.descriptor.source, errors: issues });
      continue;
    }
    usable.push(entry.descriptor);
  }

  usable.sort((left, right) => (left.order - right.order) || left.type.localeCompare(right.type));
  return { descriptors: usable, problems };
}

const lookupCache = new Map();

export function descriptorsFor(options = {}) {
  const dir = descriptorDirectory(options);
  const signature = directorySignature(dir);
  const cached = lookupCache.get(dir);
  if (cached && cached.signature === signature) return cached.result;
  const result = loadDescriptors(options);
  lookupCache.set(dir, { signature, result });
  return result;
}

// Used by hosts that need a descriptor for display (label, resource-key, provider) without
// composing an adapter. Returns null for a type no descriptor covers.
export function descriptorFor(type, options = {}) {
  if (typeof type !== 'string' || !type.trim()) return null;
  return descriptorsFor(options).descriptors.find((descriptor) => descriptor.type === type) ?? null;
}

export function builtinDescriptorFor(type) {
  return builtinDescriptors.find((descriptor) => descriptor.type === type) ?? null;
}
