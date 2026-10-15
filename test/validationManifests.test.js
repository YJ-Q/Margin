import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyValidationManifests } from '../scripts/verify-validation-manifests.js';

test('published validation manifests attest their redacted handoff files and sizes', async () => {
  const result = await verifyValidationManifests();
  assert.equal(result.checked, 54);
  assert.deepEqual(result.mismatches, []);
});

test('V0.2 privacy derivatives retain explicit provenance and current measurements', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bytes = file => readFileSync(path.join(root, file));
  const json = file => JSON.parse(bytes(file));
  const hash = file => createHash('sha256').update(bytes(file)).digest('hex');
  const ledger = json('docs/validation/v0.2-privacy-redaction.json');
  assert.equal(ledger.artifacts.length, 20);
  for (const artifact of ledger.artifacts) {
    assert.equal(artifact.after.sha256, hash(artifact.path), artifact.path);
    assert.equal(artifact.after.bytes, bytes(artifact.path).length, artifact.path);
    assert.match(artifact.before.sha256, /^[a-f0-9]{64}$/);
  }
  for (const entry of ledger.baselinePublicMeasurements) {
    assert.equal(entry.handoffBytes, bytes(entry.path).length, entry.path);
    assert.equal(entry.reductionPct, 100 * (1 - entry.handoffBytes / entry.sourceBytes));
  }
  for (const file of ['docs/validation/margin_handoff_compression_benchmark_postfix.json', 'docs/validation/recovery-handoffs-r7-full/manifest.json']) {
    const manifest = json(file);
    for (const entry of manifest.cases) {
      assert.equal(entry.handoffSha256, hash(entry.handoff), entry.handoff);
      assert.equal(entry.handoffBytes, bytes(entry.handoff).length, entry.handoff);
      assert.equal(entry.reductionPct, 100 * (1 - entry.handoffBytes / entry.sourceBytes));
    }
    const mean = manifest.cases.reduce((sum, entry) => sum + entry.handoffBytes, 0) / manifest.cases.length;
    assert.equal(manifest.statistics.handoffBytes.mean, mean);
    const original = ledger[file].historicalCases;
    assert.deepEqual(manifest.cases.map(entry => entry.sourceSha256),
      original.map(entry => entry.sourceSha256));
    assert.equal(original.length, manifest.cases.length);
  }
});
