import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  extractRecoveryObject,
  validateRecoveryObject,
  parseRecovery,
  buildStructuredRecoveryRequest,
  buildRecoveryTurnMessage,
  RECOVERY_REQUIRED_FIELDS,
  RECOVERY_ALL_FIELDS,
  RECOVERY_JSON_SCHEMA
} from '../src/core/handoff/recoveryJson.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VALID_OBJECT = Object.freeze({
  goal: 'g', progress: 'p', pending: 'x', historicalValidation: 'h',
  recommendedFollowUp: 'f', currentApplicability: 'c', unsafeAssumptions: ['a1']
});

// ---------------------------------------------------------------------------
// extractRecoveryObject
// ---------------------------------------------------------------------------

test('extracts a clean whole-text object as clean', () => {
  const result = extractRecoveryObject(JSON.stringify(VALID_OBJECT));
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'clean');
  assert.deepEqual(result.value, VALID_OBJECT);
});

test('extracts valid JSON preceded by prose with no code fence (the case-09 false-negative shape)', () => {
  const text = `Based on my investigation, here is the recovered state.\n\nKey verified facts:\n- handoff is present.\n\n${JSON.stringify(VALID_OBJECT)}`;
  const result = extractRecoveryObject(text);
  assert.equal(result.ok, true, 'prose-prefixed bare JSON must still be extracted');
  assert.equal(result.mode, 'embedded');
  assert.deepEqual(result.value, VALID_OBJECT);
});

test('extracts fenced JSON and JSON with trailing prose / trailing code fence', () => {
  const fenced = `Here you go:\n\n\`\`\`json\n${JSON.stringify(VALID_OBJECT)}\n\`\`\``;
  assert.deepEqual(extractRecoveryObject(fenced).value, VALID_OBJECT);

  const trailingFence = `${JSON.stringify(VALID_OBJECT)}\n\`\`\``;
  assert.deepEqual(extractRecoveryObject(trailingFence).value, VALID_OBJECT);

  const trailingProse = `${JSON.stringify(VALID_OBJECT)}\n\nHope that helps.`;
  assert.deepEqual(extractRecoveryObject(trailingProse).value, VALID_OBJECT);
});

test('brace counting ignores braces that appear inside JSON strings', () => {
  const value = { goal: 'use {x} and a literal } here', progress: 'p', pending: 'x', historicalValidation: 'h', recommendedFollowUp: 'f' };
  const result = extractRecoveryObject(`notes {not json}\n${JSON.stringify(value)}`);
  assert.equal(result.ok, true);
  assert.equal(result.value.goal, 'use {x} and a literal } here');
});

test('repairs JSON truncated at the output-token cap by closing open arrays/objects/strings', () => {
  const truncated = '{"goal":"g","progress":"p","pending":"x","historicalValidation":"h","recommendedFollowUp":"f","currentApplicability":"c","unsafeAssumptions":["a1"';
  const result = extractRecoveryObject(truncated);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'repaired');
  assert.deepEqual(result.value.unsafeAssumptions, ['a1']);
  const parsed = parseRecovery(truncated);
  assert.equal(parsed.status, 'ready');
});

test('tolerates raw newlines/tabs inside strings on the repair path', () => {
  const raw = '{"goal":"line1\nline2\tend","progress":"p","pending":"x","historicalValidation":"h","recommendedFollowUp":"f"}';
  const result = extractRecoveryObject(raw);
  assert.equal(result.ok, true);
  assert.match(result.value.goal, /line1\s+line2\s+end/);
});

test('reports the failure class rather than throwing for unusable text', () => {
  assert.deepEqual(extractRecoveryObject(''), { ok: false, code: 'empty_final_text' });
  assert.deepEqual(extractRecoveryObject('   \n\t '), { ok: false, code: 'empty_final_text' });
  assert.deepEqual(extractRecoveryObject(undefined), { ok: false, code: 'empty_final_text' });
  assert.deepEqual(extractRecoveryObject('I could not find anything structured.'), { ok: false, code: 'no_json_object' });
  assert.equal(extractRecoveryObject('{ "goal": 123 oops').ok, false);
});

// ---------------------------------------------------------------------------
// validateRecoveryObject
// ---------------------------------------------------------------------------

test('accepts the complete closed schema and normalises whitespace', () => {
  const result = validateRecoveryObject({ ...VALID_OBJECT, goal: '  g  ' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingRequired, []);
  assert.equal(result.normalized.goal, 'g');
});

test('flags missing and empty required fields without inventing content', () => {
  const partial = { goal: 'g', progress: '   ', pending: 'x' };
  const result = validateRecoveryObject(partial);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingRequired, ['progress', 'historicalValidation', 'recommendedFollowUp']);
  assert.equal(result.normalized.goal, 'g');
  assert.equal(result.normalized.pending, 'x');
});

test('normalises array-of-string text fields and non-string assumption lists', () => {
  const result = validateRecoveryObject({
    goal: ['one', 'two'], progress: 'p', pending: 'x', historicalValidation: 'h',
    recommendedFollowUp: 'f', unsafeAssumptions: ['a', ' ', 3]
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.goal, 'one\ntwo');
  assert.deepEqual(result.normalized.unsafeAssumptions, ['a', '3']);

  const bad = validateRecoveryObject({ ...VALID_OBJECT, unsafeAssumptions: 'nope' });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.typeIssues, ['unsafeAssumptions must be an array of strings']);
});

test('reports unknown extra fields but still accepts a structurally complete object', () => {
  const result = validateRecoveryObject({ ...VALID_OBJECT, surprise: 1 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.extraFields, ['surprise']);
});

test('rejects non-object payloads', () => {
  assert.equal(validateRecoveryObject(null).valid, false);
  assert.equal(validateRecoveryObject([1, 2]).valid, false);
  assert.equal(validateRecoveryObject('string').valid, false);
});

// ---------------------------------------------------------------------------
// parseRecovery discriminated verdict
// ---------------------------------------------------------------------------

test('parseRecovery returns ready / recoverable / needs_recovery correctly', () => {
  assert.equal(parseRecovery(JSON.stringify(VALID_OBJECT)).status, 'ready');
  const recoverable = parseRecovery(JSON.stringify({ goal: 'g' }));
  assert.equal(recoverable.status, 'recoverable');
  assert.equal(recoverable.reason, 'missing_required_fields');
  assert.ok(recoverable.missingRequired.includes('recommendedFollowUp'));

  const empty = parseRecovery('');
  assert.deepEqual(empty, { status: 'needs_recovery', reason: 'empty_final_text', retryWithoutTools: true });
  assert.equal(parseRecovery('plain prose only').status, 'needs_recovery');
});

// ---------------------------------------------------------------------------
// structured request + recovery turn assembly
// ---------------------------------------------------------------------------

test('buildStructuredRecoveryRequest exposes strict json_schema, json_object, and prompt-only modes', () => {
  const strict = buildStructuredRecoveryRequest();
  assert.equal(strict.responseFormat.type, 'json_schema');
  assert.equal(strict.responseFormat.json_schema.strict, true);
  assert.equal(strict.responseFormat.json_schema.schema, RECOVERY_JSON_SCHEMA);
  assert.match(strict.instruction, /ONE JSON object/);

  const object = buildStructuredRecoveryRequest({ mode: 'json_object' });
  assert.deepEqual(object.responseFormat, { type: 'json_object' });

  const promptOnly = buildStructuredRecoveryRequest({ mode: 'prompt' });
  assert.equal(promptOnly.responseFormat, undefined);
  assert.ok(promptOnly.instruction.length > 0);

  assert.deepEqual(RECOVERY_JSON_SCHEMA.required, RECOVERY_ALL_FIELDS);
  assert.ok(RECOVERY_REQUIRED_FIELDS.every((field) => RECOVERY_ALL_FIELDS.includes(field)));
});

test('the empty-text recovery turn forbids further tools; the malformed turn demands a strict re-emit', () => {
  assert.match(buildRecoveryTurnMessage('empty_final_text'), /Do not call any more tools/);
  assert.match(buildRecoveryTurnMessage('invalid_json'), /not machine-readable JSON/);
});

// ---------------------------------------------------------------------------
// Regression against the FROZEN R7 evidence (the two reported NO-JSON failures)
// ---------------------------------------------------------------------------

const formalDir = path.join(here, '..', 'docs', 'validation', 'continuation-ab-deepseek-r7-runs', 'formal');

function loadR7(caseId, arm) {
  const file = path.join(formalDir, `${caseId}-${arm}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('R7 frozen evidence: all ten parseable B-runs parse ready with every graded field populated', { skip: !existsSync(formalDir) }, () => {
  for (let i = 1; i <= 12; i += 1) {
    if (i === 2 || i === 9) continue; // 2 = genuine empty final text; 9 is asserted separately
    const caseId = `case-${String(i).padStart(2, '0')}`;
    const run = loadR7(caseId, 'B');
    const verdict = parseRecovery(run.rawResponse ?? '');
    assert.equal(verdict.status, 'ready', `${caseId}-B should parse to ready`);
    for (const field of RECOVERY_REQUIRED_FIELDS) {
      assert.equal(typeof verdict.value[field], 'string', `${caseId}-B.${field}`);
      assert.ok(verdict.value[field].trim().length > 0, `${caseId}-B.${field} non-empty`);
    }
  }
});

test('R7 frozen evidence: case-09-B was a false-negative and now recovers via prose-prefixed bare JSON', { skip: !existsSync(formalDir) }, () => {
  const run = loadR7('case-09', 'B');
  assert.equal(run.parseError, 'no parseable JSON object in final text'); // the historical misclassification
  assert.ok((run.rawResponse ?? '').indexOf('{') > 200); // ~1KB prose prefix, intact JSON after it
  const verdict = parseRecovery(run.rawResponse);
  assert.equal(verdict.status, 'ready');
  assert.equal(verdict.parseMode, 'embedded');
  for (const field of RECOVERY_REQUIRED_FIELDS) assert.ok(verdict.value[field].length > 0, field);
});

test('R7 frozen evidence: case-02-B genuinely has no final text and routes to the no-tool recovery turn', { skip: !existsSync(formalDir) }, () => {
  const run = loadR7('case-02', 'B');
  assert.equal(run.rawResponse, '');
  assert.equal(run.parseError, 'no final assistant text');
  const verdict = parseRecovery(run.rawResponse);
  assert.deepEqual(verdict, { status: 'needs_recovery', reason: 'empty_final_text', retryWithoutTools: true });
  assert.match(buildRecoveryTurnMessage(verdict.reason), /Do not call any more tools/);
});
