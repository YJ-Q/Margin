import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const forgeConfig = require('../forge.config.cjs');

const ignoreRules = forgeConfig.packagerConfig.ignore;

// Electron Packager runs every `ignore` regex against a path relative to the
// app root, always prefixed with `/` and normalized to forward slashes on every
// platform (see @electron/packager `dist/copy-filter.js`: `name =
// fullPath.split(path.resolve(opts.dir))[1]`, then `normalizePath` on Windows).
// It supplies `/test/api.test.js`, never `D:\Code\margin\test\api.test.js`.
function ignored(packagerPath) {
  return ignoreRules.some((rule) => rule.test(packagerPath));
}

const REPO_ROOT_TREES = Object.freeze([
  '.runtime',
  'test',
  'docs/validation',
  'docs/superpowers',
  'evaluation',
  'data',
  'experiments',
  '.superpowers',
  'handoff-output',
  '.margin',
]);

test('Every forbidden repository-root tree is excluded via Packager-style root-relative paths', () => {
  for (const tree of REPO_ROOT_TREES) {
    assert.equal(ignored(`/${tree}`), true, `directory entry /${tree} must be excluded`);
    assert.equal(ignored(`/${tree}/sample.json`), true, `/${tree}/sample.json must be excluded`);
    assert.equal(ignored(`/${tree}/nested/deep/sample.js`), true, `/${tree}/nested/deep/sample.js must be excluded`);
  }
});

test('Packager root-relative test paths mirror the reported bug', () => {
  assert.equal(ignored('/test/api.test.js'), true);
  assert.equal(ignored('/docs/validation/private-smoke.json'), true);
  assert.equal(ignored('/data/margin.db'), true);
  assert.equal(ignored('/.runtime/node-v22.23.1-win-x64/node.exe'), true);
});

test('Repository subdirectories that merely reuse a forbidden name are kept', () => {
  // Only the repository root `data/` etc. is generated content; the same names
  // nested under source or web output are normal repo files.
  assert.equal(ignored('/src/data/records.js'), false);
  assert.equal(ignored('/src/experiments/runner.js'), false);
  assert.equal(ignored('/src/experiments.js'), false);
  assert.equal(ignored('/web/data/margin.json'), false);
  assert.equal(ignored('/scripts/evaluation/summarize.js'), false);
  assert.equal(ignored('/src/test/helpers.js'), false);
  // Rule matches must not degrade into prefix or plain-substring matches.
  assert.equal(ignored('/test-utils/helper.js'), false);
  assert.equal(ignored('/data-archive/old.json'), false);
  assert.equal(ignored('/docs/validation-notes/history.md'), false);
  assert.equal(ignored('/outcomes/report.json'), false);
});

test('Dependency runtime assets that reuse forbidden directory names are preserved', () => {
  // Regression guard for the amazon-bedrock.json packaging failure: this class
  // of dependency JSON asset must stay inside app.asar.
  assert.equal(ignored('/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/amazon-bedrock.json'), false);
  assert.equal(ignored('/node_modules/some-dep/data/records.json'), false);
  assert.equal(ignored('/node_modules/some-dep/test/unit/index.js'), false);
  assert.equal(ignored('/node_modules/some-dep/docs/validation/fixture.json'), false);
  assert.equal(ignored('/node_modules/some-dep/docs/superpowers/history.md'), false);
  assert.equal(ignored('/node_modules/some-dep/evaluation/results.json'), false);
  assert.equal(ignored('/node_modules/some-dep/experiments/bench.js'), false);
  assert.equal(ignored('/node_modules/some-dep/.superpowers/state.json'), false);
  assert.equal(ignored('/node_modules/some-dep/handoff-output/session.jsonl'), false);
  assert.equal(ignored('/node_modules/some-dep/.runtime/node'), false);
  assert.equal(ignored('/node_modules/some-dep/.margin/config.json'), false);
});

test('Required packaged runtime assets are never excluded', () => {
  for (const asset of [
    '/package.json',
    '/electron/main.js',
    '/electron/preload.cjs',
    '/src/core/handoff/createMarginSurface.js',
    '/web/dist/margin.html',
    '/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    '/node_modules/@earendil-works/pi-coding-agent/package.json',
  ]) {
    assert.equal(ignored(asset), false, `${asset} must be packaged`);
  }
});

test('Exclusions bind to Packager normalized paths, not host absolute filesystem paths', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  // The pre-S10.0C rules were anchored on these absolute paths and therefore
  // never matched anything Packager actually supplies.
  assert.equal(ignored(path.join(repoRoot, 'test', 'api.test.js')), false);
  assert.equal(ignored(path.join(repoRoot, 'data', 'margin.db')), false);
  assert.equal(ignored('C:\\Code\\margin\\docs\\validation\\private-smoke.json'), false);
  assert.equal(ignored('/home/user/margin/data/margin.db'), false);
});
