// Agent Descriptor Spec — the onboarding interface for an Agent that Margin does not ship.
//
// A descriptor is DATA, never code. Margin validates it against this closed spec and composes an
// adapter from a fixed catalogue of readers (see readers.js). Nothing in a descriptor is evaluated
// as an expression, and a descriptor cannot introduce behaviour outside the catalogue. That is the
// deliberate limit which keeps a user-supplied JSON file from becoming an execution surface inside
// the Margin process.
//
// What the spec can express: where an Agent keeps its sessions, how to read one session's identity
// out of that layout, and whether an existing built-in adapter owns its session/resource reading.
//
// What it cannot express — and must therefore be reported, never silently degraded:
//   * handoff evidence. The shared Handoff Core consumes Codex-shaped records, and Pi/Claude each
//     bring their own extraction layer. There is no declarative form for "how to distil this
//     Agent's transcript", so handoff is only available when a built-in implementation is named.
//   * credential-bearing resource reads, opaque/encrypted stores, request signing. These stay
//     built-in readers; a descriptor at most references one.
//
// Reserved keys: `$comment` may appear at any level and is always ignored.

export const DESCRIPTOR_SPEC_VERSION = 1;

// Mirrors sourceRegistry.AGENT_CAPABILITIES. Duplicated here so the spec stays independently
// testable and a capability typo is a validation error rather than a silently ignored key.
export const DESCRIPTOR_CAPABILITIES = Object.freeze([
  'sessions', 'handoff', 'apiUsage', 'quota', 'executionStatus', 'attentionStatus', 'subscriptionQuota',
]);

export const SESSION_KINDS = Object.freeze(['builtin', 'transcript', 'none']);
export const RESOURCE_KINDS = Object.freeze(['builtin', 'none']);
export const HANDOFF_KINDS = Object.freeze(['none', 'builtin', 'shared-codex']);
export const TRANSCRIPT_FORMATS = Object.freeze(['jsonl']);
export const SESSION_LAYOUTS = Object.freeze(['directory-per-session', 'file-per-session']);
export const TITLE_AS = Object.freeze(['native', 'metadata', 'first-user-message']);

const TYPE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const EXTRACTOR_KINDS = Object.freeze(['directoryName', 'filename', 'mtime', 'record', 'scanAbsolutePaths']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function checkTemplateString(value, label, errors) {
  if (!nonEmptyString(value)) { errors.push(`${label} must be a non-empty string`); return; }
  // Only two substitutions exist, and an unknown one is a configuration error rather than an
  // empty path at read time.
  for (const token of value.match(/\{[a-zA-Z]+\}|%ENV:[A-Z0-9_]+%/g) ?? []) {
    const valid = token === '{home}' || token === '{profile}' || token.startsWith('%ENV:');
    if (!valid) errors.push(`${label} uses unknown substitution ${token}`);
  }
}

function checkExtractor(value, label, errors, { allowNull = false } = {}) {
  if (value === undefined || value === null) {
    if (!allowNull) errors.push(`${label} is required`);
    return;
  }
  if (!isPlainObject(value)) { errors.push(`${label} must be an object`); return; }
  const kind = value.kind;
  if (!EXTRACTOR_KINDS.includes(kind)) { errors.push(`${label}.kind must be one of ${EXTRACTOR_KINDS.join(', ')}`); return; }
  if (kind === 'mtime') {
    if (!nonEmptyString(value.glob)) errors.push(`${label}.glob is required for an mtime extractor`);
    if (value.pick !== undefined && value.pick !== 'max' && value.pick !== 'min') errors.push(`${label}.pick must be max or min`);
    return;
  }
  if (kind === 'record') {
    if (value.where !== undefined) {
      if (!isPlainObject(value.where)) errors.push(`${label}.where must be an object of literal equalities`);
      else for (const [key, expected] of Object.entries(value.where)) {
        // Equality against a literal only. No operators, no nesting, no regex.
        if (!key.trim()) errors.push(`${label}.where has an empty key`);
        if (expected !== null && typeof expected !== 'string' && typeof expected !== 'number' && typeof expected !== 'boolean') {
          errors.push(`${label}.where.${key} must be a string, number, boolean, or null literal`);
        }
      }
    }
    // `last` is a real need ("the model the session ended on"), not a synonym for a large integer:
    // an empty intervening record must not shift the answer to the wrong end.
    if (value.index !== undefined && value.index !== 'last' && (!Number.isInteger(value.index) || value.index < 0)) {
      errors.push(`${label}.index must be a non-negative integer or "last"`);
    }
    if (value.path !== undefined && !nonEmptyString(value.path)) errors.push(`${label}.path must be a non-empty dotted path`);
    if (value.maxLength !== undefined && (!Number.isInteger(value.maxLength) || value.maxLength < 1)) errors.push(`${label}.maxLength must be a positive integer`);
    return;
  }
  if (kind === 'scanAbsolutePaths') {
    // The only parameter is a documented normalisation: a transcript that records FILES cannot name
    // a workspace, so the descriptor says whether to take the containing directory. There is
    // deliberately no pattern, filter, or priority list here — an Agent whose transcript needs those
    // needs a built-in adapter, not a more powerful DSL.
    if (value.parentOf !== undefined && typeof value.parentOf !== 'boolean') errors.push(`${label}.parentOf must be a boolean`);
    // A literal marker, not a pattern: "prefer the candidate that contains this entry".
    if (value.requireMarker !== undefined && value.requireMarker !== null && !nonEmptyString(value.requireMarker)) errors.push(`${label}.requireMarker must be a non-empty string when present`);
    for (const key of Object.keys(value)) {
      if (key === 'kind' || key === 'parentOf' || key === 'requireMarker' || key === '$comment') continue;
      errors.push(`${label}.${key} is not valid for a scanAbsolutePaths extractor`);
    }
    return;
  }
  // directoryName / filename carry no parameters.
  for (const key of Object.keys(value)) {
    if (key === 'kind' || key === '$comment') continue;
    errors.push(`${label}.${key} is not valid for a ${kind} extractor`);
  }
}

function checkSessions(value, errors) {
  if (!isPlainObject(value)) { errors.push('sessions must be an object'); return; }
  if (!SESSION_KINDS.includes(value.kind)) { errors.push(`sessions.kind must be one of ${SESSION_KINDS.join(', ')}`); return; }
  if (value.kind !== 'transcript') return;

  if (!Array.isArray(value.roots) || value.roots.length === 0) errors.push('sessions.roots must be a non-empty array');
  else value.roots.forEach((root, index) => checkTemplateString(root, `sessions.roots[${index}]`, errors));

  if (value.layout !== undefined && !SESSION_LAYOUTS.includes(value.layout)) {
    errors.push(`sessions.layout must be one of ${SESSION_LAYOUTS.join(', ')}`);
  }
  if (!isPlainObject(value.transcript)) errors.push('sessions.transcript is required');
  else {
    if (!nonEmptyString(value.transcript.glob)) errors.push('sessions.transcript.glob is required');
    if (!TRANSCRIPT_FORMATS.includes(value.transcript.format)) errors.push(`sessions.transcript.format must be one of ${TRANSCRIPT_FORMATS.join(', ')}`);
  }
  // id, createdAt and updatedAt are the minimum needed to publish a session at all; the rest are
  // presentation. Requiring them here is what turns "registered but reads nothing" into a
  // configuration error instead of an empty Board with no explanation.
  checkExtractor(value.id, 'sessions.id', errors);
  checkExtractor(value.createdAt, 'sessions.createdAt', errors);
  checkExtractor(value.updatedAt, 'sessions.updatedAt', errors);
  checkExtractor(value.workspace, 'sessions.workspace', errors, { allowNull: true });
  checkExtractor(value.title, 'sessions.title', errors, { allowNull: true });
  if (value.title?.as !== undefined && !TITLE_AS.includes(value.title.as)) {
    errors.push(`sessions.title.as must be one of ${TITLE_AS.join(', ')}`);
  }
  checkExtractor(value.model, 'sessions.model', errors, { allowNull: true });
  checkExtractor(value.provider, 'sessions.provider', errors, { allowNull: true });
}

export function validateDescriptor(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ['descriptor must be an object'] };

  if (value.specVersion !== DESCRIPTOR_SPEC_VERSION) {
    errors.push(`specVersion must be ${DESCRIPTOR_SPEC_VERSION}`);
  }
  if (!nonEmptyString(value.type) || !TYPE_PATTERN.test(value.type)) {
    errors.push('type must match [a-z][a-z0-9_-]{1,31}');
  }
  if (!nonEmptyString(value.label)) errors.push('label must be a non-empty string');
  if (value.provider !== undefined && value.provider !== null && !nonEmptyString(value.provider)) errors.push('provider must be a non-empty string when present');
  if (value.resourceAgent !== undefined && !nonEmptyString(value.resourceAgent)) errors.push('resourceAgent must be a non-empty string when present');
  if (value.defaultSourceName !== undefined && !nonEmptyString(value.defaultSourceName)) errors.push('defaultSourceName must be a non-empty string when present');
  // Presentation, not capability. It lives in the descriptor because the alternative is a branch in
  // the resource bar, which is exactly how a new Agent used to need a UI edit to look right.
  if (value.quotaPrefix !== undefined && value.quotaPrefix !== null && !nonEmptyString(value.quotaPrefix)) errors.push('quotaPrefix must be a non-empty string when present');
  if (value.envHome !== undefined && !nonEmptyString(value.envHome)) errors.push('envHome must be a non-empty string when present');
  if (value.order !== undefined && !Number.isFinite(value.order)) errors.push('order must be a number when present');

  if (value.defaultHome !== undefined) {
    if (!isPlainObject(value.defaultHome)) errors.push('defaultHome must be an object');
    else {
      if (value.defaultHome.env !== undefined && !nonEmptyString(value.defaultHome.env)) errors.push('defaultHome.env must be a non-empty string when present');
      checkTemplateString(value.defaultHome.fallback, 'defaultHome.fallback', errors);
    }
  }

  // An Agent does not live in one place on every machine. An ordered candidate list is what lets a
  // descriptor adapt itself during install instead of shipping a path that only fits its author.
  if (value.homeCandidates !== undefined) {
    if (!Array.isArray(value.homeCandidates) || value.homeCandidates.length === 0) errors.push('homeCandidates must be a non-empty array');
    else value.homeCandidates.forEach((candidate, index) => {
      if (!isPlainObject(candidate)) { errors.push(`homeCandidates[${index}] must be an object`); return; }
      if (candidate.env !== undefined && !nonEmptyString(candidate.env)) errors.push(`homeCandidates[${index}].env must be a non-empty string when present`);
      checkTemplateString(candidate.fallback, `homeCandidates[${index}].fallback`, errors);
    });
  }

  if (value.capabilities !== undefined) {
    if (!isPlainObject(value.capabilities)) errors.push('capabilities must be an object');
    else for (const [key, enabled] of Object.entries(value.capabilities)) {
      if (key === '$comment') continue;
      if (!DESCRIPTOR_CAPABILITIES.includes(key)) errors.push(`capabilities.${key} is not a known capability`);
      else if (typeof enabled !== 'boolean') errors.push(`capabilities.${key} must be a boolean`);
    }
  }

  // Session-level capabilities are a genuinely separate surface from source-level ones in the
  // existing design: a source can be "not yet verified for handoff" while an individual session DTO
  // still advertises the operation. Today they differ for Claude. Encoding that here preserves the
  // behaviour exactly instead of quietly collapsing two surfaces into one.
  if (value.sessionCapabilities !== undefined) {
    if (!isPlainObject(value.sessionCapabilities)) errors.push('sessionCapabilities must be an object');
    else for (const [key, enabled] of Object.entries(value.sessionCapabilities)) {
      if (key === '$comment') continue;
      if (!DESCRIPTOR_CAPABILITIES.includes(key)) errors.push(`sessionCapabilities.${key} is not a known capability`);
      else if (typeof enabled !== 'boolean') errors.push(`sessionCapabilities.${key} must be a boolean`);
    }
  }

  checkSessions(value.sessions, errors);

  if (value.probe !== undefined) {
    if (!isPlainObject(value.probe)) errors.push('probe must be an object');
    else if (!Array.isArray(value.probe.anyOf) || value.probe.anyOf.length === 0) errors.push('probe.anyOf must be a non-empty array');
    else value.probe.anyOf.forEach((candidate, index) => {
      if (!isPlainObject(candidate)) { errors.push(`probe.anyOf[${index}] must be an object`); return; }
      checkTemplateString(candidate.glob, `probe.anyOf[${index}].glob`, errors);
    });
  }

  if (value.resources !== undefined) {
    if (!isPlainObject(value.resources)) errors.push('resources must be an object');
    else if (!RESOURCE_KINDS.includes(value.resources.kind)) errors.push(`resources.kind must be one of ${RESOURCE_KINDS.join(', ')}`);
  }

  if (value.handoff !== undefined) {
    if (!isPlainObject(value.handoff)) errors.push('handoff must be an object');
    else if (!HANDOFF_KINDS.includes(value.handoff.kind)) errors.push(`handoff.kind must be one of ${HANDOFF_KINDS.join(', ')}`);
  }

  // Cross-field consistency. A descriptor that claims a capability its declared wiring cannot
  // deliver is the exact failure this spec exists to prevent, so it is an error here rather than a
  // Codex-shaped fallback at request time.
  const capabilities = value.capabilities ?? {};
  const handoffKind = value.handoff?.kind ?? 'none';
  const sessionKind = value.sessions?.kind;
  if (capabilities.handoff === true && handoffKind === 'none') {
    errors.push('capabilities.handoff is true but handoff.kind is none');
  }
  if (handoffKind === 'shared-codex' && sessionKind !== 'builtin') {
    errors.push('handoff.kind shared-codex requires sessions.kind builtin');
  }
  if (handoffKind === 'builtin' && sessionKind !== 'builtin') {
    errors.push('handoff.kind builtin requires sessions.kind builtin');
  }
  // A builtin session/resource reader is named by `type`, so a descriptor can only delegate to an
  // adapter that exists for its own type. Composition verifies the adapter is actually present.
  if (value.resources?.kind === 'builtin' && sessionKind !== 'builtin') {
    errors.push('resources.kind builtin requires sessions.kind builtin');
  }
  if (sessionKind === 'builtin' && capabilities.sessions === false) {
    errors.push('capabilities.sessions cannot be false when sessions.kind is builtin');
  }

  return { ok: errors.length === 0, errors };
}

// Defaults are applied once, here, so every consumer reads the same normalized object and no
// reader has to re-implement "what does a missing capabilities object mean".
export function normalizeDescriptor(value) {
  const handoffKind = value.handoff?.kind ?? 'none';
  // `defaultHome` is the single-candidate shorthand; `homeCandidates` is the ordered list. They are
  // folded into one representation so no consumer has to know which form the author used.
  const homeCandidates = value.homeCandidates?.length
    ? value.homeCandidates
    : (value.defaultHome ? [value.defaultHome] : []);
  const primaryHome = homeCandidates[0] ?? null;
  // Only the capabilities the descriptor actually states are carried through. Filling the absent
  // ones with `false` would look tidier but would change the shape of the registry DTO for existing
  // Agents (Pi is the only one that declares `subscriptionQuota`), and the session DTO already
  // defaults every unstated capability to false.
  const capabilities = {};
  for (const [name, enabled] of Object.entries(value.capabilities ?? {})) {
    if (name === '$comment' || !DESCRIPTOR_CAPABILITIES.includes(name)) continue;
    capabilities[name] = enabled === true;
  }

  return Object.freeze({
    specVersion: DESCRIPTOR_SPEC_VERSION,
    type: value.type,
    order: Number.isFinite(value.order) ? value.order : 1000,
    label: value.label,
    provider: value.provider ?? null,
    resourceAgent: value.resourceAgent ?? value.type,
    quotaPrefix: value.quotaPrefix ?? null,
    defaultSourceName: value.defaultSourceName ?? value.label,
    envHome: value.envHome ?? null,
    // The home environment variable is declared once (`envHome`) and reused as the default-home
    // override. Declaring it in both places is exactly the kind of duplication that drifts.
    defaultHome: primaryHome
      ? { env: primaryHome.env ?? null, fallback: primaryHome.fallback }
      : null,
    homeCandidates: Object.freeze(homeCandidates.map((candidate) => Object.freeze({
      env: candidate.env ?? value.envHome ?? null,
      fallback: candidate.fallback,
    }))),
    supportLevel: value.supportLevel ?? 'Registered · Adapter required',
    capabilities: Object.freeze(capabilities),
    sessionCapabilities: Object.freeze({ ...(value.sessionCapabilities ?? {}) }),
    sessions: value.sessions.kind === 'transcript'
      ? Object.freeze({
        ...value.sessions,
        layout: value.sessions.layout ?? 'directory-per-session',
        title: value.sessions.title ? Object.freeze({ ...value.sessions.title, as: value.sessions.title.as ?? 'first-user-message' }) : null,
      })
      : Object.freeze({ kind: value.sessions.kind }),
    probe: value.probe ? Object.freeze({ anyOf: Object.freeze(value.probe.anyOf.map((entry) => Object.freeze({ ...entry }))) }) : null,
    resources: Object.freeze({ kind: value.resources?.kind ?? 'none' }),
    handoff: Object.freeze({ kind: handoffKind }),
    source: value.source ?? null,
  });
}

export function descriptorSupportLevel(descriptor) {
  if (!descriptor) return 'Registered · Adapter required';
  return descriptor.supportLevel;
}
