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
const WINDOWS_HOME = /[A-Z]:[\\/]Users[\\/]([\p{L}\p{N}._-]{1,64})/giu;
const UNIX_HOME = /\/(?:Users|home)\/([A-Za-z0-9._-]{1,64})/g;

function scanText(text) {
  const found = [];

  for (const match of text.matchAll(WINDOWS_HOME)) {
    if (!isSyntheticWindowsUser(match[1])) found.push(`personal Windows home path: ${match[0]}`);
  }
  for (const match of text.matchAll(UNIX_HOME)) {
    if (!isSyntheticUnixUser(match[1])) found.push(`personal Unix home path: ${match[0]}`);
  }

  if (/(?:[A-Z]:[\\/]Code[\\/]margin)(?=[\\/\s'"`.,;:)\]}]|$)/i.test(text)) {
    found.push('machine-specific repository path: D:/Code/margin');
  }
  if (/(?:[A-Z]:[\\/]Echo)(?=[\\/\s'"`.,;:)\]}]|$)/i.test(text)) {
    found.push('machine-specific legacy repository path: D:/Echo');
  }

  if (/[A-Z]:[\\/](?:Temp|tmp|Windows[\\/]Temp)[\\/][^\s'"`<>]+/i.test(text)
      || /(?<![\w/:])\/(?:private\/)?(?:tmp|var\/folders)\/[^\s'"`<>]+/.test(text)) {
    found.push('machine-specific temporary path');
  }

  return found;
}

function privacyViolations(relativePath, content) {
  const isTestFixture = relativePath.replaceAll('\\', '/').startsWith('test/');
  // Decode JSON string escapes so `C:\\Users\\x` is also seen as `C:\Users\x`.
  const decoded = content.replaceAll('\\\\', '\\').replaceAll('\\/', '/');
  // These two design documents contain proposed, deterministic example roots, not captured paths.
  // Keep the exception at the literal level so any other local path in either document still fails.
  const examples = {
    'docs/research/agent-verify-design.md': /D:[\\/]tmp[\\/]nova-home/gi,
    'docs/superpowers/plans/2026-07-29-margin-recruiter-delivery.md': /C:[\\/]Temp[\\/]margin-recruiter-(?:http-server\.pid|delivery(?:\.zip)?|deploy(?:-status)?\.json)/gi,
  };
  const reviewed = examples[relativePath] ? decoded.replace(examples[relativePath], '<example-workspace>') : decoded;
  const found = scanText(reviewed);

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

test('the privacy guard detects temporary roots and quote-delimited repository roots', () => {
  for (const value of ['C:\\Temp\\capture-abc\\file.jsonl', 'D:/tmp/capture-abc', '/tmp/capture-abc', '/private/var/folders/abc/file']) {
    assert.deepEqual(privacyViolations('docs/capture.md', value), ['machine-specific temporary path']);
    assert.deepEqual(privacyViolations('docs/capture.json', JSON.stringify({ path: value })), ['machine-specific temporary path']);
  }
  for (const value of ["cwd: 'D:\\\\Code\\\\margin'", '"D:/Code/margin"', '`D:/Code/margin`']) {
    assert.deepEqual(privacyViolations('docs/example.md', value), ['machine-specific repository path: D:/Code/margin']);
  }
  assert.deepEqual(privacyViolations('docs/example.md', '<repo> and <isolated-workspace>/capture.jsonl'), []);
  assert.deepEqual(privacyViolations('package-lock.json', 'https://registry.npmjs.org/tmp/-/tmp-0.0.33.tgz'), []);
  assert.deepEqual(privacyViolations('docs/research/agent-verify-design.md', 'D:/tmp/nova-home/sessions'), []);
  assert.deepEqual(privacyViolations('docs/research/agent-verify-design.md', 'D:/tmp/private-capture'), ['machine-specific temporary path']);
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
