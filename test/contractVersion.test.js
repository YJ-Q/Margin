import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_TYPES } from '../src/agents/sourceRegistry.js';
import { COMMAND_TYPES, CONTRACT_VERSION, QUERY_TYPES } from '../src/contracts/contractTypes.js';
import { contractSurfaceFingerprint, describeContractSurface } from '../src/contracts/contractSurface.js';
import { WEB_COMMAND_CAPABILITIES, WEB_QUERY_CAPABILITIES } from '../src/http/webCapabilities.js';

// Contract version discipline.
//
// CONTRACT_VERSION used to be a constant nothing kept honest: a command could be added, or a status enum
// changed, and a consumer would only find out at runtime. This test freezes the declared surface against
// the version that announces it, so the bump becomes a required step of the change rather than a habit.
//
// The surface description itself lives in src/contracts/contractSurface.js and is derived from the
// declarations, so the only thing maintained here is the record of released versions.

// One entry per released contract surface. Add the new fingerprint when you bump CONTRACT_VERSION; never
// re-point an existing entry, because that entry is the record of what consumers could already rely on.
const RELEASED_SURFACES = Object.freeze({
  '1.2': '2aae73af1c462a2c43ad762798c66e2f043a5f766b0e91d0a8417c618be49722',
});

test('the declared contract surface matches the version that announces it', () => {
  const fingerprint = contractSurfaceFingerprint();
  const recorded = RELEASED_SURFACES[CONTRACT_VERSION];
  assert.ok(recorded, `CONTRACT_VERSION ${CONTRACT_VERSION} has no recorded surface. Bump the version and add its fingerprint, or restore the version if the bump was accidental.`);
  assert.equal(fingerprint, recorded,
    'The declared contract surface changed but CONTRACT_VERSION did not.\n'
    + `Bump CONTRACT_VERSION in src/contracts/contractTypes.js, then set RELEASED_SURFACES['${CONTRACT_VERSION}'] to:\n  ${fingerprint}\n`
    + `Surface: ${JSON.stringify(describeContractSurface())}`);
});

test('no two versions announce the same surface', () => {
  // A bump that changes nothing is noise a consumer cannot act on, and it hides the change that mattered.
  const fingerprints = Object.values(RELEASED_SURFACES);
  assert.equal(new Set(fingerprints).size, fingerprints.length, 'two contract versions declare an identical surface');
});

test('every agent Margin can read sessions from is a valid workerKind', () => {
  // The two taxonomies are deliberately distinct — the Core's closed worker vocabulary versus the Runtime
  // context's agent registry (ADR 003) — but they must not *diverge*: the Session ↔ Run bridge lets a Run
  // bind any session the Board can show, so a missing entry makes that session unbindable.
  const core = describeContractSurface().workerKinds;
  for (const agentType of AGENT_TYPES) {
    assert.ok(core.includes(agentType), `agent type "${agentType}" has no workerKind; a Run could not be created for its sessions`);
  }
  // `other` is the escape hatch for a runtime Margin ships no reader for, including plugin agents. It must
  // stay, or a plugin-backed Run would have no vocabulary at all.
  assert.ok(core.includes('other'));
  // The Core vocabulary stays closed: a plugin descriptor cannot widen it.
  assert.ok(core.length < 12, `workerKinds grew unexpectedly: ${core.join(', ')}`);
});

test('every declared type carries a capability', () => {
  // The gateway asserts this at module load and throws; restating it here documents the invariant and
  // names what broke, instead of leaving a bare import failure.
  assert.deepEqual(COMMAND_TYPES.filter((type) => !(type in WEB_COMMAND_CAPABILITIES)), []);
  assert.deepEqual(QUERY_TYPES.filter((type) => !(type in WEB_QUERY_CAPABILITIES)), []);
  assert.deepEqual(describeContractSurface().commandCapabilities.filter(([, capability]) => !capability), []);
});
