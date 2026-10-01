import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyValidationManifests } from '../scripts/verify-validation-manifests.js';

test('published validation manifests attest their redacted handoff files and sizes', async () => {
  const result = await verifyValidationManifests();
  assert.equal(result.checked, 54);
  assert.deepEqual(result.mismatches, []);
});
