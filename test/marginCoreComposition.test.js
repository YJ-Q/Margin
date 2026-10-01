import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createMarginCore } from '../src/core/createMarginCore.js';

test('disabled facade performs no database I/O', async () => {
  assert.deepEqual(await createMarginCore({ enabled: false, dbPath: 'Z:\\does-not-exist\\core.sqlite' }), { enabled: false });
});

test('enabled facade exposes exactly four handlers and closes cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'margin-compose-'));
  try {
    const core = await createMarginCore({ enabled: true, dbPath: path.join(dir, 'core.sqlite') });
    assert.equal(core.enabled, true);
    assert.deepEqual(Object.keys(core.tools).sort(), ['action_update', 'memory_propose', 'memory_search', 'state_update']);
    await core.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
