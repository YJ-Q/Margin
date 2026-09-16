import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syntheticWindowsUsers = new Set(['margin', 'user', 'example', 'test']);
const syntheticUnixUsers = new Set(['alice', 'user', 'example', 'test']);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isSyntheticWindowsUser(segment) {
  return syntheticWindowsUsers.has(segment.toLowerCase()) || /^<[^>]+>$/.test(segment);
}

function isSyntheticUnixUser(segment) {
  return syntheticUnixUsers.has(segment.toLowerCase()) || /^<[^>]+>$/.test(segment);
}

function privacyViolations(relativePath, content) {
  const violations = [];
  const isTestFixture = relativePath.replaceAll('\\', '/').startsWith('test/');

  for (const match of content.matchAll(/C:[\\/]Users[\\/]([^\\/\s`'"<>]+)/gi)) {
    if (!isSyntheticWindowsUser(match[1])) violations.push(`personal Windows home path: ${match[0]}`);
  }
  for (const match of content.matchAll(/\/(?:Users|home)\/([^/\s`'"<>]+)/g)) {
    if (!isSyntheticUnixUser(match[1])) violations.push(`personal Unix home path: ${match[0]}`);
  }

  // Test fixtures intentionally use stable fake workspace paths. Public docs and
  // production material must use repository-relative paths or placeholders.
  if (!isTestFixture) {
    if (/(?:[A-Z]:[\\/]Code[\\/]margin)(?:[\\/]|$)/i.test(content)) {
      violations.push('machine-specific repository path: D:/Code/margin');
    }
    if (/(?:[A-Z]:[\\/]Echo)(?:[\\/]|$)/i.test(content)) {
      violations.push('machine-specific legacy repository path: D:/Echo');
    }
  }

  return violations;
}

function isBinary(content) {
  return content.includes('\0');
}

test('tracked tree contains no personal absolute paths or tracked private evidence paths', () => {
  const files = trackedFiles();
  const violations = [];

  for (const relativePath of files) {
    const normalized = relativePath.replaceAll('\\', '/');
    if (/^(?:\.margin|handoff-output|\.runtime|out[^/]*|data\/(?:phase2b-live|pi-spike))(?:\/|$)/i.test(normalized)) {
      violations.push(`${relativePath}: private/generated artifact is tracked`);
      continue;
    }

    const absolutePath = path.join(repositoryRoot, relativePath);
    const content = readFileSync(absolutePath, 'utf8');
    if (isBinary(content)) continue;
    for (const violation of privacyViolations(relativePath, content)) {
      violations.push(`${relativePath}: ${violation}`);
    }
  }

  // Keep this check portable: it derives the active home rather than committing
  // any developer username or credential into the repository.
  const activeHome = os.homedir().replaceAll('\\', '/');
  assert.ok(activeHome.length > 0, 'the privacy guard must run with a resolvable home directory');
  assert.deepEqual(violations, [], violations.join('\n'));
});
