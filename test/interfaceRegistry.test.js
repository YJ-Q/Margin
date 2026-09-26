import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { COMMAND_TYPES, CONTRACT_VERSION, EVENT_TYPES, QUERY_TYPES } from '../src/contracts/contractTypes.js';

// The interface registry is only worth having if it is true. Deriving this check from the declarations
// means the document cannot quietly fall behind them: adding a type without documenting it fails here,
// rather than being discovered by whoever next reads the doc and trusts it.
const registry = await readFile(new URL('../docs/architecture/interface-registry.md', import.meta.url), 'utf8');

test('the interface registry documents every declared contract type', () => {
  const missing = [...COMMAND_TYPES, ...QUERY_TYPES, ...EVENT_TYPES].filter((type) => !registry.includes(type));
  assert.deepEqual(missing, [], `undocumented contract types: ${missing.join(', ')}. Add them to docs/architecture/interface-registry.md.`);
});

test('the interface registry names the contract version it describes', () => {
  assert.ok(registry.includes(CONTRACT_VERSION), `the registry does not mention the current CONTRACT_VERSION (${CONTRACT_VERSION})`);
});

test('the interface registry documents every HTTP surface and its owner context', () => {
  // The four surfaces are the reason the registry exists; losing one from it would hide a whole boundary.
  for (const surface of ['margin-board', 'workbench-gateway', 'feishu', 'legacy-rest']) {
    assert.ok(registry.includes(surface), `the registry does not name the ${surface} surface`);
  }
  // The two contexts ADR 003 defines, and the read-only rule that makes the split safe.
  assert.match(registry, /只读/, 'the registry must state the Runtime context read-only rule');
  assert.ok(registry.includes('Session ↔ Run bridge'), 'the registry must document the bridge');
});

test('the interface registry lists the closed lists that must be updated together', () => {
  // The operational knowledge that a contract type touches five places, two of which failed silently.
  for (const file of ['src/contracts/eventEnvelope.js', 'src/http/webCapabilities.js', 'src/contracts/validation.js']) {
    assert.ok(registry.includes(file), `the registry does not warn about ${file}`);
  }
});
