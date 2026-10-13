# `margin agent verify` — Design

Status: **Research / design only.** No code, no CLI command, no descriptor change, no new Agent support
in this slice. This document specifies the primitive; it does not implement it.
Version: `package.json` `0.1.0` (v0.1.0 Beta), commit `a3dafb4`, plus the untracked S10.2A artifacts.
Depends on: `agent-self-integration-validation.md` (S10.2A), `s10.1b-decision.md` (V4),
`margin-agent-integration-skill.md` §6, `agent-manifest-schema.md`, `integration-security-boundary.md`.
Evidence base: `test/agentSelfIntegration.test.js#verifyNovaIntegration` — the working reference
harness that assembled this primitive by hand and proved it necessary (S10.2A blocker **B2**).
No-go constraints honoured: no generated adapters, no plugin marketplace, no resource expansion, no
runtime execution model, no new `kind`, no descriptor field.

---

## 0. Why this exists

S10.2A proved that a synthetic Agent's descriptor composes, installs, probes, and projects real
session DTOs through the **current** protocol with zero core changes. It also showed that the
verification stage had to be hand-assembled from four internal calls:

```
resolveAgentHome  →  probeDescriptor  →  collectSessionSnapshots  →  manual invariant checks
```

That works inside a test and nowhere else. A user cannot ask "did this descriptor actually read my
machine?"; an installer cannot tell "no sessions yet" from "the home is gone" from "the declaration
is wrong"; and the future self-integration skill cannot be measured without a verb that produces the
measurement. `margin agent` today supports `list|detect|add|remove|enable|install|uninstall` — every
one of them either writes or reports registry state. There is no read-only verb that observes the
Agent's own store through the composed adapter.

**Definition.** `margin agent verify` is a **read-only, evidence-producing observation** that runs a
descriptor against this machine through the same adapter the hosts consume, and reports what was
observed versus what was merely declared.

It is not a validator (validation exists), not a dry-run install (that exists), and not a health
check. It is the missing instrument that turns "installed" into "observed".

---

## Design summary

| # | Brief item | Where | One-line answer |
|---|---|---|---|
| 1 | Verification boundary | §1 | Proves the descriptor is legal, satisfiable, attached to a real probe-passing home, and publishes ≥1 invariant-clean session; proves nothing about credentials, handoff, runtime, upstream stability, or completeness. |
| 2 | Lifecycle | §2 | `load → descriptor → installation → source → projection → result`, five side-effect-free stages, verdict computed by a fixed precedence. |
| 3 | Output schema | §3 | One versioned result document: per-capability `verified|unavailable|unsupported`, `refusals[]` with the authority that refused, `evidenceSources[]` read-scope manifest, and **no metric outside an evidence object**. |
| 4 | CLI behavior | §4 | `margin agent verify <manifest|-> [--path <home>] [--json] [--sample N]`; exit `0 verified`, `2 no_sessions`, `3 unavailable`, `4 rejected`, with `1` reserved for usage/IO as today. |
| 5 | V0.2 recommendation | §6 | Ship the verb as a thin read-only orchestrator over existing functions; do not grow the descriptor; keep the S10.2 §7 gate. |

---

## 1. Verification boundary

### 1.1 What `margin agent verify` proves

| # | Proven | Evidence that establishes it |
|---|---|---|
| P1 | The descriptor is **legal** under the shipped closed spec | `validateDescriptor` → `ok`, zero errors |
| P2 | Every declared `kind` is **satisfiable** — a reader exists for it | `compositionProblems` → empty (surfaced as `descriptor_adapter_missing` otherwise) |
| P3 | A declared home **exists on this machine**, is not the filesystem/profile root, and — when a probe is declared — matches its own probe | `resolveAgentHome` candidates with per-candidate `exists` / `unsafe` / `probe`; probe state recorded separately from the boolean |
| P4 | The **composed adapter — the same object the hosts consume** — reads this machine's real files and publishes at least one session with a non-empty `nativeSessionId`, parseable `createdAt`/`updatedAt`, and a resolved workspace | `readSessionSnapshots` envelope + the four projection invariants from the S10.2A harness |
| P5 | Each declared capability that is **observable without credentials, network, writes, or Agent runtime** was actually observed in the sample | per-capability status derived from wiring + observed values, never from `capabilities` alone (§3.4) |
| P6 | When the descriptor is installed, what was verified **matches what is installed** (canonically, formatting-insensitively) and the registry source is the one that was read | `installation.state: "installed_match"` (canonical digest) + source record |

P4 is the load-bearing one. P1–P3 are already available in combination through `install --dry-run`;
P4 is what no existing command does.

### 1.2 What it does **not** prove

Stated explicitly, because a verification command that hides its limits is worse than none.

| # | Not proven | Why | Where the honest statement lives |
|---|---|---|---|
| N1 | That the Agent will keep this layout in its next version | no upstream commitment exists | `notes[]`, `unverified` framing |
| N2 | That the reader is **complete** — that no session was silently dropped | `discoverTranscriptSessions` `continue`s past a missing transcript, empty records, or a `null` projection without recording why (B3/B5); verify sees only what was published | `sessions.observed` + the `no_sessions` diagnosis (§2.7) |
| N3 | That a `weak` binding is **correct**, only that it is **labelled** | `scanAbsolutePaths` and `mtime` are recoveries, not native facts; they are identifiable from the extractor `kind` without a schema change | `timestampSource` / `workspaceSource` fields |
| N4 | That credentials exist, are valid, or that quota/usage is real | verify never reads a credential store and never makes a network call | capability `unavailable` origin `not_exercised_by_verify` |
| N5 | That handoff works | `captureSession` / `generateHandoff` write; verify never invokes them | capability `unavailable` reason `write_path` |
| N6 | That the Agent is "supported" by Margin | parity with built-ins is explicitly not the goal (`margin-agent-integration-skill.md` §6) | `verdict` scope string |
| N7 | That no credential leaked into the manifest | that is a scan, not a verification; and even a scan is partial | out of scope; skill `report.redaction{}` + install-time scan |
| N8 | That the result is durable | a verdict is a point-in-time observation of mutable files | `generatedAt`, `sessions.revision`, `installation.match` |
| N9 | That the manifest is **truthful** | a dishonest manifest that happens to describe real files is indistinguishable from an honest one. Verify observes files, not intent | division of authority (§5) |

### 1.3 The five axes that must never be conflated

This is the core design requirement. Each axis has a different evidence source, a different
authority, and a different failure mode. Collapsing any two of them is the bug this design prevents.

| Axis | Question | Evidence | Authority | Failure verdict |
|---|---|---|---|---|
| **Descriptor validity** | Is this data a legal, satisfiable `specVersion: 1` descriptor? | `validateDescriptor` + `compositionProblems` + the builtin-type guard | `spec.js`, `compose.js`, `agentInstall.js` | `rejected` |
| **Installation validity** | Is this exact descriptor installed in the profile, and does the registry carry a source for its type? | `~/.margin/agents/<type>.json` presence + canonical digest; `readAgentSourceRegistry`; `descriptorProblems` | `load.js`, `sourceRegistry.js` | not a verdict — an `installation` fact |
| **Source availability** | Is there a real, safe, probe-passing home on this machine, and is the source usable? | `resolveAgentHome` candidates; `validateSource`; `probeDescriptor` | `readers.js`, `sourceRegistry.js` | `unavailable` (absent/disabled) or `rejected` (unsafe/probe mismatch) |
| **Session discovery** | Does the composed reader publish ≥1 invariant-clean session from that source? | `readSessionSnapshots` envelope + projection invariants | `compose.js`, `readers.js` | `no_sessions` / `rejected` / `unavailable` |
| **Capability availability** | For each declared capability, was it **observed**? | wiring + sample evidence | verifier (pure) | per-capability `unavailable`, never a silent `verified` |

Two rules follow directly:

* **Declaration is not evidence.** A capability is never `verified` because the descriptor says
  `true`; it is `verified` only when the sample observed it. §3.4 is the full derivation.
* **Absence has one meaning only.** "No home" is `unavailable`. "Home exists, probe passes, zero
  sessions" is `no_sessions`. "Home exists, probe fails" is `rejected`. "Declared `quota: true` with
  `resources.kind: none`" is a validation `refusal`. These are four different sentences, and a
  user-facing verification command must not say three of them the same way.

### 1.4 Operational boundary rules

These are invariants of the verb, not implementation preferences.

| # | Rule | Rationale |
|---|---|---|
| B-1 | **Never writes.** Not the descriptor, not the registry, not the home, not a cache, not a tombstone. No file is created anywhere, including on failure | `verify` is the non-mutating half of the integration loop; the S10.2A slice proved dry-run's no-write property and verify inherits it |
| B-2 | **Never invokes a writing or credentialed adapter method.** Safe set: `probe`, `readSessionSnapshots` (→ discovery), `getSessionRevision`. Never: `captureSession`, `generateHandoff`, `collectResourceSnapshot`, `readExecutionStatus` (it can read SQLite and spawn) | the resource readers are credential + network + interpretation; the handoff path distils and writes; none of that is verification |
| B-3 | **Never trusts the Agent's report.** The self-integration report is not an input to the verdict | §5 |
| B-4 | **Never invents a session.** A projection that fails an invariant is a failure, not a defaulted row | the existing `buildTranscriptSession` rule, restated for the report |
| B-5 | **Never guesses why a candidate was dropped.** If the reader did not say, verify does not infer | N2, §2.7 |
| B-6 | **Never emits a metric without evidence.** Every number lives inside an object with an `evidence[]`, or is a stage/session count tied to a named read | brief constraint "no metrics without evidence" |
| B-7 | **Reads through the host's own path.** Verification uses the composed adapter and the registered source, not a parallel reader; a divergent read path would verify something the product never uses | S10.2A harness comment: *"reads the resolved source exactly the way a host would, so verification never trusts in-memory state"* |
| B-8 | **Bounded work.** No descriptor can make verify walk beyond the existing reader limits (probe walk 512 files; per-session 4000 files, depth 12; 2000 sessions) | `readers.js` limits; a verification verb must not be a DoS surface |

### 1.5 Read scope and process effects (disclosure)

Verify is read-only, but it is not *passive*. Stated so no user is surprised by what a
"read-only" command touched:

| Effect | Cause | Bound |
|---|---|---|
| Reads the manifest bytes | input | one file |
| Reads `~/.margin/agents/*.json` and `agent-sources.json` | installation stage | profile-scoped |
| Walks candidate homes and the resolved home | `resolveAgentHome` + `probeDescriptor` | candidate paths + 512 files per probe walk |
| Reads transcript files | discovery | declared `sessions.roots`, 2000 sessions, 4000 files/session, depth ≤ 12 |
| **Spawns `git -C <cwd> rev-parse --show-toplevel`** | `resolveWorkspaceIdentity` inside `buildTranscriptSession`, once per distinct workspace (10 s in-process TTL cache) | not a verify choice; inherited from the existing projection path. Disclosed here and in the CLI header |

`git` is invoked with a fixed argument vector and no shell; it is a directory-identity probe, not an
Agent runtime. Verify must not add any process of its own.

---

## 2. Verification lifecycle

### 2.1 Stages

```
S0 load ─→ S1 descriptor ─→ S2 installation ─→ S3 source ─→ S4 projection ─→ S5 result
   │             │                 │                │              │
   │             └─ refusal ───────┘                └─ unavailable ┘
   │                                                       │
   └─ io error (exit 1)                                    └─ no_sessions / rejected
```

All stages are side-effect-free. S0–S3 are answerable with today's functions; S4 is the piece no
command currently exposes; S5 is pure assembly.

| Stage | Precondition | Action | Authority | Evidence produced | Terminal failure |
|---|---|---|---|---|---|
| **S0 load** | an argument was given | read `argv` manifest (file or `-` stdin), parse JSON | Margin CLI | `input.kind/path/sha256/type/label/specVersion` | usage error / unreadable input → exit `1`; parse failure → `rejected` |
| **S1 descriptor** | bytes parsed | `validateDescriptor`, `compositionProblems`, builtin-type guard | `spec.js`, `compose.js`, `agentInstall.js` | `errors[]`, `problems[]`, refusal entries | `rejected` |
| **S2 installation** | descriptor legal | find installed descriptor for `type`; canonical-digest compare; read registry source record; `descriptorProblems` for that type | `load.js`, `sourceRegistry.js` | `installation.state`, `match`, source id/path/enabled/suppressed | none — informational |
| **S3 source** | descriptor legal | `resolveAgentHome` over all candidates; choose the read path (explicit → registry → resolved); `validateSource`; probe **the path that will actually be read** | `readers.js`, `sourceRegistry.js` | every candidate `{env,path,exists,unsafe,probe}`; chosen `origin`; probe state | `unavailable` (no home / path invalid / source disabled) or `rejected` (unsafe home, probe mismatch) |
| **S4 projection** | source chosen | compose adapter (file mode: `composeAdapter`; installed mode: `adapterFor`), then `readSessionSnapshots` + `getSessionRevision`; check invariants on the sample | `compose.js`, `readers.js` | envelope result, `observed`, sample, `invariantFailures[]`, `revision` | `unavailable` (read error) / `rejected` (invariant failure) / `no_sessions` |
| **S5 result** | stages done | assemble document, compute verdict + exit code | verifier (pure) | the result document | — |

**Why S2 sits before S3.** Installation is a fact about the profile, not about the filesystem under
the Agent home, and it changes which source S3 must read. Ordering it earlier lets S3 prefer the
**registered** source path — the one Margin actually reads — over a descriptor-resolved candidate
that the user has overridden with `margin agent add --path`. Verifying a path the hosts do not read
would be a parallel truth.

**Why S3 must probe the chosen path.** `installAgentDescriptor` synthesises an explicit-path
candidate as `{ path, exists: true, probe: { valid: true, reason: null } }` without touching the
filesystem (`agentInstall.js`). That is acceptable for a dry-run *install* (the user asserted the
path), but it is not evidence. Verify must run `probeDescriptor` against the explicit path for real
and report `probeMismatch` if the declaration does not match the directory the user pointed at.

### 2.2 Verdict precedence

One deterministic order, so automation never has to interpret:

| Order | Condition | Verdict |
|---|---|---|
| 0 | missing argument, unknown flag, input not found / unreadable | *(no verdict)* |
| 1 | input is not parseable JSON | `rejected` |
| 2 | any refusal at S1 (validation, closed keys, cross-field, root containment, composition, builtin type) | `rejected` |
| 3 | ≥1 published session fails a projection invariant | `rejected` |
| 4 | no home resolved; chosen path is not a directory; registry source disabled or tombstoned; read error from the envelope | `unavailable` |
| 5 | home resolved, probe passed (or not declared), zero sessions published, no read error, no invariant failure | `no_sessions` |
| 6 | ≥1 invariant-clean session | `verified` |

Two deliberate choices:

* **Refusal outranks unavailability.** A descriptor with `capabilities.quota: true` and
  `resources.kind: "none"` is wrong whether or not the Agent is installed on this machine. Reporting
  `unavailable` would hide the actionable error.
* **A per-capability gap does not downgrade the verdict.** `executionStatus` declared `true` but never
  non-`unknown` in a small sample is reported as `unavailable` in the capability table, while the
  integration-level verdict stays `verified` if sessions were observed. Downgrading would make the
  verdict sample-dependent and therefore flaky. Automation that requires a specific capability reads
  the capability table, not the exit code. This mirrors the skill document's rule: `verified` means
  *"the declared session surface was observed"*, never *"this Agent is fully supported"*.

### 2.3 Finding — the probe boolean collapses three states into `true`

`probeDescriptor` returns `{ valid: true, reason: null }` for all of:

1. the probe ran and matched;
2. no probe was declared (`!probe?.anyOf?.length`);
3. no home was supplied (`!home`).

The verifier must therefore construct `source.probe.state ∈ { passed, failed, not_declared,
not_applicable }` from `descriptor.probe?.anyOf?.length` and the resolved home, and must never render
`valid: true` as "probe passed". A descriptor with no probe verifies on the strength of its extracts,
not on a structural hint it never wrote.

### 2.4 Finding — the envelope's error code is too coarse to classify a read failure

`compose.js#snapshotRead` catches every throw from discovery and returns
`{ ok: false, error: { code: 'source_read_failed', message } }` (or `source_unavailable` for an
invalid source path). But discovery throws **two behaviourally different things**:

* `source_read_failed` — a transient or unreadable file → `unavailable`;
* `session_root_outside_home` — a declared root escaped its home at read time (the R1 case the
  `{home}/../escape` fixture demonstrates) → must be `rejected`.

Today the second is reported with the first's code, so verify could only distinguish them by matching
the message string — which this design forbids (N-rule: no interpretation where a structured signal
exists). **V0.2 prerequisite (one line, additive):** preserve the thrown `error.code` in the envelope
(`code: error.code ?? 'source_read_failed'`). The message and all existing consumers are unchanged.

### 2.5 Finding — Margin-side identity is only meaningful once a source is registered

Canonical ids and the revision hash embed `sourceId`, which comes from the registry
(`canonicalId = type:sourceId:nativeSessionId`; `getSessionRevision` hashes
`source.sourceId ?? source.id`). A pre-install verify has no registered source, and `install
--dry-run`'s in-memory `sourceChange: "registered"` result is a *simulated* registration — using its
synthetic `sourceId` would publish an invented Margin identity as if it were real.

Rule: **pre-install verify reports Agent-native evidence (`nativeSessionId`, timestamps, workspace)
and omits `canonicalId` / `revision` with a reason (`no_registered_source`); post-install verify
reports them.** This is "native truth" applied to the result document.

### 2.6 What projection cannot explain (B3/B5, stated, not solved)

`discoverTranscriptSessions` silently skips a candidate when the transcript glob matches nothing,
when the file yields zero records, or when `buildTranscriptSession` returns `null` for a missing
required field. It returns only the survivors. Consequently:

* `sessions.observed` is **"what the reader published"**, not "what exists on disk";
* `no_sessions` is consistent with *both* "this Agent has never run on this machine" *and* "every
  candidate was dropped" — and verify is forbidden from guessing which (B-5).

The result must say exactly that, in the `no_sessions` diagnosis, and must not add a
`candidatesExamined` count it cannot obtain without changing the reader. Distinguishing the two is a
separate, human-gated decision (S10.2A blocker B3 / the V4 scope note in `s10.1b-decision.md` §5) and
is **not** part of this primitive's V0.2 scope (§6.4).

---

## 3. Output schema

### 3.1 Invariants of the schema

1. **Versioned and closed.** `resultVersion: 1`, strict equality, same discipline as `specVersion`.
2. **One document per invocation.** No append, no history, no cache, no state file.
3. **Evidence-local numbers.** Every numeric field lives inside an object that carries an
   `evidence[]`, or is a stage/session count whose single source is named in `evidenceSources[]`.
4. **Closed status enums.** `verdict`, capability `status`, capability `origin`, stage `status`,
   refusal `code`/`authority`, probe `state` are all closed.
5. **No scores.** No `score`, `percentVerified`, `health`, `severity`, `confidence`, or `supported`
   shortcut. A computed quality number is a metric without evidence and becomes permanent surface
   (the `attentionStatus` lesson, `agent-manifest-schema.md` §6.4).
6. **No content by default.** The sample omits `displayTitle`; `titlePresent` records only that a
   title extracted. Session titles are user content and verify output is routinely pasted into
   reports.

### 3.2 Envelope

The example below is the **post-install** case (what the S10.2A stage-5 harness produced). The
pre-install form differs only in `installation.state: "not_installed"`, an absent `installation.source`,
and `canonicalId` / `revision: null` (§2.5).

```jsonc
{
  "resultVersion": 1,
  "generatedAt": "2026-05-04T10:06:11.000Z",
  "tool": { "name": "margin", "version": "0.1.0", "command": "agent verify" },

  "input": {
    "kind": "file",                    // file | stdin
    "path": "D:\\Code\\margin\\margin-agent.json",
    "sha256": "3c1f…",                  // bytes as read
    "type": "nova",
    "label": "Nova",
    "specVersion": 1
  },

  "verdict": "verified",                // verified | no_sessions | unavailable | rejected
  "scope": "the verified input, read through its own declaration against this machine",
  "stages": [
    { "stage": "load",         "status": "passed", "errors": [] },
    { "stage": "descriptor",   "status": "passed", "errors": [] },
    { "stage": "installation", "status": "passed", "errors": [] },
    { "stage": "source",       "status": "passed", "errors": [] },
    { "stage": "projection",   "status": "passed", "errors": [] }
  ],

  "installation": {
    "state": "installed_match",        // installed_match | installed_mismatch | not_installed
    "descriptorPath": "C:\\Users\\<user>\\.margin\\agents\\nova.json",
    "descriptorSha256": "3c1f…",
    "descriptorDigest": "8ab0…",       // canonical (key-sorted, normalized) digest
    "source": { "sourceId": "nova-433633e38807", "path": "D:\\tmp\\nova-home",
                "enabled": true, "suppressed": false, "registryOrigin": "manual" }
  },

  "source": {
    "origin": "registry",              // explicit | registry | resolved
    "path": "D:\\tmp\\nova-home",
    "unsafe": false,
    "validate": { "valid": true, "reason": null },
    "probe": { "state": "passed", "reason": null },
    "candidates": [
      { "env": "NOVA_HOME", "path": "D:\\tmp\\nova-home", "exists": true, "unsafe": false,
        "probe": { "valid": true, "reason": null } },
      { "env": null, "path": "C:\\Users\\<user>\\.config\\nova", "exists": false, "unsafe": false,
        "probe": { "valid": false, "reason": "Path does not exist" } }
    ]
  },

  "sessions": {
    "observed": 2,
    "checked": 2,                      // ≤ --sample
    "revision": "9d0e…",              // 64-hex, null when no registered source
    "invariantFailures": [],
    "sample": [
      {
        "nativeSessionId": "nova-7f3a1c9e",
        "canonicalId": "nova:nova-433633e38807:nova-7f3a1c9e",
        "createdAt": "2026-05-04T09:12:33.000Z",
        "updatedAt": "2026-05-04T09:41:07.000Z",
        "timestampSource": "native",   // native | file-write-time | derived
        "workspaceSource": "native",   // native | recovered | derived
        "workspace": { "key": "git:d:/repo/margin-core", "name": "margin-core" },
        "executionStatus": "idle",     // unknown | working | idle | error
        "titlePresent": true,
        "evidence": [
          { "source": "transcript", "detail": "sessions/rollout_0001/events.jsonl: session.start#0.session.id" }
        ]
      }
    ]
  },

  "capabilities": [
    { "name": "sessions", "declared": true, "wiring": "transcript", "status": "verified",
      "evidence": [ { "source": "adapter", "detail": "readSessionSnapshots ok", "count": 2 } ] },
    { "name": "executionStatus", "declared": true, "wiring": "transcript", "status": "verified",
      "evidence": [ { "source": "transcript", "detail": "turn.assistant#last.finishReason → {idle,error}" } ] },
    { "name": "handoff", "declared": false, "wiring": "none", "status": "unsupported",
      "origin": "catalogue_boundary" },
    { "name": "apiUsage", "declared": false, "wiring": "none", "status": "unsupported",
      "origin": "catalogue_boundary" },
    { "name": "quota", "declared": false, "wiring": "none", "status": "unsupported",
      "origin": "catalogue_boundary" },
    { "name": "subscriptionQuota", "declared": false, "wiring": "none", "status": "unsupported",
      "origin": "catalogue_boundary" },
    { "name": "attentionStatus", "declared": false, "wiring": "none", "status": "unsupported",
      "origin": "no_reader" }
  ],

  "refusals": [],

  "evidenceSources": [
    { "kind": "manifest",   "path": "D:\\Code\\margin\\margin-agent.json", "sha256": "3c1f…" },
    { "kind": "registry",   "path": "C:\\Users\\<user>\\.margin\\agent-sources.json" },
    { "kind": "filesystem", "path": "D:\\tmp\\nova-home", "detail": "read scope: sessions.roots[0]" },
    { "kind": "probe",      "detail": "{home}/sessions/*/events.jsonl" },
    { "kind": "transcript", "path": "D:\\tmp\\nova-home\\sessions\\rollout_0001\\events.jsonl" }
  ],

  "notes": []
}
```

### 3.3 Field rules

| Field | Rule |
|---|---|
| `input.sha256` | byte hash of the input as read; audit only, never used for the match decision |
| `installation.state` | `installed_match` = a descriptor exists for `type` and its **canonical** digest equals the input's; `installed_mismatch` = exists, digest differs; `not_installed` = none. (A built-in type never reaches here — S1 refuses it; see `install.builtin_guard`.) |
| `installation.descriptorDigest` | `sha256(JSON.stringify(normalizeDescriptor(descriptor), sortedKeys))` — formatting-insensitive, so a re-formatted but semantically identical file does not read as a mismatch |
| `source.origin` | `explicit` (`--path`) > `registry` (installed source) > `resolved` (descriptor candidate). The read path is always the highest-precedence available one |
| `source.probe.state` | `passed` \| `failed` \| `not_declared` \| `not_applicable` — never the raw boolean (§2.3) |
| `sessions.observed` | sessions the adapter **published**; not an on-disk count (N2) |
| `sessions.checked` | `min(observed, --sample)`; invariants are asserted per checked session |
| `sessions.revision` | adapters' real revision when a source is registered, else `null` + reason in `notes[]` (§2.5) |
| `sessions.sample[].timestampSource` | derived from the `createdAt`/`updatedAt` extractor `kind`: `record` → `native`, `mtime` → `file-write-time`, any other kind → `derived`. No new descriptor field; the truth is already in the data |
| `sessions.sample[].workspaceSource` | derived from the `workspace` extractor `kind`: `record` → `native`, `scanAbsolutePaths` → `recovered`, any other kind → `derived` |
| failure document | when S0 fails to parse, the document is still emitted with `input.type/label/specVersion: null`, `verdict: "rejected"`, `stages[0].status: "failed"` and the parser message in `stages[0].errors`; later stages are `skipped` and the typed blocks (`installation`, `source`, `sessions`, `capabilities`) are omitted rather than zero-filled |
| `capabilities[].wiring` | the section `kind` that would deliver it, or `none` |
| `evidenceSources[]` | the read-scope manifest — what this invocation actually touched, bounded by the sample |

### 3.4 Capability status derivation (the anti-blind-trust rule)

Evaluated per name in the closed vocabulary
`AGENT_CAPABILITIES = [sessions, handoff, apiUsage, quota, executionStatus, attentionStatus, subscriptionQuota]`.
Status is a **function of wiring + observation**, and the declared flag appears only as an input
(`declared`), never as the output.

| Condition | `status` | `origin` / reason |
|---|---|---|
| `declared === false`, a legal declarative form exists but was not claimed | `unsupported` | `declared_false` |
| `declared === false`, no legal declarative form exists for this Agent (resource family, handoff) | `unsupported` | `catalogue_boundary` |
| `declared === false`, no reader has ever produced it (`attentionStatus`) | `unsupported` | `no_reader` |
| `declared === true`, `sessions.kind: "transcript"`, name `sessions`, ≥1 invariant-clean session | `verified` | evidence: envelope `ok` + count |
| `declared === true`, name `executionStatus`, `executionStatus.kind: "transcript"`, ≥1 sampled status ≠ `unknown` | `verified` | evidence: observed raw values mapped to the closed status enum |
| `declared === true`, name `executionStatus`, all sampled statuses `unknown` | `unavailable` | `not_observed_in_sample` |
| `declared === true`, name `executionStatus`, only possible source is `readExecutionStatus` (builtin enrichment) | `unavailable` | `not_exercised_by_verify` — B-2 forbids the call |
| `declared === true`, resource family, `resources.kind: "builtin"` | `unavailable` | `not_exercised_by_verify` — credentialed/network reader (N4) |
| `declared === true`, `handoff.kind: "builtin" \| "shared-codex"` | `unavailable` | `write_path` — capture distils and writes (N5) |
| `declared === true`, source unreachable | `unavailable` | `source_unreachable` (the whole result is `unavailable`) |
| `declared === true`, wiring `none` | — | impossible after S1; the validator refuses it (e.g. `capabilities.quota is true but resources.kind is none`) |
| `subscriptionQuota` declared `true` by a user manifest | `unavailable` | `not_exercised_by_verify`; note the `agent-manifest-schema.md` §6.3 proposal to make this a refusal, since Pi sets the flag from a *reader result*, not a declaration |

`capabilities` (source level) yields statuses. `sessionCapabilities` is projected into the sample
DTOs as data and never conflated — Claude's source `handoff: false` / session `handoff: true` split is
pre-existing product behaviour (`agent-capability-matrix.md` §3.1).

### 3.5 Refusals — refused unsafe declarations

A refusal is a declaration an **existing authority** rejected. Verify records it; it does not judge
it. `refusals[]` non-empty ⇒ verdict `rejected`.

```jsonc
{
  "code": "invalid_descriptor",
  "path": "capabilities.quota",
  "declared": true,
  "reason": "capabilities.quota is true but resources.kind is none; declare a resource reader that can deliver it",
  "authority": "spec.cross_field"
}
```

| `authority` | Refuses |
|---|---|
| `spec.closed_keys` | unknown top-level key (with the edit-distance suggestion already produced) |
| `spec.cross_field` | capability/kind inconsistency (`handoff`, `executionStatus`, resource family), `specVersion` mismatch |
| `spec.root_containment` | `sessions.roots[i]` not anchored at `{home}` or beneath it |
| `spec.extractor` | bad extractor shape, unknown `kind`, non-literal `where`, bad `pick`/`index` |
| `compose.wiring` | `descriptor_adapter_missing` — a referenced reader does not exist |
| `install.builtin_guard` | a user descriptor claims a built-in `type` |
| `readers.containment` | `session_root_outside_home` thrown at read time |
| `readers.probe` | declared probe does not match the resolved home |
| `verify.invariants` | a published session failed a projection invariant |

Projection invariants (closed, identical to the S10.2A harness):

| Invariant | Check |
|---|---|
| `native_session_id_present` | `nativeSessionId` non-empty |
| `created_at_parseable` | `Number.isFinite(Date.parse(createdAt))` |
| `updated_at_parseable` | `Number.isFinite(Date.parse(updatedAt))` |
| `workspace_resolved` | `workspaceKey` and `workspaceName` both non-empty |

Deliberately **not** an invariant: `updatedAt >= createdAt`. It is a useful observation, but making it
a rejection would add a judgment the readers do not currently make. Out of V0.2 scope.

### 3.6 Evidence sources

Each `evidence` entry names a closed source kind and a human-readable locator:

| `source` | Meaning |
|---|---|
| `manifest` | the verified input document |
| `registry` | `agent-sources.json` / installed descriptor |
| `filesystem` | a directory read (home, root, session dir) |
| `probe` | the descriptor's declared structural check |
| `transcript` | a record read from an Agent file |
| `adapter` | the composed adapter's own envelope (e.g. `readSessionSnapshots` returning `ok`) |

Rule: a number may appear only inside an object carrying at least one such entry. `sessions.observed`
carries `{source: "adapter", detail: "readSessionSnapshots ok", count}`; capability counts likewise.

### 3.7 Deliberate omissions from the schema

| Omitted | Why |
|---|---|
| score / percentage / grade | metrics without evidence; permanent surface |
| per-capability `supported: true` | duplicates `status` with a false sense of authority |
| `candidatesExamined` for dropped sessions | not obtainable without a reader change; inventing it violates B-5 |
| session titles and full message content | content, not verification evidence; `titlePresent` is the structural fact |
| timestamps of the Agent's own claims | those belong to the skill's report, not Margin's observation |
| any cached/previous result | §3.1 rule 2 — a verdict is a point-in-time observation |
| a `fixed:`/`repair` hint | verify proposes nothing; the refusal message already names the authority |

---

## 4. CLI behavior

### 4.1 Surface

```
margin agent verify <descriptor.json|-> [--path <home>] [--json] [--sample <n>]
```

| Argument / flag | Meaning |
|---|---|
| `<descriptor.json>` | the manifest to verify — the same file shape `install` consumes, read the same way (`-` = stdin, matching `install`) |
| `--path <home>` | explicit read-path override for machines where the Agent home is non-standard; still probed, still containment-checked, recorded as `source.origin: "explicit"` |
| `--json` | emit the §3 result document on stdout; nothing else on stdout |
| `--sample <n>` | number of published sessions whose invariants are individually checked and whose sample rows are emitted. Default 5, max 50. `sessions.observed` is always the full published count |

One input form covers both moments of the integration loop:

* **before install** — `margin agent verify ./margin-agent.json` reads the file's declaration against
  this machine and reports `installation.state: "not_installed"`; no Margin-side identity is claimed
  (§2.5);
* **after install** — `margin agent verify ~/.margin/agents/nova.json` reports
  `installation.state: "installed_match"` and reads through the registered source, so the verdict
  applies to the integration the product will actually use.

A `margin agent verify --type nova` convenience (resolve the installed descriptor by type) is
**not** in V0.2: it is sugar over the second form and adds a second resolution path to document and
test.

### 4.2 Exit codes

| Exit | Verdict | Automation meaning |
|---|---|---|
| `0` | `verified` | ≥1 invariant-clean session published; safe to treat the session surface as observed |
| `2` | `no_sessions` | reachable source, zero published sessions — "installed but not yet attached" is a legitimate state; **not** an error and **not** verified |
| `3` | `unavailable` | no home / path invalid / source disabled / read error — the descriptor may be perfectly legal; there is nothing to read here (or reading it failed) |
| `4` | `rejected` | the declaration is illegal, unsatisfiable, unsafe, mismatched with the home, or produced an unprojectable session — fix the descriptor, not the machine |
| `1` | *(no verdict)* | usage error (missing argument, unknown flag) or unreadable/absent input — the existing `margin agent` convention, unchanged |

Design notes:

* The four verdict codes are a **closed set**; every possible outcome maps to exactly one, by the
  precedence in §2.2.
* `1` is deliberately kept for "we never got to a verdict". It matches every other `margin agent`
  command, which returns `0`/`1` only.
* `2` is conventionally "misuse" in some POSIX tools; Margin already uses `1` for that, and the
  authoritative value is `verdict` in the `--json` document. The exit code is a shell convenience.
* Verify adds codes; it does not change the exit codes of `install`, `uninstall`, `list`, or any
  other existing command.

Shell consumption:

```sh
margin agent verify ./margin-agent.json --json > result.json
case $? in
  0) echo "verified" ;;
  2) echo "reachable, zero sessions" ;;
  3) echo "nothing to read on this machine" ;;
  4) echo "descriptor refused or unprojectable" ;;
  1) echo "usage or unreadable input" ;;
esac
```

### 4.3 Human output (default)

Short, staged, and free of any claim verify did not observe:

```
verify  nova  (Nova)  specVersion 1
input   D:\Code\margin\margin-agent.json  sha256 3c1f…  (not installed)

  descriptor    passed    1 root, 2 extractors, 0 refusals
  installation  not_installed
  source        passed    NOVA_HOME → D:\tmp\nova-home   probe passed   2 candidates
  projection    passed    2 sessions observed, 2 checked, revision 9d0e…

capabilities
  sessions            verified     2 observed
  executionStatus     verified     idle, error observed
  handoff             unsupported  declared false (no declarative form)
  quota               unsupported  declared false (no declarative form)
  apiUsage            unsupported  declared false (no declarative form)
  subscriptionQuota   unsupported  declared false (no declarative form)
  attentionStatus     unsupported  no reader exists

evidence  manifest, registry, filesystem, probe, transcript
```

For `no_sessions`, the projection line must carry the limitation, not a guess:

```
  projection    passed    0 sessions observed
  diagnosis     the home exists and the probe passed, but the reader published nothing.
                This is consistent with "no sessions yet" and with "every candidate was
                dropped"; verify cannot distinguish them (no drop reasons are produced).
```

### 4.4 Read-only guarantees stated by the command

`margin agent verify --help` must state, in the style of `agentInstall.js`'s header: no writes
anywhere; no network; no credential read; no Agent launch; the only subprocess spawned is
`git rev-parse` as part of session workspace identity, inherited from the projection path (§1.5).

### 4.5 Non-commands

Named so they are decisions, not omissions:

| Not added | Why |
|---|---|
| `--install` / `--fix` / `--repair` | verify observes; install is a separate, user-confirmed step |
| `--watch` / `--interval` | Margin polls by revision and has no watcher; a verifying watcher is a monitoring product |
| `--require <capability>` | a flag per capability is unbounded surface; automation reads the capability table in `--json` |
| `--report <path>` | verify never writes; shell redirection is the mechanism |
| signing / attestation of the result | a signature proves who ran verify, not what was observed |

---

## 5. Relation with the future Agent Self-Integration Skill

### 5.1 Claims versus observations

The skill produces two artifacts (`margin-agent-integration-skill.md` §5):

* `margin-agent.json` — the **declaration**;
* `margin-agent.report.json` — the Agent's **claims**, each `observed | weak | unverified | refused`.

`margin agent verify` produces a third artifact: Margin's **observations**. The relationship is:

```
Agent (claims)                         Margin (authority)
  self-inspection                       validate → compose → resolve → probe → project → verdict
  manifest  +  report   ──────────────▶  verify  ──▶  result document
       untrusted                             trusted, but time-scoped and read-scoped
```

`verify` is exactly the "Stage 3 — Observation" the skill document proposed but never implemented. It
completes the division of labour table in that document; it does not extend the protocol.

### 5.2 The rule that keeps the Agent from being trusted blindly

**No field of the Agent's report is an input to the verdict.** Concretely:

| Rule | Effect |
|---|---|
| R-1 The report is not parsed for status | an Agent cannot promote its own `unverified` claim to `verified` |
| R-2 The manifest's `capabilities` are inputs to `declared` only | a `true` claim with no observation lands `unavailable`, never `verified` |
| R-3 Refusals are produced by Margin's existing checks, with the refusing authority named | the Agent cannot grade its own homework, and the user can see *which* rule fired |
| R-4 A `weak` binding is surfaced as `timestampSource: "file-write-time"` / `workspaceSource: "recovered"` | the Agent's honesty about a recovery is independently re-derived from the extractor `kind`; a claim of `native` on an `mtime` extractor is contradicted by the data |
| R-5 The verdict is recomputed on every invocation and never cached | a past verification cannot be replayed against a changed machine |
| R-6 The skill may ship the manifest and report separately; verify works without the report | a missing report never fails verification, and a malicious report never changes it |

The strongest available cross-check today is **the file-level one**: the manifest is verified against
the real machine, so an over-claim shows up as `unavailable`, a wrong binding shows up as
`rejected`/`no_sessions`, and an unsafe declaration shows up as a `refusal` with the authority named.
What cannot be cross-checked is intent (N9) — and that is stated rather than papered over.

### 5.3 The integration loop with verify at both ends

```
1. Agent runs SKILL.md                      (read-only, no network, no credential values)
2. Human reviews margin-agent.report.json   (untrusted claims; where the Agent was unsure)
3. margin agent verify <manifest>           (Margin's observation; pre-install)
4. margin agent install <manifest> --dry-run
5. margin agent install <manifest>
6. margin agent verify ~/.margin/agents/<type>.json
                                            (installation.state: installed_match;
                                             reads through the registered source)
```

Step 3 answers "does this declaration read this machine?" before anything is written. Step 6 answers
"is what is installed what was verified, and does the registered source still read?" The bridge is
`input.sha256` / `installation.descriptorDigest`: a mismatch between 3 and 6 is *detected*, not
assumed away.

### 5.4 How verify interacts with the S10.2A blockers

| Blocker | Interaction |
|---|---|
| **B1** — `generatedBy` / `runtime` documented but refused by the shipped spec | Verify must not create pressure to ship them. The result's `installation.descriptorDigest` gives provenance binding later, if `generatedBy.reportSha256` is ever implemented, without verify reading the report. Until then the skill emits **current keys only**. |
| **B2** — no read-only verification verb | This document is that verb's design. |
| **B3** — a header outside the transcript is not expressible; sessions can drop silently | Verify **exposes** the boundary: `no_sessions` is reported with both possible causes, and no `candidatesExamined` field is invented (§2.6). It does not fix B3. |
| **B4** — evidence has nowhere to live in the descriptor | Correct split, now explicit: the **descriptor** carries only executable claims; the **report** carries the Agent's evidence; the **verify result** carries Margin's evidence. None of the three absorbs another. |

---

## 6. V0.2 recommendation

### 6.1 Scope

**Ship** one new read-only verb, V0.2-V:

* the five stages of §2, using existing functions only;
* the §3 result document and `--json`;
* the §4 exit codes;
* tests: one positive (a Nova-equivalent fixture), one per verdict (`no_sessions`, `unavailable`,
  `rejected`), one refusal-carrying case, one no-write assertion, one installed/post-install case.

**Do not ship, in the same change:** any descriptor field; any new extractor `kind`; any capability
flag; any caching/persistence of results; any watcher; any capability inference; any change to the
built-in readers.

### 6.2 Implementation shape (reuse list)

| Need | Existing function |
|---|---|
| read file / stdin | `readDescriptorArgument` (`cli/agentSourceCli.js`) |
| S0–S3 evidence, builtin guard, candidate report, no writes | `installAgentDescriptor({ dryRun: true })` (`agentInstall.js`) — the same authority `install` uses, so validation cannot drift |
| installation + source state | `descriptorDirectory`, `resetDescriptorCache`, `readAgentSourceRegistry`, `validateSource` |
| file-mode composition (not yet installed) | `composeAdapter` (`descriptor/compose.js`) with `detect`/`validateSource` |
| installed-mode composition | `adapterFor` (`agents/adapters.js`) |
| probe / read / revision | `adapter.probe`, `adapter.readSessionSnapshots`, `adapter.getSessionRevision` |
| invariants | new, ~20 lines, mirroring `verifyNovaIntegration` |

The S10.2A harness (`test/agentSelfIntegration.test.js#verifyNovaIntegration`) is the working
reference for the S4 step and should be refactored to call the new function so the fixture keeps
testing the shipped path.

One trap in reusing the dry-run for S0–S3: **do not forward `--path` into
`installAgentDescriptor({ path })`.** Its explicit-path branch fabricates
`{ exists: true, probe: { valid: true } }` without touching the filesystem, so forwarding the flag
would silently defeat P-2/P-3 (§6.3). Verify passes `path: null` to the dry-run and applies `--path` itself
in S3, with a real `validateSource` + `probeDescriptor` and `source.origin: "explicit"`.

### 6.3 Small prerequisites (each one line, each additive)

| # | Change | Why |
|---|---|---|
| P-1 | `snapshotRead` preserves `error.code` from the thrown error | otherwise `session_root_outside_home` is indistinguishable from a transient read failure (§2.4) |
| P-2 | Verify derives its own probe `state` rather than consuming `probeDescriptor`'s boolean | the boolean is `true` for "not declared" and "no home" (§2.3) |
| P-3 | Verify probes an explicit `--path` instead of reusing install's synthetic `{ exists: true, probe: { valid: true } }` candidate | an assertion is not evidence (§2.1) |

None of these touches the descriptor schema, the reader catalogue, or any built-in.

### 6.4 Explicit non-goals (V0.2)

* No generated adapters, no plugin marketplace/index/fetch.
* No resource expansion: verify never reads credentials, never calls a quota/usage endpoint, never
  renders a resource metric.
* No runtime execution model: verify never launches, drives, pauses, or captures an Agent.
* No drop-reason channel in `discoverTranscriptSessions` (B3/B5). If the first real Agent needs it,
  that is a **human decision** to add one reviewed diagnostic — never a stronger DSL.
* No `generatedBy` / `runtime` in the descriptor; the skill keeps emitting current keys (B1).
* No change to any exit code of an existing command.

### 6.5 Human decisions that remain open

| Decision | Owner | Default if nobody decides |
|---|---|---|
| Keep the §7 gate ("one real Agent, unaided") before treating self-integration as a capability | product/human | the verb ships as an instrument; the skill stays documentation-only |
| Whether B3 warrants one declarative primitive or a built-in reader | human, per `s10.1b-decision.md` §10 | not built; `no_sessions` keeps both causes visible |
| Whether `subscriptionQuota: true` in a user manifest becomes a refusal (schema §6.3 proposal) | human | verify reports `unavailable`, the validator stays as shipped |
| Whether the sample may include session titles behind an opt-in | human | titles omitted; `titlePresent` only |

### 6.6 Reversibility

| Change | Reversible? |
|---|---|
| The verb (one CLI branch + one module) | Yes — trivially; read-only, no persistent state |
| The result document | Yes — an output artifact, versioned `resultVersion`, consumed by nothing yet |
| P-1 (envelope code passthrough) | Yes — additive field, existing consumers unchanged |
| Any future descriptor field or reader `kind` | **No** — permanent surface, human-gated |

### 6.7 The one-sentence recommendation

> Implement `margin agent verify` in V0.2 exactly as a read-only orchestrator over
> `installAgentDescriptor({dryRun:true})` + `composeAdapter` + `probe` + `readSessionSnapshots` +
> four invariants, emitting the §3 document and the §4 exit codes; make it the measurement instrument
> for the S10.2 real-Agent spike; and let no part of this design grow the descriptor, the reader
> catalogue, or the capability vocabulary.

---

## 7. References

| File | Role in this design |
|---|---|
| `docs/research/agent-self-integration-validation.md` | S10.2A result; B2 (missing verb), B3 (catalogue boundary), B4 (evidence location); the harness being formalised |
| `docs/research/s10.1b-decision.md` | V4 definition; §7 gate; §10 "new `kind` is a human decision" |
| `docs/research/margin-agent-integration-skill.md` §6 | the three validation stages; the `verified / no_sessions / unavailable / rejected` vocabulary this design reuses verbatim; what stages cannot validate |
| `docs/research/agent-manifest-schema.md` | closed keys, cross-field rules, root containment, the `attentionStatus` lesson, the "no capability flag without a reader" rule |
| `docs/research/integration-security-boundary.md` | why verify must never touch credentials, network, or writes |
| `src/agents/descriptor/spec.js` | `validateDescriptor`, `DESCRIPTOR_TOP_LEVEL_KEYS`, cross-field refusals |
| `src/agents/descriptor/readers.js` | `resolveAgentHome`, `probeDescriptor`, `discoverTranscriptSessions`, `isPathContained`, read limits |
| `src/agents/descriptor/compose.js` | the ten-method contract, `snapshotRead` envelope, `compositionProblems` |
| `src/agents/agentInstall.js` | the dry-run authority, the explicit-path synthetic candidate |
| `src/agents/sourceRegistry.js` | `validateSource`, `AGENT_CAPABILITIES`, registry source shape |
| `src/cli/agentSourceCli.js` | argument reading, output conventions, the existing `0/1` exit contract |
| `test/agentSelfIntegration.test.js` | `verifyNovaIntegration` — the reference harness |
