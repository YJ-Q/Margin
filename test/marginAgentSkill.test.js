// Margin Agent Integration Skill — drift protection.
//
// Guards the three shipped skill artifacts (skills/margin-agent-integration/) against drifting away
// from the shipped descriptor contract (src/agents/descriptor/spec.js):
//
//   1. manifest.schema.json top-level keys  == DESCRIPTOR_TOP_LEVEL_KEYS        (exactly)
//   2. manifest schema capability flags     == DESCRIPTOR_CAPABILITIES          (exactly)
//   3. manifest schema closed enums         == the spec's kind/value constants   (exactly)
//   4. manifest schema required keys        == what validateDescriptor requires   (cross-checked)
//   5. the SKILL.md example manifest        validates under BOTH the schema AND validateDescriptor
//      (the "a skill-following manifest validates on the first attempt" promise, M1/R6)
//   6. the SKILL.md example report          validates under report.schema.json
//   7. research-proposed keys (generatedBy / runtime / agent / runtimeControl) are refused by BOTH
//      the schema and the validator (F2/B1 — the drift that cost the OpenCode trial its first
//      validation attempt)
//   8. cross-field wiring rules hold identically in BOTH the schema and the validator
//   9. every shipped descriptor (codex, claude, pi, doubao plugin, nova fixture) still passes BOTH —
//      the skill ships no change to existing descriptors
//
// The test is deliberately dependency-light: it reads the three files from disk and imports only the
// spec constants and ajv (already a dependency). If any side of the contract changes, this file
// fails loudly instead of letting the skill and the validator drift silently.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  DESCRIPTOR_CAPABILITIES,
  DESCRIPTOR_SPEC_VERSION,
  DESCRIPTOR_TOP_LEVEL_KEYS,
  EXECUTION_STATUS_KINDS,
  EXECUTION_STATUS_PICK,
  EXECUTION_STATUS_VALUES,
  HANDOFF_KINDS,
  RESOURCE_KINDS,
  SESSION_KINDS,
  SESSION_LAYOUTS,
  TITLE_AS,
  TRANSCRIPT_FORMATS,
  validateDescriptor,
} from '../src/agents/descriptor/spec.js';
import { builtinDescriptors } from '../src/agents/descriptor/builtin.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const skillDir = new URL('../skills/margin-agent-integration/', import.meta.url);
const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, skillDir), 'utf8'));
const manifestSchema = readJson('manifest.schema.json');
const reportSchema = readJson('report.schema.json');
const skillMarkdown = fs.readFileSync(new URL('SKILL.md', skillDir), 'utf8');

// EXTRACTOR_KINDS is intentionally not exported from spec.js; this mirror is the one drift point the
// schema is checked against. Kept local so a spec change fails the enum assertion below.
const EXTRACTOR_KINDS = ['directoryName', 'filename', 'mtime', 'record', 'scanAbsolutePaths'];

const ajv = new Ajv({ strict: false });
const validateManifest = ajv.compile(manifestSchema);
const validateReport = ajv.compile(reportSchema);

function jsonBlocksFromMarkdown(markdown) {
  const blocks = [];
  const pattern = /```json\n([\s\S]*?)```/g;
  let match = null;
  while ((match = pattern.exec(markdown)) !== null) {
    try { blocks.push(JSON.parse(match[1])); } catch { /* unparseable blocks are not examples */ }
  }
  return blocks;
}

function exampleByMarker(blocks, marker) {
  const found = blocks.filter((block) => block && typeof block === 'object' && !Array.isArray(block) && marker in block);
  assert.equal(found.length, 1, `exactly one ${marker} example must exist in SKILL.md`);
  return found[0];
}

const exampleBlocks = jsonBlocksFromMarkdown(skillMarkdown);
const exampleManifest = exampleByMarker(exampleBlocks, 'specVersion');
const exampleReport = exampleByMarker(exampleBlocks, 'reportVersion');

const shippedDescriptors = [
  ...builtinDescriptors,
  readJson('../../plugins/doubao/agent.json'),
  readJson('../../plugins/nova/agent.json'),
];

const sorted = (values) => [...values].sort();

// ---------------------------------------------------------------------------------------------
// Schema ↔ shipped spec alignment (the M1 drift test)
// ---------------------------------------------------------------------------------------------

test('manifest schema top-level keys equal DESCRIPTOR_TOP_LEVEL_KEYS exactly', () => {
  const schemaKeys = Object.keys(manifestSchema.properties);
  assert.deepEqual(schemaKeys, DESCRIPTOR_TOP_LEVEL_KEYS, 'the schema key set must equal the shipped key set, in the shipped order');
});

test('manifest schema capability vocabulary equals DESCRIPTOR_CAPABILITIES exactly', () => {
  const flagKeys = sorted(Object.keys(manifestSchema.definitions.capabilityFlags.properties));
  assert.deepEqual(flagKeys, sorted(DESCRIPTOR_CAPABILITIES));
  assert.equal(manifestSchema.definitions.capabilityFlags.additionalProperties, false, 'an unknown capability flag must be refused by the schema');
});

test('manifest schema closed enums match the shipped spec constants', () => {
  const sections = manifestSchema.definitions.sessions;
  const execution = manifestSchema.definitions.executionStatus;

  assert.deepEqual(sections.properties.kind.enum, SESSION_KINDS);
  assert.deepEqual(manifestSchema.properties.resources.properties.kind.enum, RESOURCE_KINDS);
  assert.deepEqual(manifestSchema.properties.handoff.properties.kind.enum, HANDOFF_KINDS);
  assert.deepEqual(execution.properties.kind.enum, EXECUTION_STATUS_KINDS);
  assert.deepEqual(execution.properties.pick.enum, EXECUTION_STATUS_PICK);
  assert.deepEqual(execution.properties.map.additionalProperties.enum, EXECUTION_STATUS_VALUES);
  assert.equal(sections.properties.transcript.properties.format.const, TRANSCRIPT_FORMATS[0]);
  assert.deepEqual(sections.properties.layout.enum, SESSION_LAYOUTS);
  assert.deepEqual(manifestSchema.definitions.extractorRecordTitle.properties.as.enum, TITLE_AS);
  assert.equal(manifestSchema.properties.specVersion.const, DESCRIPTOR_SPEC_VERSION);

  const extractorKinds = manifestSchema.definitions.extractor.oneOf
    .map((entry) => entry.$ref.split('/').pop())
    .filter((name) => name.startsWith('extractor') && name !== 'extractorRecordTitle')
    .map((name) => manifestSchema.definitions[name].properties.kind.const);
  assert.deepEqual(sorted(extractorKinds), sorted(EXTRACTOR_KINDS));
});

test('manifest schema required keys match what validateDescriptor actually requires', () => {
  assert.deepEqual(manifestSchema.required, ['specVersion', 'type', 'label', 'sessions']);
  // Cross-check against the validator itself: removing any one of them must fail validation.
  for (const key of manifestSchema.required) {
    const missing = { ...exampleManifest };
    delete missing[key];
    const result = validateDescriptor(missing);
    assert.equal(result.ok, false, `removing ${key} must fail validateDescriptor`);
    assert.ok(result.errors.some((error) => error.startsWith(`${key} `)), `the error must name ${key}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The "a skill-following manifest validates on the first attempt" promise
// ---------------------------------------------------------------------------------------------

test('SKILL.md example manifest validates under BOTH the schema and the shipped validator', () => {
  const schemaValid = validateManifest(exampleManifest);
  assert.equal(schemaValid, true, JSON.stringify(validateManifest.errors ?? [], null, 2));
  const result = validateDescriptor(exampleManifest);
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('SKILL.md example report validates under report.schema.json', () => {
  const valid = validateReport(exampleReport);
  assert.equal(valid, true, JSON.stringify(validateReport.errors ?? [], null, 2));
});

test('every shipped descriptor still passes BOTH the schema and the validator (no existing descriptor affected)', () => {
  for (const descriptor of shippedDescriptors) {
    const schemaValid = validateManifest(descriptor);
    assert.equal(schemaValid, true, `${descriptor.type}: ${JSON.stringify(validateManifest.errors ?? [], null, 2)}`);
    const result = validateDescriptor(descriptor);
    assert.equal(result.ok, true, `${descriptor.type}: ${result.errors.join('; ')}`);
  }
  assert.deepEqual(sorted(shippedDescriptors.map((descriptor) => descriptor.type)), ['claude', 'codex', 'doubao', 'nova', 'pi']);
});

// ---------------------------------------------------------------------------------------------
// Forbidden drift: research-proposed extensions must be refused by BOTH surfaces
// ---------------------------------------------------------------------------------------------

test('research-proposed keys (generatedBy, runtime, agent) are refused by BOTH schema and validator', () => {
  for (const key of ['generatedBy', 'runtime', 'agent']) {
    const descriptor = { ...exampleManifest, [key]: { kind: 'none', control: false } };
    assert.equal(validateManifest(descriptor), false, `${key} must fail the schema`);
    const result = validateDescriptor(descriptor);
    assert.equal(result.ok, false, `${key} must fail the validator`);
    assert.match(result.errors.join(' | '), new RegExp(`unknown top-level key "${key}"`));
  }
});

test('a new capability flag (runtimeControl) is refused by BOTH schema and validator', () => {
  const descriptor = { ...exampleManifest, capabilities: { ...exampleManifest.capabilities, runtimeControl: false } };
  assert.equal(validateManifest(descriptor), false, 'runtimeControl must fail the schema');
  const result = validateDescriptor(descriptor);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /capabilities\.runtimeControl is not a known capability/);
});

test('a misspelled top-level key (resource) is refused by BOTH, with the suggestion', () => {
  const descriptor = { ...exampleManifest, resource: { kind: 'none' } };
  assert.equal(validateManifest(descriptor), false, 'resource must fail the schema');
  const result = validateDescriptor(descriptor);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /unknown top-level key "resource"; did you mean "resources"\?/);
});

// ---------------------------------------------------------------------------------------------
// Cross-field wiring rules hold identically in BOTH surfaces
// ---------------------------------------------------------------------------------------------

test('cross-field wiring violations are refused by BOTH schema and validator', () => {
  const cases = [
    {
      name: 'quota: true with resources.kind none',
      build: (base) => ({ ...base, capabilities: { ...base.capabilities, quota: true } }),
      validatorMatch: /capabilities\.quota is true but resources\.kind is none/,
    },
    {
      name: 'apiUsage: true with resources.kind none',
      build: (base) => ({ ...base, capabilities: { ...base.capabilities, apiUsage: true } }),
      validatorMatch: /capabilities\.apiUsage is true but resources\.kind is none/,
    },
    {
      name: 'subscriptionQuota: true with resources.kind none',
      build: (base) => ({ ...base, capabilities: { ...base.capabilities, subscriptionQuota: true } }),
      validatorMatch: /capabilities\.subscriptionQuota is true but resources\.kind is none/,
    },
    {
      name: 'handoff: true with handoff.kind none',
      build: (base) => ({ ...base, capabilities: { ...base.capabilities, handoff: true } }),
      validatorMatch: /capabilities\.handoff is true but handoff\.kind is none/,
    },
    {
      name: 'executionStatus: true with no executionStatus section',
      build: (base) => ({ ...base, capabilities: { ...base.capabilities, executionStatus: true }, executionStatus: undefined }),
      validatorMatch: /capabilities\.executionStatus is true but executionStatus\.kind is none/,
    },
    {
      name: 'handoff.kind builtin with sessions.kind transcript',
      build: (base) => ({ ...base, handoff: { kind: 'builtin' } }),
      validatorMatch: /handoff\.kind builtin requires sessions\.kind builtin/,
    },
    {
      name: 'handoff.kind shared-codex with sessions.kind transcript',
      build: (base) => ({ ...base, handoff: { kind: 'shared-codex' } }),
      validatorMatch: /handoff\.kind shared-codex requires sessions\.kind builtin/,
    },
    {
      name: 'resources.kind builtin with sessions.kind transcript',
      build: (base) => ({ ...base, resources: { kind: 'builtin' } }),
      validatorMatch: /resources\.kind builtin requires sessions\.kind builtin/,
    },
    {
      name: 'executionStatus.kind transcript with sessions.kind builtin',
      build: (base) => ({ ...base, sessions: { kind: 'builtin' }, executionStatus: { ...base.executionStatus } }),
      validatorMatch: /executionStatus\.kind transcript requires sessions\.kind transcript/,
    },
    {
      name: 'executionStatus.kind builtin with sessions.kind transcript',
      build: (base) => ({ ...base, executionStatus: { kind: 'builtin' } }),
      validatorMatch: /executionStatus\.kind builtin requires sessions\.kind builtin/,
    },
    {
      name: 'sessions.kind builtin with capabilities.sessions false',
      build: (base) => ({ ...base, sessions: { kind: 'builtin' }, capabilities: { ...base.capabilities, sessions: false } }),
      validatorMatch: /capabilities\.sessions cannot be false when sessions\.kind is builtin/,
    },
  ];

  for (const scenario of cases) {
    const descriptor = scenario.build(exampleManifest);
    assert.equal(validateManifest(descriptor), false, `${scenario.name}: must fail the schema`);
    const result = validateDescriptor(descriptor);
    assert.equal(result.ok, false, `${scenario.name}: must fail the validator`);
    assert.match(result.errors.join(' | '), scenario.validatorMatch, `${scenario.name}: ${result.errors.join(' | ')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The report schema is the documented evidence contract
// ---------------------------------------------------------------------------------------------

test('report.schema.json formalises the four claim statuses and the redaction proof', () => {
  const statusEnum = reportSchema.properties.claims.items.properties.status.enum;
  assert.deepEqual(sorted(statusEnum), ['observed', 'refused', 'unverified', 'weak']);
  assert.deepEqual(reportSchema.properties.claims.items.required, ['claim', 'status']);
  assert.deepEqual(reportSchema.properties.requests.items.required, ['capability', 'provenance', 'declarativeForm']);
  assert.deepEqual(reportSchema.properties.redaction.required, ['scanned', 'redacted']);
  assert.equal(reportSchema.properties.reportVersion.const, 1);
});

// ---------------------------------------------------------------------------------------------
// Bounded sampling guidance (v0.1.1) — the Tier 1 trial fix on the skill side
// ---------------------------------------------------------------------------------------------

test('SKILL.md guidance replaces first-line-only sampling with bounded windows', () => {
  assert.match(skillMarkdown, /bounded windows/);
  // The concrete window bounds are documented.
  assert.match(skillMarkdown, /first up to 10 records/);
  assert.match(skillMarkdown, /first conversational record/);
  assert.match(skillMarkdown, /hard cap of \*\*20 records\*\*/);
  // Full transcripts remain forbidden, and the stop-on-observed rule is present.
  assert.match(skillMarkdown, /Never read a complete\s+transcript/);
  assert.match(skillMarkdown, /Stop sampling as soon as every required field has been observed/);
});

test('SKILL.md guidance covers the Claude trial failure points', () => {
  // Native fields beyond the first line are anticipated.
  assert.match(skillMarkdown, /beyond the first line/);
  // The scanAbsolutePaths fallback is a mandatory consideration, not a skipped last resort.
  assert.match(skillMarkdown, /mandatory consideration whenever no native cwd appeared/);
  // workspace: null is documented as a projection blocker.
  assert.match(skillMarkdown, /`workspace: null` is not a neutral value/);
  // A native timestamp on a sampled record binds createdAt directly.
  assert.match(skillMarkdown, /a parseable timestamp on a sampled record \*is\* the native `createdAt`/);
  // Roots describe the whole store, never the trial cwd.
  assert.match(skillMarkdown, /Roots describe the whole store/);
  // The optional diagnostics block is documented with its closed vocabulary.
  assert.match(skillMarkdown, /optional\s+`diagnostics`/);
  assert.match(skillMarkdown, /missing_required_evidence/);
});

test('SKILL.md version reflects the refinement without changing the descriptor contract', () => {
  assert.match(skillMarkdown, /\*\*Version 0\.1\.1\*\*/);
  // The descriptor schema remains exactly the shipped one (asserted by the tests above);
  // the skill still emits only the closed key set.
  assert.match(skillMarkdown, /descriptor contract is\s+unchanged/);
});
