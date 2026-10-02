import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Legacy retirement guard.
//
// The legacy surface is archived: the historical modules remain in Git for audit, and the local
// frozen dataset was physically deleted on 2026-10-02 after a recorded decision (see
// docs/audit/legacy_retirement_plan.md §7); no launcher can open a listener. Current entry points
// must not reach the legacy code.
//
// Without this, a refactor could quietly re-import `src/services/*` from the default surface and the
// freeze would exist only in a document.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_MODULES = Object.freeze([
  'src/app.js',
  'src/storage/memoryStore.js',
  'src/config/env.js',
]);
const LEGACY_PREFIXES = Object.freeze(['src/routes/', 'src/services/']);

// Entry points that must NOT reach the historical implementation.
const CURRENT_ENTRIES = Object.freeze([
  'scripts/run-margin-surface.js',
  'scripts/run-web-workbench.js',
  'electron/main.js',
  'bin/margin.js',
]);

async function moduleFiles(directory) {
  const found = [];
  for (const entry of await readdir(path.join(repositoryRoot, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await moduleFiles(relative));
    else if (entry.isFile() && /\.(?:js|mjs|cjs|jsx)$/.test(entry.name)) found.push(relative);
  }
  return found;
}

function importedSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g, // static import, including side-effect only
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,                        // dynamic import
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g                        // cjs require
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const isRelative = (specifier) => specifier.startsWith('./') || specifier.startsWith('../');

async function resolveRelative(fromRelativePath, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelativePath), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`];
  for (const candidate of candidates) {
    try { if ((await stat(path.join(repositoryRoot, candidate))).isFile()) return candidate; }
    catch { /* try the next shape */ }
  }
  return null;
}

// Static reachability over the repository's own relative imports. A bare specifier is a package, not a
// repository module, so it ends the walk.
async function reachableFrom(entries) {
  const all = [...await moduleFiles('src'), ...await moduleFiles('scripts'), ...await moduleFiles('electron'), ...await moduleFiles('bin')];
  const known = new Set(all);
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || !known.has(current)) continue;
    seen.add(current);
    const source = await readFile(path.join(repositoryRoot, current), 'utf8');
    for (const specifier of importedSpecifiers(source)) {
      if (!isRelative(specifier)) continue;
      const resolved = await resolveRelative(current, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

test('the current entry points cannot reach the legacy surface', async () => {
  const reachable = await reachableFrom(CURRENT_ENTRIES);
  const reached = [...reachable].filter((module) => LEGACY_MODULES.includes(module) || LEGACY_PREFIXES.some((prefix) => module.startsWith(prefix)));
  assert.deepEqual(reached, [],
    `a current entry point reaches archived legacy code: ${reached.join(', ')}.`);
});

test('the archived legacy API has no startup route, even with the former opt-in flag', async () => {
  const server = await readFile(path.join(repositoryRoot, 'src/server.js'), 'utf8');
  assert.match(server, /legacy_api_archived/);
  assert.doesNotMatch(server, /\.listen\(/, 'the archived entry must never open a listener');
  const launcher = await readFile(path.join(repositoryRoot, 'scripts/run-legacy-api.js'), 'utf8');
  assert.doesNotMatch(launcher, /MARGIN_ENABLE_LEGACY_API\s*=/);
  const writes = [];
  const { main } = await import('../src/server.js');
  assert.equal(await main({ env: { MARGIN_ENABLE_LEGACY_API: 'true' }, stderr: { write: (value) => writes.push(value) } }), 1);
  assert.match(writes.join(''), /legacy_api_archived/);
  const marginSurface = await readFile(path.join(repositoryRoot, 'scripts/run-margin-surface.js'), 'utf8');
  assert.doesNotMatch(marginSurface, /MARGIN_ENABLE_LEGACY_API/, 'the default surface must not touch the legacy gate');
});

test('the legacy dataset is physically retired only after export + the table-by-table decision were recorded', async () => {
  const plan = await readFile(path.join(repositoryRoot, 'docs/audit/legacy_retirement_plan.md'), 'utf8');
  // Every legacy table must carry a disposition, so a table cannot be forgotten in the decision.
  for (const table of ['conversations', 'summaries', 'actions', 'learning_sessions', 'learning_events', 'user_profile', 'knowledge_base', 'operation_proposals', 'operation_events', 'user_states']) {
    assert.ok(plan.includes(table), `docs/audit/legacy_retirement_plan.md does not cover table ${table}`);
  }
  // Physical deletion is allowed only once the decision is recorded with its dated anchor. The anchor
  // turns this guard from "preserve until a decision" into "the recorded retirement is a final state".
  assert.match(plan, /legacy-echo-dataset-physically-deleted:2026-10-02/,
    'physical deletion of data/echo.sqlite must be recorded with its dated anchor');

  const exists = async (relative) => {
    try { await stat(path.join(repositoryRoot, relative)); return true; }
    catch { return false; }
  };
  // The dataset, its SQLite sidecar files, and its full-content JSON export stay gone after the
  // recorded decision, so the frozen legacy database cannot silently come back.
  for (const relative of [
    'data/echo.sqlite',
    'data/echo.sqlite-shm',
    'data/echo.sqlite-wal',
    'data/exports/echo-legacy-2026-09-26.json'
  ]) {
    assert.equal(await exists(relative), false, `${relative} must remain deleted after the recorded retirement`);
  }
});
