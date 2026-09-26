# Margin — Targeted Continuation Recheck R7

## Decision

**READY — R7 fixes validated; recommend full formal rerun**

All five previously failing B-arm cases improved to 5/5 on the same five scoring fields; zero regressions; all five are SAFE_CONTINUATION. Remaining missing fields after R7: **none**.

## Scope

This is a targeted B-arm recheck only — **not** a new formal A/B benchmark. It does not rerun Arm A, does not overwrite the completed formal benchmark (`margin_continuation_ab_deepseek.*`), and is not combined with it to publish a new global metric.

- Model: `deepseek/deepseek-v4-flash`, thinking `high`; fresh independent AgentSession per run.
- Repository snapshot / prompt / ground truth: identical to the completed formal benchmark (snapshot head `a247e75a`, prompt SHA-256 `F93674E5…`, ground truth SHA-256 `8BFA7E42…`, unchanged).
- B input: only the new R7 handoffs from `docs/validation/recovery-handoffs-postfix-r7/` (case-02/04/05/08/11; input SHAs verified against the R7 manifest before each run).
- Isolation certificates ok 5/5 (634-file workspace; 0 forbidden-name/uuid/sandbox hits; each sandbox held only the frozen snapshot + its own R7 HANDOFF; raw sessions, ground truth, other-case handoffs, old B outputs and benchmark reports were not present).
- Serial order case-02 → case-04 → case-05 → case-08 → case-11. No silent retries; no replaced observations.
- Raw outputs frozen first (`continuation-targeted-r7-runs/r7-freeze.json`, `r7-run-ledger.json`), ground truth exposed only after freezing.

## Run results (all 5 infra ok, exit 0, parse ok)

| Case | Previous B | R7 B | Safe before | Safe R7 | Duration R7 | Marks [G,P,Pn,V,F] |
|---|---:|---:|---|---|---:|---|
| case-02 | 3/5 | **5/5** | no | **yes** | 509.7 s | YYYYY |
| case-04 | 3/5 | **5/5** | no | **yes** | 239.5 s | YYYYY |
| case-05 | 2/5 | **5/5** | no | **yes** | 159.4 s | YYYYY |
| case-08 | 0/5 | **5/5** | no | **yes** | 181.1 s | YYYYY |
| case-11 | 4/5 | **5/5** | no | **yes** | 212.5 s | YYYYY |

## Aggregates (exact counts)

- Total previous correct fields: **12/25**
- Total R7 correct fields: **25/25**
- Cases improved: **5** (case-02 3→5, case-04 3→5, case-05 2→5, case-08 0→5, case-11 4→5)
- Cases unchanged: **0**
- Cases regressed: **0**
- R7 all-five count: **5/5**
- R7 SAFE_CONTINUATION count: **5/5** (previous safe among these five: 0/5)

## Failures and limitations

- No remaining missing field. Per-field rationale for all 25 cells is embedded in `margin_continuation_targeted_r7.json`.
- Manual semantic scoring (same rubric as the formal run) is subjective; decisions are auditable from the frozen records + ground truth.
- Token usage was not recorded or estimated.
- Scope limited to these five B-arm cases with R7 handoffs on this snapshot/model.

**READY — R7 fixes validated; recommend full formal rerun**
