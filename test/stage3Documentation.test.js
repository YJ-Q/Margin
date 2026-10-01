import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarginCore } from '../src/core/createMarginCore.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage2Boundary = 'faadda45402f08fc925621bc20bf0fb448c4eee5';

function readStage2File(relativePath) {
  const result = spawnSync('git', ['show', `${stage2Boundary}:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertUnchangedSinceStage2(relativePath) {
  const result = spawnSync('git', ['diff', '--quiet', stage2Boundary, '--', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, `${relativePath} changed since the Stage 2 boundary.`);
}

test('Stage 3 remains Pi-independent and the archived legacy API cannot start', async (t) => {
  assert.deepEqual(await createMarginCore({ enabled: false, dbPath: 'Z:\\does-not-exist\\core.sqlite' }), { enabled: false });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'margin-stage3-closure-'));
  const core = await createMarginCore({ enabled: true, dbPath: path.join(directory, 'core.sqlite') });
  t.after(async () => {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(Object.keys(core.tools).sort(), ['action_update', 'memory_propose', 'memory_search', 'state_update']);
  assert.equal(typeof core.planContext, 'function');

  const coreFiles = await readdir(path.join(repositoryRoot, 'src', 'core'), { recursive: true });
  for (const file of coreFiles.filter((name) => name.endsWith('.js'))) {
    const source = await readFile(path.join(repositoryRoot, 'src', 'core', file), 'utf8');
    assert.doesNotMatch(source, /@earendil-works\/pi|pi-coding-agent/u);
  }
  assert.doesNotMatch(
    await readFile(path.join(repositoryRoot, 'src', 'continuity', 'contextPlanner.js'), 'utf8'),
    /@earendil-works\/pi|pi-coding-agent/u
  );

  assert.match(await readFile(path.join(repositoryRoot, 'src', 'server.js'), 'utf8'), /legacy_api_archived/u);
  const stage2Manifest = JSON.parse(readStage2File('evaluation/stage1/manifest.json'));
  const currentManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'evaluation', 'stage1', 'manifest.json'), 'utf8'));
  assert.deepEqual(currentManifest, stage2Manifest);
  await assertUnchangedSinceStage2('evaluation/stage1');
  for (const entry of currentManifest.tasks) {
    const bytes = await readFile(path.join(repositoryRoot, 'evaluation', 'stage1', entry.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }

  const report = await readFile(path.join(repositoryRoot, 'docs', 'audit', 'stage_3_continuity_mvp_report.md'), 'utf8');
  for (const exclusion of [
    'production chat activation', 'legacy migration', '50-task evaluation', 'A/B/C comparison', 'recall metrics', 'user research'
  ]) assert.match(report, new RegExp(exclusion, 'iu'));
  assert.match(report, /Live smoke was run with `yapi\/gpt-5\.6-terra`/u);
  assert.match(report, /toolsRegistered.*sessionBoundary.*contextDelivered.*provenancePresent.*safetyPolicy/su);
  assert.doesNotMatch(report, /Live smoke was not run/u);
  assert.doesNotMatch(report, /\b\d+(?:\.\d+)?%\b/u);
  assert.doesNotMatch(
    await readFile(path.join(repositoryRoot, 'CHANGELOG.md'), 'utf8'),
    /the internal Pi adapter, production chat integration, legacy-data migration/u
  );
});
