# `margin agent verify` — Public Interface

Status: **stable public interface.** This document is the contract for
`margin agent verify` and its `--json` result document. The four top-level verdicts,
the exit codes, `resultVersion: 1`, and the documented reason codes are stable: callers
may branch on them. Descriptor semantics, the reader catalogue, and descriptor fields
are unchanged by this interface.

- Command: `margin agent verify <descriptor.json|-> [--path <home>] [--json] [--sample <n>]`
- Result contract: `resultVersion: 1`
- Design history (non-normative): `docs/research/agent-verify-design.md`

---

## 1. What verify is

`margin agent verify` is a **read-only, evidence-producing observation**. It runs a
descriptor against this machine through the same adapter the Margin hosts consume and
reports what was **observed** versus what was merely **declared**:

> Does this declaration read THIS machine, through the same adapter the hosts consume,
> and publish at least one invariant-clean session?

It is not a linter, not an install dry-run, and not a health check. It is the instrument
that turns "the descriptor is installed" into "the descriptor was observed reading this
machine".

**Declaration is not evidence.** Nothing in the descriptor — not `capabilities`, not the
Agent's own report, not a passing install dry-run — can produce `verified`. A surface is
verified only when the source-backed read path observed it. Every numeric field in the
result lives inside an object that names its evidence.

---

## 2. Verdict vocabulary (closed)

The top-level verdict set is closed. There are exactly four verdicts; no further
top-level verdicts will be added without a new `resultVersion`.

| Verdict | Exit | Meaning |
|---|---|---|
| `verified` | `0` | The descriptor is legal and satisfiable, the source was read, and at least one invariant-clean session was published. |
| `no_sessions` | `2` | A session reader **exists and ran** against a reachable, probe-passing source and published **zero** sessions. |
| `unavailable` | `3` | The declared session surface **cannot be observed** on this machine: the descriptor declares no session source, no home exists, the source is disabled/unreadable, or the read failed. |
| `rejected` | `4` | The declaration is illegal, unsatisfiable, unsafe, mismatched with its home, or produced a session that fails a projection invariant. Fix the descriptor — this is never a machine condition. |

Exit `1` is reserved (as for every other `margin agent` command) for usage errors and
unreadable input — cases that never reached a verdict.

### 2.1 The required distinction: "no session source" is not "no sessions"

These are different sentences and must never share a verdict:

| Case | Situation | Verdict | `reasonCode` |
|---|---|---|---|
| **A** | Descriptor declares **no session provider** — `sessions.kind` is `"none"` | `unavailable` | `session_source_not_declared` |
| **B** | A session **reader exists and ran**, returned zero sessions | `no_sessions` | `reader_returned_empty` |
| **C** | The source is absent / disabled / unreadable | `unavailable` | `no_home_found` / `source_disabled` / `source_unavailable` / `source_read_failed` |
| **D** | A safety rule or the descriptor validator refused | `rejected` | the terminal refusal code (§5) |

For case A the result additionally records `source.probe.state: "not_applicable"`,
`source.validate.valid: false`, and the `sessions` capability as
`status: "unsupported", origin: "session_source_not_declared"`. A home is not walked and
its presence or absence does not change the outcome: there is no session surface to
observe **by declaration**.

### 2.2 Reason codes

`reasonCode` is a stable string at the top level of the result document, alongside
`verdict`. It is `null` only for `verified`. The closed vocabularies:

- `no_sessions`: `reader_returned_empty`
- `unavailable`:
  - `session_source_not_declared` — `sessions.kind: "none"` (case A)
  - `no_home_found` — no home resolved on this machine
  - `source_disabled` — a source for this type is registered but disabled or tombstoned
  - `source_unavailable` — the chosen path is not a readable directory
  - `source_read_failed` — the adapter's read envelope failed transiently
  - `installation_read_failed` — the installation state needed to guard composition could not be read
- `rejected`: the code of the terminal refusal, which is also present in
  `refusals[].code` — `invalid_descriptor`, `builtin_type`, `descriptor_adapter_missing`,
  `unsafe_integration_root`, `probe_mismatch`, `session_root_outside_home`,
  `invariant_failure`, `descriptor_composition_failed`

Multiple reasons can coexist in a run (a result may carry several `refusals` or `notes`);
`reasonCode` is the **terminal** one that determined the verdict, by the fixed precedence
in §6.

---

## 3. Result contract (`resultVersion: 1`)

`resultVersion` is an integer compared with strict equality, under the same discipline as
the descriptor's `specVersion`. A breaking change to this contract increments it.

### 3.1 Stable top-level fields

| Field | Stability | Meaning |
|---|---|---|
| `resultVersion` | stable (`1`) | contract version |
| `generatedAt` | stable | ISO-8601 observation time; a verdict is a point-in-time observation, never cached |
| `tool` | stable | `{ name, version, command: "agent verify" }` |
| `input` | stable | `{ kind: "file"\|"stdin", path, sha256, type, label, specVersion }`; `type/label/specVersion` are `null` when the input did not parse |
| `verdict` | stable | one of the four closed verdicts |
| `reasonCode` | stable | closed reason detail (§2.2); `null` only when verified |
| `scope` | stable | human statement of what was verified |
| `stages[]` | stable | ordered pipeline: `load → descriptor → installation → source → projection`, each `{ stage, status, errors[] }` with `status ∈ passed\|failed\|skipped` |
| `installation` | stable after `descriptor` passes | `{ state, descriptorPath, descriptorSha256, descriptorDigest, source }`; informational, never a verdict by itself |
| `source` | stable once source classification begins | `{ origin, path, unsafe, validate{valid,reason}, probe{state,reason}, candidates[] }`; omitted only when the input never parsed or the descriptor was refused before source classification |
| `sessions` | stable after a successful projection | `{ observed, checked, revision, invariantFailures[], sample[], evidence[] }` |
| `diagnostics` | **optional** — present only when a transcript discovery ran | `{ roots[], entriesExamined, skippedLayout, matchedFiles, candidateCount, projectedCount, dropped[] }`; observed-only debugging evidence — never changes the verdict or the `reasonCode` (see §4.7) |
| `capabilities[]` | stable | one row per closed capability: `{ name, declared, wiring, status, origin, evidence[] }` |
| `refusals[]` | stable | declarations an existing authority refused (§5); non-empty implies `rejected` |
| `evidenceSources[]` | stable | read-scope manifest: what this invocation actually touched |
| `notes[]` | stable | non-refusal diagnostics (e.g. `no_registered_source`, registry unreadable) |

Stable enums: `verdict`, `reasonCode`, stage `status`, capability `status`
(`verified | unavailable | unsupported`), capability `origin`, probe `state`, refusal
`code`/`authority`.

### 3.2 Probe states

`source.probe.state` is explicit — a raw boolean is never rendered as "probe passed":

| State | Meaning |
|---|---|
| `passed` | a probe was declared, ran against the chosen home, and matched |
| `failed` | a probe was declared and did not match → `rejected` (`probe_mismatch`) |
| `not_declared` | the descriptor declares no structural probe; verification rests on its extracts |
| `unavailable` | there was no readable home to probe |
| `rejected` | the home itself was refused as unsafe before probing |
| `not_applicable` | the descriptor declares no session source (`sessions.kind: "none"`) |

### 3.3 Capability semantics

Each capability is a function of **wiring + observation**, never of the declared flag
alone. The declared flag appears only as `declared`. A capability declared `true` but not
observable in the read-only sample is `unavailable` (with an `origin` such as
`not_observed_in_sample`, `not_exercised_by_verify`, `write_path`,
`source_unreachable`); a capability not declared or not expressible is `unsupported`
(`declared_false`, `catalogue_boundary`, `no_reader`, `session_source_not_declared`). A
per-capability gap never downgrades the top-level verdict; automation that needs a
specific capability reads the capability table.

---

## 4. Evidence semantics

1. **Source-backed only.** Every verdict is derived from files actually read through the
   composed adapter the hosts use — never from descriptor claims, the Agent's
   self-integration report, or an install dry-run's synthetic candidate.
2. **No metric without evidence.** Every count lives inside an object carrying an
   `evidence[]` entry or is a stage count tied to a named `evidenceSources[]` read.
3. **Evidence kinds are closed:** `manifest`, `registry`, `filesystem`, `probe`,
   `transcript`, `adapter`.
4. **`sessions.observed` is "what the reader published", not an on-disk count.**
   `no_sessions` is consistent with both "the Agent has never run here" and "every
   candidate was dropped". When the glob matched files, the optional `diagnostics`
   block records each observed drop; when it matched none, the cause is not
   determined and verify still invents no explanation.
5. **Pre-install honesty.** Without a registered source, Margin canonical ids and the
   revision hash are omitted (`canonicalId: null`, `revision: null`) with a
   `no_registered_source` note; native session evidence is still reported.
6. **Content minimisation.** Session samples omit titles/message content;
   `titlePresent` records only the structural fact.
7. **Diagnostics are observed-only.** The optional `diagnostics` block is written by
   the discovery reader at each decision point; nothing in it is inferred afterwards.
   When `matchedFiles` is zero, the empty-projection cause is genuinely undetermined
   and no cause is printed.

### 4.7 Diagnostics contract

Counts, all tied to the discovery run that produced them:

| Field | Meaning |
|---|---|
| `roots[]` | one entry per declared root: `{ root, expanded, exists }`; an unexpandable root carries `reason: "unresolved_template"` |
| `entriesExamined` | layout entries (files or directories) iterated across all roots |
| `skippedLayout` | entries ignored because they did not match the declared layout |
| `matchedFiles` | files matching the declared transcript glob |
| `candidateCount` | candidates with ≥1 parseable record that reached the projection builder |
| `projectedCount` | sessions actually published (deduped); equals `sessions.observed` |
| `dropped[]` | per-candidate observed drop: `{ path, reason, nativeSessionId? }`; builder drops carry `missing[]` with every required binding that was absent |

Closed `dropped[].reason` vocabulary:

| Reason | Observed when |
|---|---|
| `no_transcript_match` | no file under the candidate matched the transcript glob |
| `no_records` | the matched transcript contained zero parseable records |
| `missing_native_session_id` | the id extractor produced no value |
| `missing_workspace` | the workspace extractor produced no value |
| `missing_created_at` | the createdAt extractor produced no value |
| `missing_updated_at` | the updatedAt extractor produced no value |
| `missing_required_evidence` | more than one required binding was missing; the full list is in `missing[]` |
| `duplicate_session` | another candidate with the same canonical id was already projected |

These reasons are debugging evidence, never a new verdict or reasonCode: the
automation signal stays the four verdicts and the §2.2 vocabulary.

---

## 5. Refusal semantics

A refusal records that an **existing authority** rejected a declaration; verify reports
it, it does not adjudicate it. `refusals[]` non-empty implies verdict `rejected`, and the
terminal refusal's `code` is mirrored in `reasonCode`. Each refusal is
`{ code, path, declared, reason, authority }`.

| `authority` | Refuses (typical `code`) |
|---|---|
| `spec.closed_keys` | unknown top-level key (`invalid_descriptor`) |
| `spec.cross_field` | capability/kind inconsistency, spec version mismatch (`invalid_descriptor`) |
| `spec.root_containment` | session root not anchored at `{home}` (`invalid_descriptor`) |
| `spec.extractor` | bad extractor shape (`invalid_descriptor`) |
| `install.builtin_guard` | a user descriptor claims a built-in type (`builtin_type`) |
| `compose.wiring` | a referenced reader does not exist or composition failed (`descriptor_adapter_missing`, `descriptor_composition_failed`) |
| `readers.containment` | unsafe home, or a session root escaped its home at read time (`unsafe_integration_root`, `session_root_outside_home`) |
| `readers.probe` | declared probe does not match the resolved home (`probe_mismatch`) |
| `verify.invariants` | a published session failed a projection invariant (`invariant_failure`) |

Projection invariants (closed): `native_session_id_present`, `created_at_parseable`,
`updated_at_parseable`, `workspace_resolved`.

Verdict precedence: parse failure → descriptor refusal → source rejection (unsafe/probe)
→ source unavailability → invariant failure on projection → `no_sessions` → `verified`.
Refusal outranks unavailability: a wrong descriptor is wrong whether or not the Agent is
installed.

---

## 6. Guarantees and non-guarantees

### 6.1 Guarantees

- **Read-only operation.** No write to the descriptor, the registry, the home, a cache,
  or a tombstone — including on failure.
- **No credential copying.** Credential stores are never read, copied, or inspected; no
  credential value can appear in the result.
- **No writes, no network, no Agent launch.** Verify never invokes a writing,
  credentialed, or network adapter method (`captureSession`, `generateHandoff`,
  `collectResourceSnapshot` are never called) and never launches or drives an Agent.
- **Source-backed evidence only.** `verified` means the session surface was observed on
  this machine through the host read path; a declaration is never evidence of itself.
- **Bounded work.** Verify cannot walk beyond the existing reader limits.
- The only subprocess spawned is `git rev-parse` for workspace identity, inherited from
  the projection path (fixed argv, no shell), with a per-workspace in-process cache.

### 6.2 Does not guarantee

- **Quota / usage correctness** — quota and usage readers are credential/network backed
  and are never exercised; those capabilities report `unavailable`.
- **Runtime lifecycle** — verify does not launch, pause, resume, or capture an Agent, and
  says nothing about whether the Agent process is running.
- **Unsupported capabilities** — handoff, resource-family, and write-path capabilities
  are not verified; an unsupported capability is never rendered as verified.
- **Layout durability** — it does not attest that a future Agent version keeps the
  observed layout, that the reader is complete (transcript diagnostics report observed
  drops but do not prove no candidate was missed; builtin readers emit no diagnostics),
  or that a manifest describing real files is *truthful* rather than merely *consistent*.
- A verdict is a point-in-time observation of mutable files, recomputed every run and
  never cached.

---

## 7. CLI

```
margin agent verify <descriptor.json|-> [--path <home>] [--json] [--sample <n>]
```

| Flag | Meaning |
|---|---|
| `<descriptor.json>` / `-` | manifest file path, or `-` for stdin (same input form as `install`) |
| `--path <home>` | explicit read path; still validated, probed, and containment-checked; recorded as `source.origin: "explicit"` |
| `--json` | emit the result document on stdout, nothing else |
| `--sample <n>` | published sessions whose invariants are checked and sampled (default 5, max 50); `observed` is always the full published count |

Exit codes: `0` verified · `2` no_sessions · `3` unavailable · `4` rejected · `1`
usage/IO. Shell automation should treat `verdict`/`reasonCode` in the JSON document as
authoritative and the exit code as a convenience.

### 7.1 Shell consumption

```sh
margin agent verify ./margin-agent.json --json > result.json
case $? in
  0) echo "verified" ;;
  2) echo "a reader ran and published zero sessions" ;;
  3) echo "session surface not observable on this machine" ;;
  4) echo "descriptor refused" ;;
  1) echo "usage or unreadable input" ;;
esac
```

---

## 8. Compatibility

The interface verifies descriptors only; it adds no Agent, no reader, and no descriptor
field. The shipped built-in Agents **Codex, Claude, and Pi** and the registered-plugin
path exercised by **Nova** remain on their existing adapters and continue to validate,
compose, and verify unchanged — the only additions are the explicit `reasonCode`, the
`not_applicable` probe state, the `sessions.kind: "none"` classification, and the
optional, additive `diagnostics` block (§4.7). OpenCode is not part of this interface.
