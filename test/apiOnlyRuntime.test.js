import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('package defaults to the Margin Surface while exposing the Electron host separately', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const legacyServerSource = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.equal(packageJson.main, 'electron/main.js');
  assert.equal(packageJson.scripts?.['electron:start'], 'electron .');
  assert.ok(packageJson.devDependencies?.electron);
  assert.equal(packageJson.scripts?.test, '.\\.runtime\\node-v22.23.1-win-x64\\node.exe --test "test/*.test.js"');
  assert.equal(packageJson.scripts?.['audit:pi'], '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/audit-pi-baseline.js');
  assert.equal(packageJson.scripts?.start, '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-margin-surface.js');
  assert.equal(packageJson.scripts?.dev, '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-margin-surface.js --dev');
  assert.equal(packageJson.scripts?.['legacy:workbench'], '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-web-workbench.js');
  assert.equal(packageJson.scripts?.['legacy:api'], '.\\.runtime\\node-v22.23.1-win-x64\\node.exe scripts/run-legacy-api.js');
  assert.match(legacyServerSource, /legacy_api_archived/);
});

test('README describes the Phase 2B Web Workbench, canonical Core, and explicit alternate surfaces', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /Phase 2B Web Workbench/i);
  assert.match(readme, /npm run build/);
  assert.match(readme, /npm start/);
  assert.match(readme, /npm run dev/);
  assert.match(readme, /npm run spike:pi-continuity/);
  assert.doesNotMatch(readme, /npm run desktop|run-margin-desktop\.cmd|run-echo-desktop\.cmd/);
  assert.match(readme, /npm run pilot:terminal/);
  assert.match(readme, /npm run legacy:api/);
  assert.match(readme, /data\/terminal-pilot\/margin-core\.sqlite/);
  assert.match(readme, /runtime_unavailable/);
});
