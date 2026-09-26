# Margin — Handoff Compression Benchmark

**PASS — Handoff compression benchmark complete**

All 12 cases were resolved from manifest `case → sessionId → frozen HANDOFF`, then from frozen HANDOFF evidence/capture metadata to the exact staged native JSONL. Actual filesystem bytes were read with PowerShell `Get-Item .Length`; no character or token estimate was used.

- 12/12 source snapshots matched capture sessionId, exact byte count, and SHA-256; the sessionId occurs in every JSONL.
- 12/12 frozen HANDOFF header sessionIds and SHA-256 values matched the manifest.
- Ground truth SHA-256 observed: `8bfa7e421299e5432c55e6dd4a2ff71c1d6b44b940c356f0a453a3f5c5fbf8fb`. Frozen inputs were not modified; no case was excluded.

`Reduction = 1 - HandoffBytes / SourceBytes`

| Case | SessionId | Source bytes | HANDOFF bytes | Reduction |
|---|---|---:|---:|---:|
| case-01 | 01a077ec-bd2c-78a1-8581-c7440c9bda66 | 1,438,110 | 4,783 | 99.667% |
| case-02 | 01a074ec-9f30-7c62-bb5f-257091ef242a | 899,546 | 4,927 | 99.452% |
| case-03 | 01a0755d-e84a-7980-afaa-f98246f9436c | 687,084 | 3,747 | 99.455% |
| case-04 | 01a07639-d0ef-7452-a987-af0de51b29e3 | 3,271,291 | 2,586 | 99.921% |
| case-05 | 01a07786-adf5-77a3-91ba-e4a75ceda7e7 | 3,957,580 | 4,869 | 99.877% |
| case-06 | 01a07490-65fb-7643-9a8e-d1d7d69643be | 2,763,251 | 11,390 | 99.588% |
| case-07 | 01a074d4-f3b2-76e1-8411-9f93be0a91a2 | 1,222,548 | 20,913 | 98.289% |
| case-08 | 01a0763e-bfe9-77f1-b669-900b837d2754 | 1,799,202 | 3,982 | 99.779% |
| case-09 | 01a070e6-3bd9-7591-aa4e-31b364badda1 | 2,515,611 | 11,539 | 99.541% |
| case-10 | 01a07564-99fa-72e0-b086-4a21e5011211 | 2,336,054 | 4,796 | 99.795% |
| case-11 | 01a076e8-fe17-7430-b1c4-b32715a65fe8 | 2,215,417 | 4,141 | 99.813% |
| case-12 | 01a07770-d875-7b51-bd03-e154fe30c66c | 1,658,999 | 9,222 | 99.444% |

| Metric | Result |
|---|---:|
| Median source bytes | 2,007,309.5 |
| Mean source bytes | 2,063,724.4 |
| Median HANDOFF bytes | 4,832.5 |
| Mean HANDOFF bytes | 7,241.3 |
| **Median reduction** | **99.628%** |
| Mean reduction | 99.552% |
| Min / max reduction | 98.289% / 99.921% |

Based on 12 real historical Coding Sessions, Margin reduced the median task-handoff context size by **99.6%**.

## Semantic preservation

Compared against frozen ground truth semantically, not by heading/keyword match. A generic section that reports historical evidence unknown does not preserve a specific recorded completion, pending task, validation, or safest next action.

| Case | Goal | Progress / Completed | Pending | Validation | Next action |
|---|---|---|---|---|---|
| case-01 | present | absent | absent | absent | absent |
| case-02 | present | absent | absent | absent | absent |
| case-03 | present | absent | absent | absent | absent |
| case-04 | present | absent | absent | absent | absent |
| case-05 | present | absent | absent | absent | absent |
| case-06 | present | absent | absent | absent | absent |
| case-07 | present | absent | absent | absent | absent |
| case-08 | present | absent | absent | absent | absent |
| case-09 | present | present | absent | present | absent |
| case-10 | present | absent | absent | absent | absent |
| case-11 | present | absent | absent | absent | absent |
| case-12 | present | absent | absent | absent | absent |

Totals: Goal **12/12**; Progress / Completed **1/12**; Pending **0/12**; Validation **1/12**; Next action **0/12**.

**Resume-safe metric:** **0/12 (0%)** preserve all five ground-truth semantic fields. The byte-compression result is valid, but it is not evidence of resume-safe semantic compression.

Machine-readable data: `docs/validation/margin_handoff_compression_benchmark.json`.
