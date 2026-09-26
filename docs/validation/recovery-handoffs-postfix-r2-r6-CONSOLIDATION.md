# recovery-handoffs-postfix r2–r6 — S5B consolidation

Consolidated 2026-09-08 (S5B). These five intermediate postfix iterations were
reduced to their durable evidence only. Frozen baseline and final evidence are
untouched: `recovery-handoffs/` (base), `recovery-handoffs-postfix/` (base full
run), `recovery-handoffs-postfix-r7/`, `recovery-handoffs-r7-full/`,
`recovery-benchmark-ground-truth.json`, continuation A/B freeze evidence, and
compression-benchmark final evidence all remain as-is.

## What each r2…r6 tree now keeps

Per tree, 5 cases (case-02, case-04, case-05, case-08, case-11), 11 files ≈ 0.04 MB:

- `case-<n>.md` — the per-run handoff/result evidence for that iteration; the
  handoff content differs run-to-run because the distiller pipeline evolved
  across r2→r7 (this difference **is** the iteration evidence chain).
- `manifest.json` — immutable provenance: `sessionId`, `sourceSnapshot`
  (retained native archive path), `sourceBytes`, `sourceSha256`, `handoff`,
  `handoffBytes`, `handoffSha256`, `reductionPct`, `method`, and `frozenInputs`
  (baseline manifest + ground truth + their sha256).
- `session-<id>.jsonl.capture.json` — generation-time metadata
  (capturedAt, originalPath, snapshotPath, bytes, sha256, sessionId).

## What was removed and why

- Removed the 5 `session-<id>.jsonl` snapshot copies per tree (≈ 11.6 MB/tree,
  ≈ 58 MB total). They were byte-identical copies of the retained native
  source sessions under `~/.codex/archived_sessions/` and added no evidence
  beyond `manifest.cases[].sourceSha256`.
- Verified before removal for every case (r2…r6, 25 entries):
  - stored snapshot sha256 == retained archive sha256 == manifest `sourceSha256`
  - kept `case-<n>.md` sha256 == manifest `handoffSha256`
- Reproducibility proven live: running the tracked generator
  `scripts/generate-postfix-handoff-benchmark.js` regenerated a `case-02`
  snapshot that byte-matches `sourceSha256` (`cee47577…`).

## How to regenerate any r2…r6 artifact

Source sessions are retained in the active Codex archive. For any r2…r6 tree,
delete the target output dir (the generator refuses to overwrite), then rerun
with that run's exact case set (from its manifest `cases[].case`):

```
node scripts/generate-postfix-handoff-benchmark.js \
  --output docs/validation/recovery-handoffs-postfix-rX \
  --cases case-02,case-04,case-05,case-08,case-11
```

Regenerating snapshots is byte-identical to the recorded `sourceSha256`. The
regenerated `case-<n>.md` reflects the **current** distiller and therefore a new
iteration line (that is how a successor run was created); to reproduce a prior
run's exact handoff bytes you must run the same distiller revision the manifest
came from. The manifest's `handoffSha256` is the evidence to match against any
regeneration.

## Acceptance traceability

- Source sessions per run: `manifest.json → cases[].sessionId / sourceSnapshot`.
- Artifact hash: `manifest.json → cases[].sourceSha256 / handoffSha256` +
  `capture.json → sha256`.
- Why a run produced that result: `manifest.json → method / frozenInputs`
  (+ the `case-*.md` content to compare against the frozen ground truth).
- How to regenerate: see the command above.
- r2→r7 iteration chain: the differing `case-*.md` and `manifest.json`
  `statistics` across r2…r6 (and the retained r7 / r7-full) preserve the chain.