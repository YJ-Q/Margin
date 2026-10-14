// `margin agent verify` — read-only, evidence-producing observation of a descriptor.
//
// This is the implementation of the S10.2B design (docs/research/agent-verify-design.md). It turns the
// validation / probe / discovery primitives into one command that answers a single question:
//
//   Does this declaration read THIS machine, through the same adapter the hosts consume, and
//   publish at least one invariant-clean session?
//
// It is deliberately narrow. It never writes, never reads credentials, never makes a network call,
// and never invokes a handoff/capture/resource method. It reuses:
//
//   validateDescriptor + compositionProblems + the builtin guard  (descriptor legality)
//   installAgentDescriptor({ dryRun: true, register: false })     (validation + builtin guard only)
//   resolveAgentHome + probeDescriptor                            (fresh source evidence, never a
//                                                                  dry-run's synthetic candidate)
//   composeAdapter / adapterFor + readSessionSnapshots            (the host's own read path)
//
// Three prerequisites from the design are load-bearing here:
//   P-1 `compose.js` preserves a thrown reader `error.code`, so `session_root_outside_home` is not
//       collapsed into a generic read failure.
//   P-2 `source.probe.state` is derived from the declaration + a real probe, never from a boolean.
//   P-3 verify re-probes independently; installation dry-run proves composition only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findDescriptorFile, installAgentDescriptor } from './agentInstall.js';
import { adapterFor } from './adapters.js';
import { composeAdapter, compositionProblems } from './descriptor/compose.js';
import { hasBuiltinAdapter } from './descriptor/load.js';
import { isUnsafeIntegrationRoot, probeDescriptor, resolveAgentHome } from './descriptor/readers.js';
import { normalizeDescriptor, validateDescriptor } from './descriptor/spec.js';
import { AGENT_CAPABILITIES, detectAgentSources, readAgentSourceRegistry, registryPath, resolveActiveSource, validateSource } from './sourceRegistry.js';

export const RESULT_VERSION = 1;
export const DEFAULT_SAMPLE = 5;
export const MAX_SAMPLE = 50;

// The explicit probe state. `passed`/`failed` are a real declaration that ran; `not_declared` means
// the descriptor never asked for a structural check; `unavailable` means there was no home to probe;
// `rejected` means the home itself was refused as unsafe before a probe could run; `not_applicable`
// means the descriptor declares no session source (`sessions.kind: "none"`), so a session probe has
// nothing to check. No boolean is ever rendered as "probe passed".
export const PROBE_STATES = Object.freeze(['passed', 'failed', 'not_declared', 'unavailable', 'rejected', 'not_applicable']);

// The closed vocabulary of machine-readable reason codes behind each verdict. The four verdicts are
// the coarse automation signal; the reason code is the stable, typed detail that keeps distinct
// sentences from sharing a verdict — in particular "no session source is declared" (the descriptor
// offers nothing to read) versus "the reader returned zero sessions" (a source exists and ran).
//   verified      → null (the observation itself is the reason)
//   no_sessions   → 'reader_returned_empty'
//   unavailable   → one of the unavailable codes below
//   rejected      → the terminal refusal code (see REFUSAL AUTHORITIES in docs/agent-verify.md)
export const REASON_CODES = Object.freeze({
  no_sessions: Object.freeze(['reader_returned_empty']),
  unavailable: Object.freeze(['session_source_not_declared', 'no_home_found', 'source_disabled', 'source_unavailable', 'source_read_failed', 'installation_read_failed']),
});

const VERDICT_EXIT_CODES = Object.freeze({ verified: 0, no_sessions: 2, unavailable: 3, rejected: 4 });

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; }
  catch { return null; }
})();

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const profileOf = ({ env = process.env, homedir = os.homedir() } = {}) => env.USERPROFILE?.trim() || env.HOME?.trim() || homedir;
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function verifyExitCode(verdict) {
  return VERDICT_EXIT_CODES[verdict] ?? 1;
}

// A canonical, key-sorted, formatting-insensitive digest of a descriptor. Both the input and the
// installed file pass through `normalizeDescriptor`, so a re-indented or re-commented file does not
// read as a mismatch while a semantic edit does.
export function descriptorDigest(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  try { return sha256(JSON.stringify(normalizeDescriptor(descriptor))); }
  catch { return null; }
}

function baseResult({ input = null, generatedAt = new Date().toISOString(), descriptor = null } = {}) {
  return {
    resultVersion: RESULT_VERSION,
    generatedAt,
    tool: { name: 'margin', version: VERSION, command: 'agent verify' },
    input: {
      kind: input?.kind ?? null,
      path: input?.path ?? null,
      sha256: input?.sha256 ?? null,
      type: nonEmpty(descriptor?.type) ? descriptor.type : null,
      label: nonEmpty(descriptor?.label) ? descriptor.label : null,
      specVersion: Number.isFinite(descriptor?.specVersion) ? descriptor.specVersion : null,
    },
    verdict: 'rejected',
    // Stable, machine-readable detail behind `verdict` (see REASON_CODES). Null only for verified.
    // Rejected verdicts carry the terminal refusal code here as well as in `refusals[]`.
    reasonCode: null,
    scope: 'the verified input, read through its own declaration against this machine',
    stages: [],
    refusals: [],
    notes: [],
    evidenceSources: [],
  };
}

// S0 failed: the bytes were never parseable JSON. The document is still emitted so a caller never
// has to distinguish "no output" from "verdict rejected".
export function verifyManifestError({ input = null, message, generatedAt = new Date().toISOString() } = {}) {
  const result = baseResult({ input, generatedAt });
  result.stages.push({ stage: 'load', status: 'failed', errors: [message ?? 'unable to parse descriptor'] });
  result.reasonCode = 'invalid_descriptor';
  return result;
}

// Refusals name the authority that refused, so the user can see which rule fired rather than an
// opaque "invalid descriptor".
function classifyValidationError(message) {
  const text = String(message);
  const errorPath = text.match(/^([a-zA-Z][a-zA-Z0-9_.]*)(?:\[\d+\])?/)?.[1] ?? null;
  if (text.startsWith('unknown top-level key')) {
    return { code: 'invalid_descriptor', path: text.match(/unknown top-level key "([^"]+)"/)?.[1] ?? null, declared: null, reason: text, authority: 'spec.closed_keys' };
  }
  if (text.startsWith('sessions.roots')) {
    return { code: 'invalid_descriptor', path: text.match(/^(sessions\.roots\[\d+\])/)?.[1] ?? 'sessions.roots', declared: null, reason: text, authority: 'spec.root_containment' };
  }
  if (/^sessions\./.test(text) || /^executionStatus\./.test(text)) {
    return { code: 'invalid_descriptor', path: errorPath, declared: null, reason: text, authority: 'spec.extractor' };
  }
  return { code: 'invalid_descriptor', path: errorPath, declared: null, reason: text, authority: 'spec.cross_field' };
}

function probeStateOf(descriptor, { home, exists, unsafe, profile, env }) {
  // No session source is declared: a probe over session files is meaningless even when the
  // descriptor carries a structural `probe` for the home itself.
  if (descriptor.sessions.kind === 'none') return { state: 'not_applicable', reason: null };
  const declared = Boolean(descriptor.probe?.anyOf?.length);
  if (!declared) return { state: 'not_declared', reason: null };
  if (unsafe) return { state: 'rejected', reason: 'Home resolves to the filesystem or profile root, not an Agent home' };
  if (!home || !exists) return { state: 'unavailable', reason: 'No Agent home exists to probe' };
  const result = probeDescriptor(descriptor, home, { profile, env });
  return result.valid ? { state: 'passed', reason: null } : { state: 'failed', reason: result.reason ?? 'The declared probe did not match the home' };
}

// Derived from the extractor `kind`; never from a new descriptor field. The truth is already in the
// declaration the reader is about to execute.
function timestampSourceOf(extractor) {
  if (extractor?.kind === 'record') return 'native';
  if (extractor?.kind === 'mtime') return 'file-write-time';
  return 'derived';
}

function workspaceSourceOf(extractor) {
  if (extractor?.kind === 'record') return 'native';
  if (extractor?.kind === 'scanAbsolutePaths') return 'recovered';
  return 'derived';
}

function wiringFor(name, descriptor) {
  if (name === 'sessions') return descriptor.sessions.kind;
  if (name === 'executionStatus') return descriptor.executionStatus?.kind ?? 'none';
  if (name === 'handoff') return descriptor.handoff.kind;
  if (name === 'attentionStatus') return 'none';
  return descriptor.resources.kind;
}

// The anti-blind-trust rule (§3.4): a capability is never `verified` because the descriptor says
// `true`; it is verified only when the sample observed it.
function deriveCapabilities(descriptor, { sessions, sourceReachable }) {
  const table = [];
  for (const name of AGENT_CAPABILITIES) {
    const declared = descriptor.capabilities[name] === true;
    const entry = { name, declared, wiring: wiringFor(name, descriptor), status: 'unsupported', origin: null, evidence: [] };
    // `sessions.kind: "none"` means the descriptor declares no session source at all. That is not a
    // gap in the sample and not an unreachable source — there is no reader by declaration — so the
    // capability is unsupported regardless of the declared flag, which a hand-authored descriptor
    // may still carry.
    if (name === 'sessions' && descriptor.sessions.kind === 'none') {
      entry.origin = 'session_source_not_declared';
      table.push(entry);
      continue;
    }
    if (!declared) {
      entry.origin = name === 'attentionStatus' ? 'no_reader'
        : name === 'sessions' ? 'declared_false'
          : 'catalogue_boundary';
      table.push(entry);
      continue;
    }
    if (!sourceReachable) {
      entry.status = 'unavailable';
      entry.origin = 'source_unreachable';
      entry.evidence = [{ source: 'adapter', detail: 'no source reachable' }];
      table.push(entry);
      continue;
    }
    if (name === 'sessions') {
      if (descriptor.sessions.kind === 'transcript' && sessions.observed >= 1) {
        entry.status = 'verified';
        entry.evidence = [{ source: 'adapter', detail: 'readSessionSnapshots ok', count: sessions.observed }];
      } else if (descriptor.sessions.kind === 'builtin') {
        entry.status = 'unavailable';
        entry.origin = 'not_exercised_by_verify';
      } else {
        entry.status = 'unavailable';
        entry.origin = 'not_observed_in_sample';
      }
    } else if (name === 'executionStatus') {
      if (descriptor.executionStatus?.kind === 'builtin') {
        entry.status = 'unavailable';
        entry.origin = 'not_exercised_by_verify';
      } else {
        const values = [...new Set(sessions.sample.map((row) => row.executionStatus).filter((value) => value && value !== 'unknown'))];
        if (values.length) {
          entry.status = 'verified';
          entry.evidence = [{ source: 'transcript', detail: `observed ${values.join(', ')}` }];
        } else {
          entry.status = 'unavailable';
          entry.origin = 'not_observed_in_sample';
        }
      }
    } else if (name === 'handoff') {
      entry.status = 'unavailable';
      entry.origin = 'write_path';
    } else {
      // resource family + attentionStatus: observable only behind credentials/network or not
      // implemented at all, and B-2 forbids verify from exercising them.
      entry.status = 'unavailable';
      entry.origin = 'not_exercised_by_verify';
    }
    table.push(entry);
  }
  return table;
}

function invariantFailuresFor(sessions) {
  const failures = [];
  for (const session of sessions) {
    const id = session.nativeSessionId ?? null;
    if (!nonEmpty(id)) failures.push({ nativeSessionId: id, invariant: 'native_session_id_present' });
    if (!Number.isFinite(Date.parse(session.createdAt))) failures.push({ nativeSessionId: id, invariant: 'created_at_parseable' });
    if (!Number.isFinite(Date.parse(session.updatedAt))) failures.push({ nativeSessionId: id, invariant: 'updated_at_parseable' });
    if (!nonEmpty(session.workspaceKey) || !nonEmpty(session.workspaceName)) failures.push({ nativeSessionId: id, invariant: 'workspace_resolved' });
  }
  return failures;
}

const INSTALLATION_LABEL = Object.freeze({
  installed_match: 'installed (matches input)',
  installed_mismatch: 'installed (differs from input)',
  not_installed: 'not installed',
});

function stageDetail(stage, result) {
  const name = stage.stage;
  if (name === 'load') return result.input?.path ?? '(stdin)';
  if (name === 'descriptor') return stage.status === 'passed' ? 'legal and satisfiable' : '';
  if (name === 'installation') return result.installation?.state ?? 'not reached';
  if (name === 'source') {
    if (stage.status !== 'passed') return stage.errors?.join('; ') ?? '';
    const source = result.source ?? {};
    return `${source.origin ?? '?'} \u2192 ${source.path ?? '?'}   probe ${source.probe?.state ?? '?'}   ${source.candidates?.length ?? 0} candidates`;
  }
  if (name === 'projection') {
    if (stage.status !== 'passed') return stage.errors?.join('; ') ?? '';
    const sessions = result.sessions ?? {};
    const revision = sessions.revision ? `, revision ${String(sessions.revision).slice(0, 8)}` : '';
    return `${sessions.observed ?? 0} sessions observed, ${sessions.checked ?? 0} checked${revision}`;
  }
  return '';
}

// Human-readable, staged output. It never claims more than the result document records.
export function formatVerifyResult(result) {
  const input = result.input ?? {};
  const lines = [];
  lines.push(`verify  ${input.type ?? '?'}  (${input.label ?? '?'})  specVersion ${input.specVersion ?? '?'}`);
  lines.push(`input   ${input.path ?? '(stdin)'}  sha256 ${input.sha256 ? String(input.sha256).slice(0, 8) : '-'}  (${INSTALLATION_LABEL[result.installation?.state] ?? 'not reached'})`);
  lines.push(`verdict ${result.verdict}`);
  if (result.reasonCode) lines.push(`reason  ${result.reasonCode}`);
  lines.push('');
  for (const stage of result.stages ?? []) {
    const detail = stageDetail(stage, result);
    lines.push(`  ${String(stage.stage).padEnd(14)}${String(stage.status).padEnd(9)}${detail}`);
  }
  if (result.capabilities?.length) {
    lines.push('');
    lines.push('capabilities');
    for (const capability of result.capabilities) {
      const note = capability.status === 'verified'
        ? (capability.evidence?.[0]?.detail ?? '')
        : (capability.origin ?? '');
      lines.push(`  ${capability.name.padEnd(20)}${String(capability.status).padEnd(13)}${note}`);
    }
  }
  if (result.refusals?.length) {
    lines.push('');
    lines.push('refusals');
    for (const refusal of result.refusals) lines.push(`  ${refusal.authority}  ${refusal.code}  ${refusal.reason}`);
  }
  if (result.verdict === 'no_sessions') {
    lines.push('');
    lines.push('diagnosis  the home exists and the probe passed, but the reader published nothing.');
    lines.push('           This is consistent with "no sessions yet" and with "every candidate was"');
    lines.push('           dropped; verify cannot distinguish them (no drop reasons are produced).');
  }
  if (result.reasonCode === 'session_source_not_declared') {
    lines.push('');
    lines.push('diagnosis  the descriptor declares no session source (sessions.kind is "none").');
    lines.push('           There is no session reader by declaration — this is not "no sessions"');
    lines.push('           and not a missing home; there is no session surface for verify to observe.');
  }
  if (result.evidenceSources?.length) {
    lines.push('');
    lines.push(`evidence  ${[...new Set(result.evidenceSources.map((entry) => entry.kind))].join(', ')}`);
  }
  for (const note of result.notes ?? []) lines.push(`note  ${note.code}${note.message ? `: ${note.message}` : ''}`);
  return lines.join('\n');
}

/**
 * Verify one descriptor against this machine. Pure observation: no writes, no cache, no network,
 * no credential read, no Agent launch.
 *
 * `descriptor` is the parsed object; `input` carries the S0 facts ({kind, path, sha256}).
 */
export async function verifyAgentDescriptor({
  descriptor,
  input = null,
  path: explicitPath = null,
  env = process.env,
  homedir = os.homedir(),
  sample = DEFAULT_SAMPLE,
  generatedAt = new Date().toISOString(),
} = {}) {
  const result = baseResult({ input, generatedAt, descriptor });
  const sampleLimit = Math.max(1, Math.min(MAX_SAMPLE, Number.isFinite(Number(sample)) ? Math.floor(Number(sample)) : DEFAULT_SAMPLE));
  const profile = profileOf({ env, homedir });
  const options = { env, homedir };
  const stage = (name, status, errors = []) => result.stages.push({ stage: name, status, errors });

  // ---- S1: descriptor legality -------------------------------------------------------------
  const validation = validateDescriptor(descriptor);
  stage('load', 'passed');
  if (!validation.ok) {
    stage('descriptor', 'failed', validation.errors);
    result.refusals = validation.errors.map(classifyValidationError);
    result.verdict = 'rejected';
    result.reasonCode = result.refusals[0]?.code ?? 'invalid_descriptor';
    return result;
  }
  const normalized = normalizeDescriptor(descriptor);

  // The installation dry-run is reused for its authority over validation + the builtin guard, and
  // for nothing else. `register: false` keeps it from touching the source registry; the source is
  // resolved and probed fresh below (P-3). Its synthetic explicit-path candidate is never consulted.
  let install;
  try {
    install = installAgentDescriptor({ descriptor, path: null, env, homedir, register: false, dryRun: true });
  } catch (error) {
    stage('descriptor', 'failed', [error?.message ?? 'unable to read the installation state']);
    result.notes.push({ code: error?.code ?? 'installation_read_failed', message: error?.message ?? 'unable to read the installation state' });
    result.verdict = 'unavailable';
    result.reasonCode = error?.code ?? 'installation_read_failed';
    return result;
  }
  if (!install.ok) {
    stage('descriptor', 'failed', [install.error?.message ?? install.error?.code ?? 'descriptor refused']);
    result.refusals.push({
      code: install.error?.code ?? 'invalid_descriptor',
      path: 'type',
      declared: normalized.type,
      reason: install.error?.message ?? `descriptor refused: ${install.error?.code}`,
      authority: 'install.builtin_guard',
    });
    result.verdict = 'rejected';
    result.reasonCode = install.error?.code ?? 'invalid_descriptor';
    return result;
  }

  const problems = compositionProblems(normalized, { hasBuiltinAdapter: hasBuiltinAdapter(normalized.type) });
  if (problems.length) {
    stage('descriptor', 'failed', problems);
    result.refusals.push({ code: 'descriptor_adapter_missing', path: 'sessions.kind', declared: normalized.sessions.kind, reason: problems.join('; '), authority: 'compose.wiring' });
    result.verdict = 'rejected';
    result.reasonCode = 'descriptor_adapter_missing';
    return result;
  }
  stage('descriptor', 'passed');

  // ---- S2: installation (informational, never a verdict on its own) -------------------------
  const installedFile = findDescriptorFile(normalized.type, options);
  const installation = {
    state: 'not_installed',
    descriptorPath: installedFile,
    descriptorSha256: null,
    descriptorDigest: descriptorDigest(normalized),
    source: null,
  };
  if (installedFile) {
    try {
      const bytes = fs.readFileSync(installedFile);
      installation.descriptorSha256 = sha256(bytes);
      const installedRaw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      installation.state = descriptorDigest(installedRaw) === installation.descriptorDigest ? 'installed_match' : 'installed_mismatch';
    } catch {
      installation.state = 'installed_mismatch';
    }
  }

  const registry = readAgentSourceRegistry(options);
  if (registry.ok === false) result.notes.push({ code: 'registry_unreadable', message: registry.error?.message ?? 'unable to read the agent source registry' });
  const registeredSource = registry.ok ? resolveActiveSource(registry, normalized.type, options) : null;
  const typeRecord = registry.ok ? registry.sources.find((source) => source.type === normalized.type) ?? null : null;
  installation.source = registeredSource
    ? { sourceId: registeredSource.sourceId, path: registeredSource.path, enabled: registeredSource.enabled, suppressed: registeredSource.suppressed === true, registryOrigin: registeredSource.origin }
    : null;
  result.installation = installation;
  stage('installation', 'passed');

  // ---- S2.5: declared session source? ------------------------------------------------------
  // `sessions.kind: "none"` means the descriptor itself declares that this Agent exposes no session
  // source. That sentence must never be rendered as `no_sessions` ("the reader ran and published
  // nothing"): no reader exists, by declaration, whether or not a home is present on this machine.
  // It is an availability boundary on the declared surface, not a descriptor fault, so it is not a
  // rejection and no home is walked on its behalf.
  if (normalized.sessions.kind === 'none') {
    if (input?.sha256) result.evidenceSources.push({ kind: 'manifest', path: input.path ?? null, sha256: input.sha256 });
    result.evidenceSources.push({ kind: 'registry', path: registryPath(options) });
    result.source = {
      origin: null,
      path: null,
      unsafe: false,
      validate: { valid: false, reason: 'No session source is declared for this descriptor (sessions.kind is "none")' },
      probe: { state: 'not_applicable', reason: null },
      candidates: [],
    };
    result.notes.push({ code: 'session_source_not_declared', message: 'The descriptor declares no session source (sessions.kind is "none"); there is no session surface for verify to read' });
    stage('source', 'skipped', ['session_source_not_declared']);
    stage('projection', 'skipped');
    result.verdict = 'unavailable';
    result.reasonCode = 'session_source_not_declared';
    result.capabilities = deriveCapabilities(normalized, { sessions: { observed: 0, sample: [] }, sourceReachable: false });
    return result;
  }

  // ---- S3: source availability (fresh, independent of the dry-run) --------------------------
  const resolution = resolveAgentHome(normalized, { env, homedir, profile });
  const candidates = resolution.candidates.map((candidate) => ({
    env: candidate.env,
    path: candidate.path,
    exists: candidate.exists,
    unsafe: candidate.unsafe,
    probe: { valid: candidate.probe.valid, reason: candidate.probe.reason },
  }));

  let chosenPath = null;
  let origin = null;
  if (nonEmpty(explicitPath)) {
    chosenPath = path.resolve(explicitPath);
    origin = 'explicit';
  } else if (registeredSource) {
    chosenPath = registeredSource.path;
    origin = 'registry';
  } else if (resolution.resolved) {
    chosenPath = resolution.resolved.path;
    origin = 'resolved';
  }

  const chosenUnsafe = Boolean(chosenPath) && isUnsafeIntegrationRoot(chosenPath, profile);
  const chosenValidation = chosenPath ? validateSource({ path: chosenPath }) : { valid: false, reason: 'No Agent home was resolved on this machine' };
  const probe = probeStateOf(normalized, { home: chosenPath, exists: chosenValidation.valid, unsafe: chosenUnsafe, profile, env });

  result.source = {
    origin,
    path: chosenPath,
    unsafe: chosenUnsafe,
    validate: { valid: chosenValidation.valid, reason: chosenValidation.reason },
    probe: { state: probe.state, reason: probe.reason },
    candidates,
  };
  if (input?.sha256) result.evidenceSources.push({ kind: 'manifest', path: input.path ?? null, sha256: input.sha256 });
  result.evidenceSources.push({ kind: 'registry', path: registryPath(options) });
  if (chosenPath) result.evidenceSources.push({ kind: 'filesystem', path: chosenPath, detail: normalized.sessions.kind === 'transcript' ? `read scope: ${normalized.sessions.roots.join(', ')}` : 'session reader' });
  if (normalized.probe?.anyOf?.length) result.evidenceSources.push({ kind: 'probe', detail: normalized.probe.anyOf.map((candidate) => candidate.glob).join(', ') });

  const disabledSource = Boolean(typeRecord) && !registeredSource;
  let sourceFailure = null;
  if (chosenUnsafe) {
    sourceFailure = { verdict: 'rejected', reasonCode: 'unsafe_integration_root', refusal: { code: 'unsafe_integration_root', path: 'source.path', declared: chosenPath, reason: 'The resolved home is the filesystem or profile root, not an Agent home', authority: 'readers.containment' } };
  } else if (!nonEmpty(explicitPath) && disabledSource) {
    sourceFailure = { verdict: 'unavailable', reasonCode: 'source_disabled', note: { code: 'source_disabled', message: `A ${normalized.type} source is registered but disabled or removed` } };
  } else if (!chosenPath) {
    sourceFailure = { verdict: 'unavailable', reasonCode: 'no_home_found', note: { code: 'no_home_found', message: 'No Agent home was resolved on this machine' } };
  } else if (!chosenValidation.valid) {
    sourceFailure = { verdict: 'unavailable', reasonCode: 'source_unavailable', note: { code: 'source_unavailable', message: chosenValidation.reason ?? 'The Agent home is not readable' } };
  } else if (probe.state === 'failed') {
    sourceFailure = { verdict: 'rejected', reasonCode: 'probe_mismatch', refusal: { code: 'probe_mismatch', path: 'probe', declared: true, reason: probe.reason ?? 'The declared probe did not match the resolved home', authority: 'readers.probe' } };
  }

  if (sourceFailure) {
    const errors = sourceFailure.note ? [sourceFailure.note.code] : sourceFailure.refusal ? [sourceFailure.refusal.code] : [];
    stage('source', sourceFailure.verdict === 'rejected' ? 'failed' : 'skipped', errors);
    stage('projection', 'skipped');
    result.verdict = sourceFailure.verdict;
    result.reasonCode = sourceFailure.reasonCode;
    if (sourceFailure.refusal) result.refusals.push(sourceFailure.refusal);
    if (sourceFailure.note) result.notes.push(sourceFailure.note);
    result.capabilities = deriveCapabilities(normalized, { sessions: { observed: 0, sample: [] }, sourceReachable: false });
    return result;
  }
  stage('source', 'passed');

  // ---- S4: projection through the host's own adapter ---------------------------------------
  let adapter = null;
  try {
    adapter = (installation.state === 'installed_match' ? adapterFor(normalized.type, options) : null)
      ?? composeAdapter(normalized, { builtinAdapter: null, detect: detectAgentSources, validateSource, profile, env });
  } catch (error) {
    stage('projection', 'failed', [error?.message ?? 'unable to compose a reader']);
    result.refusals.push({ code: error?.code ?? 'descriptor_composition_failed', path: 'sessions.kind', declared: normalized.sessions.kind, reason: error?.message ?? 'unable to compose a reader', authority: 'compose.wiring' });
    result.verdict = 'rejected';
    result.reasonCode = error?.code ?? 'descriptor_composition_failed';
    result.capabilities = deriveCapabilities(normalized, { sessions: { observed: 0, sample: [] }, sourceReachable: true });
    return result;
  }

  const readSource = {
    type: normalized.type,
    agentType: normalized.type,
    sourceId: registeredSource?.sourceId ?? null,
    id: registeredSource?.sourceId ?? null,
    path: chosenPath,
    enabled: true,
  };

  let envelope;
  try { envelope = await adapter.readSessionSnapshots(readSource, { env }); }
  catch (error) { envelope = { ok: false, error: { code: error?.code ?? 'source_read_failed', message: error?.message } }; }

  if (!envelope.ok) {
    const code = envelope.error?.code ?? 'source_read_failed';
    stage('projection', 'failed', [envelope.error?.message ?? code]);
    if (code === 'session_root_outside_home') {
      // P-1: the safety rejection survives the envelope and is classified as rejected, never as an
      // ordinary read failure.
      result.refusals.push({ code: 'session_root_outside_home', path: 'sessions.roots', declared: normalized.sessions.roots, reason: envelope.error?.message ?? 'A session root resolved outside its home', authority: 'readers.containment' });
      result.verdict = 'rejected';
      result.reasonCode = 'session_root_outside_home';
    } else {
      result.notes.push({ code, message: envelope.error?.message ?? 'The Agent source could not be read' });
      result.verdict = 'unavailable';
      result.reasonCode = code;
    }
    result.capabilities = deriveCapabilities(normalized, { sessions: { observed: 0, sample: [] }, sourceReachable: result.verdict === 'rejected' });
    return result;
  }

  const snapshots = Array.isArray(envelope.snapshots) ? envelope.snapshots : [];
  const observed = snapshots.length;
  const checkedSessions = snapshots.slice(0, Math.min(observed, sampleLimit));
  const invariantFailures = invariantFailuresFor(checkedSessions);

  let revision = null;
  if (registeredSource) {
    try { revision = await adapter.getSessionRevision(readSource, { env }); }
    catch { revision = null; }
  } else {
    result.notes.push({ code: 'no_registered_source', message: 'no registered source, so Margin canonical ids and revision are omitted' });
  }

  const timestampSource = timestampSourceOf(normalized.sessions.createdAt);
  const workspaceSource = workspaceSourceOf(normalized.sessions.workspace);
  const sampleRows = checkedSessions.map((session) => ({
    nativeSessionId: session.nativeSessionId ?? null,
    canonicalId: registeredSource ? session.canonicalId ?? null : null,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
    timestampSource,
    workspaceSource,
    workspace: { key: session.workspaceKey ?? null, name: session.workspaceName ?? null },
    executionStatus: session.executionStatus ?? 'unknown',
    titlePresent: nonEmpty(session.titleSource) && session.titleSource !== 'fallback-id',
    evidence: session.originalPath ? [{ source: 'transcript', detail: session.originalPath }] : [],
  }));

  result.sessions = {
    observed,
    checked: checkedSessions.length,
    revision,
    invariantFailures,
    sample: sampleRows,
    evidence: [{ source: 'adapter', detail: 'readSessionSnapshots ok', count: observed }],
  };
  const transcriptPaths = new Set();
  for (const session of checkedSessions) {
    if (session.originalPath && !transcriptPaths.has(session.originalPath)) {
      transcriptPaths.add(session.originalPath);
      result.evidenceSources.push({ kind: 'transcript', path: session.originalPath });
    }
  }

  if (invariantFailures.length) {
    stage('projection', 'failed', invariantFailures.map((failure) => `${failure.nativeSessionId ?? 'unknown'}: ${failure.invariant}`));
    result.refusals.push({ code: 'invariant_failure', path: 'sessions', declared: observed, reason: `published session(s) failed projection invariants: ${invariantFailures.map((failure) => failure.invariant).join(', ')}`, authority: 'verify.invariants' });
    result.verdict = 'rejected';
    result.reasonCode = 'invariant_failure';
  } else if (observed >= 1) {
    stage('projection', 'passed');
    result.verdict = 'verified';
    result.reasonCode = null;
  } else {
    stage('projection', 'passed');
    result.verdict = 'no_sessions';
    result.reasonCode = 'reader_returned_empty';
  }

  result.capabilities = deriveCapabilities(normalized, { sessions: result.sessions, sourceReachable: true });
  return result;
}
