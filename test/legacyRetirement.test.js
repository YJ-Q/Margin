import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Legacy retirement guard.
//
// The legacy surface is frozen, not deleted: `data/echo.sqlite` and the Express routes stay until the
// table-by-table decision recorded in docs/audit/legacy_retirement_plan.md is made. "Frozen" has to mean
// something executable, so this test asserts the two properties that make it true — the gate cannot be
// opened by accident, and the current entry points cannot reach the legacy code at all.
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

// Entry points that must NOT reach the legacy surface. `scripts/run-legacy-api.js` is deliberately absent:
// it is the one supported way in, and it opens the gate explicitly.
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
    `a current entry point reaches frozen legacy code: ${reached.join(', ')}. The legacy surface is reachable only through \`npm run legacy:api\`.`);
});

test('the legacy API stays behind its explicit gate', async () => {
  const server = await readFile(path.join(repositoryRoot, 'src/server.js'), 'utf8');
  // The gate must be an exact-match check on an env var that is not set by default, and it must refuse
  // rather than warn: a warning would still leave the deprecated surface listening.
  assert.match(server, /MARGIN_ENABLE_LEGACY_API\s*!==\s*'true'/, 'src/server.js must refuse to start unless MARGIN_ENABLE_LEGACY_API is exactly "true"');
  const launcher = await readFile(path.join(repositoryRoot, 'scripts/run-legacy-api.js'), 'utf8');
  assert.match(launcher, /MARGIN_ENABLE_LEGACY_API\s*=\s*'true'/, 'the legacy launcher must be the one place that opens the gate');
  // Surface C (the default) must not be able to start it as a side effect: the gate reads the environment,
  // so a default run without the variable set is closed.
  const marginSurface = await readFile(path.join(repositoryRoot, 'scripts/run-margin-surface.js'), 'utf8');
  assert.doesNotMatch(marginSurface, /MARGIN_ENABLE_LEGACY_API/, 'the default surface must not touch the legacy gate');
});

test('the legacy dataset is preserved until a recorded decision', async () => {
  // The plan forbids deleting it before the export and the table-by-table decision. If it ever disappears,
  // that decision was skipped, so the invariant is asserted rather than trusted.
  const legacy = await stat(path.join(repositoryRoot, 'data/echo.sqlite'));
  assert.ok(legacy.isFile(), 'data/echo.sqlite must remain until the retirement decision is recorded');

  const plan = await readFile(path.join(repositoryRoot, 'docs/audit/legacy_retirement_plan.md'), 'utf8');
  // Every legacy table must carry a disposition, so a table cannot be forgotten when the decision is made.
  for (const table of ['conversations', 'summaries', 'actions', 'learning_sessions', 'learning_events', 'user_profile', 'knowledge_base', 'operation_proposals', 'operation_events', 'user_states']) {
    assert.ok(plan.includes(table), `docs/audit/legacy_retirement_plan.md does not cover table ${table}`);
  }
});
