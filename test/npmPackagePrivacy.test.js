import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real npm package inventory excludes local evidence and retains public runtime assets', () => {
  const command = 'npm pack --dry-run --json';
  const output = process.platform === 'win32'
    ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd: root, encoding: 'utf8' })
    : execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const [manifest] = JSON.parse(output);
  const files = new Set(manifest.files.map(entry => entry.path));
  const prohibited = /^(?:\.claude\/|\.margin\/|\.runtime\/|handoff-output\/|out[^/]*\/|docs\/validation\/|experiments\/[^/]+\/output\/|agent-integration-refinement-report\.md$|docs\/research\/agent-self-integration-(?:real-trial|tier1-trial|tier1-revalidation)\.md$|docs\/roadmap\/v0\.2-scope-proposal\.md$|\.env$)/;
  assert.deepEqual([...files].filter(file => prohibited.test(file)), []);
  // Preserve every tracked public runtime/source/doc path, not just a few entry points.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of tracked.filter(file => /^(?:src|bin|electron|plugins|skills|web|scripts)\//.test(file)
      || /^docs\//.test(file) && !file.startsWith('docs/validation/'))) {
    assert.ok(files.has(file), `missing public package file: ${file}`);
  }
  for (const file of ['README.md', 'LICENSE', 'package.json']) assert.ok(files.has(file), file);
  if (existsSync(path.join(root, 'web/dist/margin.html'))) {
    assert.ok(files.has('web/dist/margin.html'));
    assert.ok([...files].some(file => /^web\/dist\/assets\/.+\.js$/.test(file)));
    assert.ok([...files].some(file => /^web\/dist\/assets\/.+\.css$/.test(file)));
  }
});
