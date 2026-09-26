# Margin — DeepSeek Continuation A/B Benchmark (formal run)

## Verdict

**PASS — DeepSeek Continuation A/B benchmark complete**

All 24 formal runs executed under the frozen protocol: 24/24 infra-ok clean isolated sessions, 24/24 isolation certificates ok, 24 unique sessions, balanced paired order, frozen inputs/harness, controller-side wall-clock timing, no silent retries and no replaced observations. Two runs returned final text with no parseable recovery JSON (case-06-A, case-08-B); they are retained as observations and scored 0/5, not retried.

## Arms (claims used in this report only)

- **A** = direct recovery from raw historical Codex Session
- **B** = Margin HANDOFF-assisted recovery by DeepSeek

Model: `deepseek/deepseek-v4-flash`, thinking `high`, snapshot head `a247e75a` (frozen workspace identical within each pair), 12 frozen paired inputs, frozen harness hashes, validated A/B filesystem isolation. Results apply only to this experiment (this repository snapshot, this model); they are not generalized to other repositories, models, sessions, or real user workflows.

## Method

- 12 real historical Margin sessions (4 research, 4 medium implementation, 4 complex implementation per prior tiering; session ids and titles below).
- Each case ran twice in **fresh, isolated, in-memory DeepSeek sessions**, never in parallel: A received only the raw native Codex session JSONL (`./input/session.jsonl`) plus the frozen repo snapshot; B received only the postfix Margin HANDOFF (`./input/HANDOFF.md`) plus the same snapshot. A never saw a HANDOFF file; B never saw a raw session file; neither saw ground truth, previous outputs, or the opposite arm's result (isolation certificates ok for 24/24).
- Order was balanced: case-01..06 ran A→B, case-07..12 ran B→A.
- Each recovery task was read-only and had to stop after returning one structured JSON (goal / progress / pending / historicalValidation / recommendedFollowUp / currentApplicability / unsafeAssumptions).
- Controller-side wall-clock duration was recorded per run (watchdog 25 min; no run exceeded 9.1 min; normal 3–6 min latency was not treated as failure).
- Preflight results are excluded from all formal metrics.

## 12 paired raw results

Per-case accuracy = [goal, progress, pending, validation, follow-up]; one point per field. Raw per-cell decisions and rationale strings are in [margin_continuation_ab_deepseek.json](<repo>\docs\validation\margin_continuation_ab_deepseek.json).

| Case | Session | Title | A dur | A score | B dur | B score | A→B |
|---|---:|---:|---:|---:|---:|---:|---:|
| case-01 | `01a077ec-bd2c-78a1-8581-c7440c9bda66` | V2.2 Agent Source Management | 259.9 s | 5/5 | 214.1 s | 5/5 | B |
| case-02 | `01a074ec-9f30-7c62-bb5f-257091ef242a` | Slice 3.3 R1 Workspace Overview research | 262.2 s | 5/5 | 362.8 s | 3/5 | A |
| case-03 | `01a0755d-e84a-7980-afaa-f98246f9436c` | V2 Floating Window Host Architecture research | 407.3 s | 5/5 | 350.0 s | 5/5 | B |
| case-04 | `01a07639-d0ef-7452-a987-af0de51b29e3` | Repository cleanup audit | 408.6 s | 5/5 | 194.5 s | 3/5 | B |
| case-05 | `01a07786-adf5-77a3-91ba-e4a75ceda7e7` | Token Usage Source R1 research | 348.2 s | 5/5 | 172.6 s | 2/5 | B |
| case-06 | `01a07490-65fb-7643-9a8e-d1d7d69643be` | Slice 2.6 Terminal Handoff Action Hierarchy Fix | 373.0 s | 0/5 | 447.5 s | 5/5 | A |
| case-07 | `01a074d4-f3b2-76e1-8411-9f93be0a91a2` | Slice 3.2 Resume-first Checkpoint Experience | 542.4 s | 5/5 | 421.0 s | 5/5 | B |
| case-08 | `01a0763e-bfe9-77f1-b669-900b837d2754` | Repository Cleanup Slice 1 | 347.0 s | 5/5 | 443.2 s | 0/5 | A |
| case-09 | `01a070e6-3bd9-7591-aa4e-31b364badda1` | Phase 1 Distiller PoC | 293.1 s | 5/5 | 177.6 s | 4/5 | B |
| case-10 | `01a07564-99fa-72e0-b086-4a21e5011211` | V2.1 Electron Floating Host | 421.3 s | 5/5 | 134.1 s | 5/5 | B |
| case-11 | `01a076e8-fe17-7430-b1c4-b32715a65fe8` | V2 UI R3 first implementation | 384.8 s | 5/5 | 246.1 s | 4/5 | B |
| case-12 | `01a07770-d875-7b51-bd03-e154fe30c66c` | V2 UI R3.3 controls, refresh, settings, save feedback | 533.4 s | 5/5 | 238.8 s | 5/5 | B |

Every percentage below is backed by the exact raw counts shown. Complete per-run ledger (session ids, run ids, timings, parse status): [formal-run-ledger.json](<repo>\docs\validation\continuation-ab-deepseek-runs\formal-run-ledger.json).

## Per-run raw results (24)

Legend: field marks = [Goal, Progress, Pending, Validation, Follow-up]; Y = correct, . = incorrect; NO-JSON = final text had no parseable recovery JSON (0/5).

| Run | Arm | Duration | Score | Marks | Parse |
|---|---|---:|---|---|---|
| case-01 | A | 259.9 s | 5/5 | YYYYY | ok |
| case-01 | B | 214.1 s | 5/5 | YYYYY | ok |
| case-02 | A | 262.2 s | 5/5 | YYYYY | ok |
| case-02 | B | 362.8 s | 3/5 | Y..YY | ok |
| case-03 | A | 407.3 s | 5/5 | YYYYY | ok |
| case-03 | B | 350.0 s | 5/5 | YYYYY | ok |
| case-04 | A | 408.6 s | 5/5 | YYYYY | ok |
| case-04 | B | 194.5 s | 3/5 | Y..YY | ok |
| case-05 | A | 348.2 s | 5/5 | YYYYY | ok |
| case-05 | B | 172.6 s | 2/5 | Y..Y. | ok |
| case-06 | A | 373.0 s | 0/5 | ..... | NO-JSON |
| case-06 | B | 447.5 s | 5/5 | YYYYY | ok |
| case-07 | A | 542.4 s | 5/5 | YYYYY | ok |
| case-07 | B | 421.0 s | 5/5 | YYYYY | ok |
| case-08 | A | 347.0 s | 5/5 | YYYYY | ok |
| case-08 | B | 443.2 s | 0/5 | ..... | NO-JSON |
| case-09 | A | 293.1 s | 5/5 | YYYYY | ok |
| case-09 | B | 177.6 s | 4/5 | YY.YY | ok |
| case-10 | A | 421.3 s | 5/5 | YYYYY | ok |
| case-10 | B | 134.1 s | 5/5 | YYYYY | ok |
| case-11 | A | 384.8 s | 5/5 | YYYYY | ok |
| case-11 | B | 246.1 s | 4/5 | Y.YYY | ok |
| case-12 | A | 533.4 s | 5/5 | YYYYY | ok |
| case-12 | B | 238.8 s | 5/5 | YYYYY | ok |

## Field accuracy (120 graded cells; 24 runs × 5 fields)

| Field | Correct / total | Rate |
|---|---:|---:|
| Goal | 22/24 | 91.67% |
| Progress | 18/24 | 75.00% |
| Pending | 18/24 | 75.00% |
| Validation | 22/24 | 91.67% |
| Follow-up | 21/24 | 87.50% |
| **Overall** | **101/120** | **84.17%** |

Per arm (60 cells each): **A = 55/60 (91.67%)**, **B = 46/60 (76.67%)**.

## All-five case pass rate (5/5 on a run)

- Overall: **17/24 (70.83%)** — A: **11/12 (91.67%)**, B: **6/12 (50.00%)**.

## SAFE_CONTINUATION pass rate

Definition (predeclared in the JSON deliverable): a run is a SAFE_CONTINUATION when it returned a structured recovery JSON with all required keys **and** goal/progress/pending/validation are all correct (the situational awareness needed to continue safely); follow-up correctness is not part of the safety gate.

- Overall: **17/24 (70.83%)** — A: **11/12 (91.67%)**, B: **6/12 (50.00%)**.
- In this sample the SAFE_CONTINUATION count equals the all-five count because every follow-up failure co-occurred with an awareness-field failure (raw: follow-up failures were case-05-B and case-08-B, both of which also failed progress/pending or all fields). No run achieved 4/4 awareness but failed follow-up.

## Recovery time (controller-side wall clock; no token usage recorded or estimated)

| Metric | A (ms) | B (ms) | Change |
|---|---:|---:|---:|
| Median recovery time | 378904 (378.9 s) | 242452 (242.5 s) | -36.01% |
| Mean recovery time | 381771 (381.8 s) | 283527 (283.5 s) | -25.73% |
| Paired median Δ (B − A) | | | -118464 ms (-118.5 s) |
| Paired mean Δ (B − A) | | | -98243 ms (-98.2 s) |

Per-case paired durations (B − A):

| Case | A | B | Δ | Faster |
|---|---:|---:|---:|---|
| case-01 | 259.9 s | 214.1 s | -45.7 s | B |
| case-02 | 262.2 s | 362.8 s | 100.7 s | A |
| case-03 | 407.3 s | 350.0 s | -57.4 s | B |
| case-04 | 408.6 s | 194.5 s | -214.1 s | B |
| case-05 | 348.2 s | 172.6 s | -175.5 s | B |
| case-06 | 373.0 s | 447.5 s | 74.5 s | A |
| case-07 | 542.4 s | 421.0 s | -121.4 s | B |
| case-08 | 347.0 s | 443.2 s | 96.1 s | A |
| case-09 | 293.1 s | 177.6 s | -115.6 s | B |
| case-10 | 421.3 s | 134.1 s | -287.2 s | B |
| case-11 | 384.8 s | 246.1 s | -138.7 s | B |
| case-12 | 533.4 s | 238.8 s | -294.6 s | B |

B was faster in **9/12** cases; A was faster in **3/12** (case-02, case-06, case-08). Medians were computed on n=12 per arm; deltas on the 12 paired per-case differences.

## Failures and limitations

- **Non-parseable outputs**: case-06-A and case-08-B returned a final assistant message with no parseable JSON object (infra ok, exit 0, isolation ok). They are retained observations scored 0/5; no silent retry and no replacement run was made.
- **Token usage**: not recorded or estimated (this runtime exposes no provider input-token counts; per protocol, no estimate is offered).
- **Artifact-driven accuracy losses (measured outcome, not a protocol failure)**: case-02-B, case-04-B, case-05-B and case-11-B recovered materially less of the source session's true content than ground truth; the distilled HANDOFF for those cases lacked the original session's substantive findings, and the models honestly reported "unknown" rather than inventing content. Those failures are the A/B difference the benchmark measures.
- **Subjective scoring**: field grades were assigned by manual semantic comparison of the frozen outputs to the frozen ground-truth reference after all outputs were frozen. Per-field rationale for all 120 cells is embedded in the JSON for re-audit.
- **Scope**: single frozen repo snapshot at `a247e75a`, one model (DeepSeek V4 Flash, high), one prompt template, 12 sessions from one repository's history. Do not generalize beyond this experiment.
- Case-02-B, case-04-B, case-05-B, case-06-A, case-08-B, case-09-B and case-11-B are the runs that fell short of SAFE_CONTINUATION (raw list).

## Resume-safe metrics

| Metric | Value |
| --- | --- |
| Valid clean runs | 24/24 (infra ok, exit 0, isolation certificate ok) |
| Unique sessions | 24/24 |
| Parseable recovery JSON | 22/24 |
| Balanced order | case-01..06 A→B; case-07..12 B→A |
| Preflight results in metrics | No (formal records only) |
| Silent retries / replaced observations | None |
| Harness modified during run | No (hashes verified before and after launch) |
| Frozen inputs | 12 sessions + 12 HANDOFFs, SHA-256 ledger `harness-freeze.json` (pre-run) |
| Raw output freeze | `freeze-manifest.json` + `formal-run-ledger.json` (post-run) |
| Timing | controller-side wall clock per run |
| Token counts | Not available; not estimated |

## Use of these numbers

Use only the two arms as defined above. These are within-experiment paired observations on one repository and one model; they are not a user study and not a general Margin product claim. Resume-safe metrics above are the only figures eligible for reuse, with the limitations stated.

**PASS — DeepSeek Continuation A/B benchmark complete**
