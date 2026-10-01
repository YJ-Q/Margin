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

// Path checks match a single backslash or a slash. Machine-generated evidence is JSON, where the very
// same path is written with every separator escaped (`C:\\Users\\name`), and that encoding matched
// neither pattern — so a file could carry a real username, pass this guard, and be committed. A false
// green is worse than no guard, because it is trusted. Both encodings are therefore scanned.
//
// The captured segment must look like an account name. Without that, the guard flags its own redaction
// helpers (`electron/main.js` rewrites `/Users/<name>` for user-facing output) and any regex source
// text that happens to contain `Users` — noise that gets a guard switched off.
const WINDOWS_HOME = /C:[\\/]Users[\\/]([A-Za-z0-9._-]{1,64})/gi;
const UNIX_HOME = /\/(?:Users|home)\/([A-Za-z0-9._-]{1,64})/g;

function scanText(text) {
  const found = [];

  for (const match of text.matchAll(WINDOWS_HOME)) {
    if (!isSyntheticWindowsUser(match[1])) found.push(`personal Windows home path: ${match[0]}`);
  }
  for (const match of text.matchAll(UNIX_HOME)) {
    if (!isSyntheticUnixUser(match[1])) found.push(`personal Unix home path: ${match[0]}`);
  }

  if (/(?:[A-Z]:[\\/]Code[\\/]margin)(?:[\\/]|$)/i.test(text)) {
    found.push('machine-specific repository path: D:/Code/margin');
  }
  if (/(?:[A-Z]:[\\/]Echo)(?:[\\/]|$)/i.test(text)) {
    found.push('machine-specific legacy repository path: D:/Echo');
  }

  return found;
}

function privacyViolations(relativePath, content) {
  const isTestFixture = relativePath.replaceAll('\\', '/').startsWith('test/');
  // Decode JSON string escapes so `C:\\Users\\x` is also seen as `C:\Users\x`.
  const decoded = content.replaceAll('\\\\', '\\').replaceAll('\\/', '/');
  const found = [...scanText(content), ...(decoded === content ? [] : scanText(decoded))];

  // Test fixtures intentionally use stable fake workspace paths. Public docs and
  // production material must use repository-relative paths or placeholders.
  const violations = [...new Set(found)];
  if (isTestFixture) return violations.filter((violation) => !violation.startsWith('machine-specific'));
  return violations;
}

function isBinary(content) {
  return content.includes('\0');
}

// The guard is only worth trusting if it can actually see the encodings it claims to cover, so its
// own detection is asserted here rather than assumed.
test('the privacy guard detects both raw and JSON-escaped home paths', () => {
  const escapedWindows = '{"source": "C:\\\\Users\\\\someone\\\\.codex\\\\x.jsonl"}';
  assert.deepEqual(privacyViolations('docs/example.json', escapedWindows), ['personal Windows home path: C:\\Users\\someone']);

  const rawWindows = 'see C:\\Users\\someone\\.codex for the source';
  assert.deepEqual(privacyViolations('docs/example.md', rawWindows), ['personal Windows home path: C:\\Users\\someone']);

  const escapedPosix = '{"cwd": "\\/Users\\/someone\\/project"}';
  assert.deepEqual(privacyViolations('docs/example.json', escapedPosix), ['personal Unix home path: /Users/someone']);

  // A placeholder must not be reported, or the guard becomes noise and gets ignored.
  assert.deepEqual(privacyViolations('docs/example.md', 'C:\\Users\\<user>\\.codex and C:\\Users\\user\\.codex'), []);
  // Redaction helpers and regex sources legitimately contain the words, but not a plausible account.
  assert.deepEqual(privacyViolations('electron/main.js', ".replace(/\\/Users\\/[^/]+/g, '/Users/<user>')"), []);

  // The repository-path rule still exempts test fixtures only.
  assert.deepEqual(privacyViolations('test/fixture.js', 'D:\\\\Code\\\\margin\\\\x'), []);
  assert.deepEqual(privacyViolations('docs/example.md', 'D:\\\\Code\\\\margin\\\\x'), ['machine-specific repository path: D:/Code/margin']);
});

test('tracked tree contains no personal absolute paths or tracked private evidence paths', () => {
  const files = trackedFiles();
  const violations = [];

  for (const relativePath of files) {
    const normalized = relativePath.replaceAll('\\', '/');
    if (/^(?:\.margin|handoff-output|\.runtime|out[^/]*|data\/(?:phase2b-live|pi-spike))(?:\/|$)/i.test(normalized) || /^docs\/validation\/.*\.jsonl$/i.test(normalized)) {
      violations.push(`${relativePath}: private/generated artifact is tracked`);
      continue;
    }

    const absolutePath = path.join(repositoryRoot, relativePath);
    // This guard must contain example paths in order to test itself, so it is the one file exempt from
    // the home-path rule. Its own detection is asserted by the test above instead.
    if (normalized === 'test/repositoryPrivacy.test.js') continue;
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
