# Memory Routing and Hybrid Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed Chinese memories recallable through lexical-plus-optional-semantic retrieval and provide deterministic write-routing hints to the terminal pilot.

**Architecture:** Extract retrieval scoring into a pure module used by the store, add an optional versioned embedder with SQLite-backed vectors, and keep lexical retrieval as the guaranteed fallback. Add a pure heuristic router whose output is hidden context guidance only; Pi still invokes the existing four tools and Core remains authoritative.

**Tech Stack:** Node.js ESM, SQLite, `node:test`, existing Margin Core and Pi adapter.

## Global Constraints

- No independent vector database or external tokenizer.
- Embedding is optional, default-off, versioned, and must fail open to lexical retrieval.
- Automated tests use a deterministic fake embedder and never call a paid API.
- Only confirmed, current, same-project memories may be recalled.
- Routing suggestions never grant permissions or directly mutate storage.
- The terminal pilot keeps exactly four model-facing tools.

---

### Task 1: Chinese lexical retrieval

**Files:**
- Create: `src/core/memoryRetrieval.js`
- Modify: `src/core/marginCoreStore.js`
- Test: `test/memoryRetrieval.test.js`
- Test: `test/marginCoreMemoryTools.test.js`

**Interfaces:**
- Produces: `buildLexicalFeatures(text): Set<string>` and `rankMemoryRows(rows, options): Array<object>`.
- Consumes: memory rows plus `{ query, asOf, topK, queryVector?, embeddingModel? }`.

- [ ] **Step 1: Write failing Chinese lexical tests**

```js
test('Chinese n-grams recall wording variants without inventing unrelated memory', () => {
  const rows = [memory('m1', '昨天完成了新版简历并优化项目经历，后续使用新版简历投递'), memory('m2', '周末购买咖啡')];
  assert.deepEqual(rankMemoryRows(rows, { query: '继续简历投递', asOf: NOW, topK: 5 }).map((row) => row.id), ['m1']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `.\.runtime\node-v22.23.1-win-x64\node.exe --test test\memoryRetrieval.test.js`

Expected: FAIL because `memoryRetrieval.js` does not exist.

- [ ] **Step 3: Implement deterministic lexical features and ranking**

```js
export function buildLexicalFeatures(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const features = new Set(normalized.match(/[a-z0-9]+/g) ?? []);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (const size of [2, 3]) for (let index = 0; index <= run.length - size; index += 1) features.add(run.slice(index, index + size));
  }
  return features;
}
```

Move ranking out of `marginCoreStore.js`; calculate overlap from feature sets and preserve deterministic score/tie ordering.

- [ ] **Step 4: Run focused retrieval and Core memory tests**

Run: `.\.runtime\node-v22.23.1-win-x64\node.exe --test test\memoryRetrieval.test.js test\marginCoreMemoryTools.test.js test\contextPlanner.test.js`

Expected: PASS, including the exact real phrase regression.

- [ ] **Step 5: Commit**

```powershell
git add src/core/memoryRetrieval.js src/core/marginCoreStore.js test/memoryRetrieval.test.js test/marginCoreMemoryTools.test.js
git commit -m "fix: recall Chinese memory with lexical ngrams"
```

### Task 2: Optional SQLite-backed semantic retrieval

**Files:**
- Create: `src/core/migrations/002-memory-embeddings.js`
- Modify: `src/core/migrations/001-margin-core.js`
- Modify: `src/core/marginCoreStore.js`
- Modify: `src/core/createMarginCore.js`
- Modify: `src/core/memoryRetrieval.js`
- Test: `test/marginCoreMigrations.test.js`
- Test: `test/memoryRetrieval.test.js`
- Test: `test/marginCoreMemoryTools.test.js`

**Interfaces:**
- `createMarginCore({ embedder?, retrievalConfig? })` accepts `embedder.embed(text): Promise<number[]>` and `embedder.model: string`.
- `margin_memory_embeddings(memory_id, model, dimensions, vector_json, created_at)` stores confirmed-memory vectors.
- `rankMemoryRows` accepts optional query/vector data and emits `retrievalReason: 'lexical' | 'semantic' | 'hybrid'`.

- [ ] **Step 1: Write failing migration, semantic ranking, and fallback tests**

```js
test('semantic similarity recalls a confirmed memory without lexical overlap', () => {
  const ranked = rankMemoryRows([memory('m1', '新版材料', '[1,0]')], { query: '继续求职', queryVector: [1,0], embeddingModel: 'fake-v1', asOf: NOW, topK: 5 });
  assert.equal(ranked[0].retrievalReason, 'semantic');
});
```

Also assert that a throwing embedder returns lexical results and a mismatched model vector is ignored.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `.\.runtime\node-v22.23.1-win-x64\node.exe --test test\marginCoreMigrations.test.js test\memoryRetrieval.test.js test\marginCoreMemoryTools.test.js`

Expected: FAIL because migration v2 and semantic scoring do not exist.

- [ ] **Step 3: Add migration v2 without changing migration v1 checksum**

```sql
CREATE TABLE margin_memory_embeddings (
  memory_id TEXT NOT NULL REFERENCES margin_memories(id),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(memory_id, model)
);
```

Export both migrations from the existing migration registry while preserving v1 bytes and checksum.

- [ ] **Step 4: Implement optional indexing, query embedding, fusion, and fallback**

On trusted memory confirmation, compute the vector before the write transaction and insert it atomically with confirmation when available. Query embedding failures are caught and recorded as lexical fallback metadata; they do not change the stable tool envelope or fail the search.

Use versioned defaults:

```js
const DEFAULT_RETRIEVAL = Object.freeze({ lexicalWeight: 0.55, semanticWeight: 0.25, confidenceWeight: 0.15, recencyWeight: 0.05 });
```

Reject invalid dimensions/non-finite vectors and ignore stored vectors whose model or dimensions differ.

- [ ] **Step 5: Run focused tests**

Run: `.\.runtime\node-v22.23.1-win-x64\node.exe --test test\marginCoreMigrations.test.js test\memoryRetrieval.test.js test\marginCoreMemoryTools.test.js test\contextPlanner.test.js`

Expected: PASS with fake embedder; no network calls.

- [ ] **Step 6: Commit**

```powershell
git add src/core/migrations src/core/marginCoreStore.js src/core/createMarginCore.js src/core/memoryRetrieval.js test
git commit -m "feat: add optional semantic memory retrieval"
```

### Task 3: Four-way write-routing hints

**Files:**
- Create: `src/continuity/memoryWriteRouter.js`
- Modify: `src/pilot/terminalPilotController.js`
- Modify: `src/runtime/pi/piTerminalPilotRuntime.js`
- Test: `test/memoryWriteRouter.test.js`
- Test: `test/terminalPilotController.test.js`
- Test: `test/piTerminalPilotRuntime.test.js`

**Interfaces:**
- Produces: `routeContinuityInput(message): { routes: Array<'ignore'|'state'|'action'|'memory_proposal'>, reasons: string[] }`.
- Controller adds the result to the hidden plan as `writeRouting`; runtime forwards it without granting permissions.

- [ ] **Step 1: Write failing routing tests**

```js
assert.deepEqual(routeContinuityInput('好的，谢谢').routes, ['ignore']);
assert.deepEqual(routeContinuityInput('昨天完成了新版简历，今天准备投递；以后都用这个版本').routes, ['state', 'action', 'memory_proposal']);
```

Add cases for a blocker, a clear next action, explicit “请记住”, ordinary chat, and approximate quantities that must remain text rather than become exact numbers.

- [ ] **Step 2: Run tests and verify RED**

Run: `.\.runtime\node-v22.23.1-win-x64\node.exe --test test\memoryWriteRouter.test.js test\terminalPilotController.test.js`

Expected: FAIL because the router and hidden field do not exist.

- [ ] **Step 3: Implement bounded deterministic routing**

Use normalized text and explicit cue sets. Return ordered unique routes; `ignore` is exclusive. Do not extract or rewrite factual values, and do not call storage from the router.

- [ ] **Step 4: Attach routing to hidden context**

The controller computes routing for each natural-language turn. The runtime includes `writeRouting` beside `digest`, `selected`, and `operationRules`. Tests assert the tool list and host permissions remain unchanged.

- [ ] **Step 5: Run focused tests**

Run: `.\.runtime\node-v22.23.1-win-x64\node.exe --test test\memoryWriteRouter.test.js test\terminalPilotController.test.js test\piTerminalPilotRuntime.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/continuity/memoryWriteRouter.js src/pilot/terminalPilotController.js src/runtime/pi/piTerminalPilotRuntime.js test
git commit -m "feat: add continuity write routing hints"
```

### Task 4: Real regression and evidence

**Files:**
- Modify: `docs/audit/terminal_continuity_pilot_report.md`

**Interfaces:**
- Consumes: a confirmed memory record and the existing terminal pilot database.
- Produces: reproducible sanitized evidence; no user prompt or credential content.

- [ ] **Step 1: Run complete automated verification**

Run: `npm test`, `npm run validate:stage1`, `npm run audit:pi`, and `git diff --check`.

Expected: all commands pass.

- [ ] **Step 2: Run the real lexical continuity check**

Start `npm run pilot:terminal`, execute `/new`, then `/memory`. Verify the confirmed v2 memory appears with ID, version, source Session, reason, and confirmation state.

- [ ] **Step 3: Exercise the routing hint with one non-destructive user progress update**

Verify the hidden route leads to appropriate existing tools, all tool results are surfaced, and no external/file/network write tool becomes available.

- [ ] **Step 4: Update evidence without claims inflation**

Record only configuration, IDs, result codes, fallback mode, and observed behavior. Do not claim recall rate, task success rate, user value, or runtime superiority.

- [ ] **Step 5: Commit**

```powershell
git add docs/audit/terminal_continuity_pilot_report.md
git commit -m "docs: record hybrid recall pilot evidence"
```
