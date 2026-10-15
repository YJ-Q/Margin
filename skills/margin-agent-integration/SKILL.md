# Margin Agent Self-Integration Skill

**Version 0.1.1** — refinement of the first shipped artifact of the researched Integration Skill
concept (`docs/research/margin-agent-integration-skill.md`), reconciled with the **shipped**
descriptor contract (`src/agents/descriptor/spec.js`, `DESCRIPTOR_SPEC_VERSION = 1`). v0.1.1
replaces the first-line-only sampling rule with bounded sampling windows (Step 1/2) and documents
the optional `diagnostics` block of `margin agent verify` (§5). The descriptor contract is
unchanged.

This skill is a **read-only self-inspection procedure**. A coding agent executes it inside its own
environment and emits two files:

```
<out>/margin-agent.json          the manifest     — a Margin Agent Descriptor, current keys only
<out>/margin-agent.report.json   the report       — the evidence for every claim in the manifest
```

The schemas check structure; `validateDescriptor` and `margin agent verify` remain authoritative
for semantic acceptance and observed sessions. A schema-valid report, including `redaction{}`,
is self-reported evidence for review, not a privacy attestation.

Both files are **data**. Nothing this skill produces is executed by Margin, and nothing in this skill
writes outside the scratch output directory `<out>`. Installation is a separate, user-confirmed step
(`margin agent install <manifest> --dry-run` first) that this skill never performs.

---

## 1. Non-negotiable rules

These are stated first because every step below is subordinate to them. A step that cannot be
completed under these rules is a **reported gap**, never a skipped step with a default.

1. **Read-only.** Never write outside `<out>`. Never write to `~/.margin/**` or to the Agent's own
   home. Listing, stat-ing, and reading a **bounded sample** of records (the windows defined in
   Step 1) are allowed; mutating, moving, renaming, or deleting anything is not.
2. **No network.** This skill never fetches, registers, uploads, or telemetry-pings. No HTTP call of
   any kind. No endpoint is ever contacted.
3. **Credentials must never be copied or exposed.** In the manifest, in the report, in command
   output you quote, in hashes, anywhere. Existence, path, and key **name** may be reported; the
   value may not. A hash of a short secret is a secret — hashing is not redaction. Prove compliance
   in `report.redaction{}`.
4. **No executable content, ever.** The manifest is data. Never emit code, a patch, a script, a
   hook, a driver, or a "run this to finish setup" snippet. If a capability needs code, the correct
   output is `false` plus a `requests[]` entry in the report.
5. **Declaration is not evidence; verify is required.** Writing a manifest is a claim, not a proof.
   Before the task is complete, the emitted manifest MUST be run through `margin agent verify` (see
   §5) and the verdict reported. A capability is never "supported" because the manifest says so; it
   is supported only when the verification sample observed it.
6. **No claim without an observation.** Every `true` capability must cite the file, record, and
   field that produced it. Every unverified capability must be `false`, never `true`-pending.
7. **No invented values.** If a session cannot be projected with a real id, a real workspace, and
   real timestamps, it is not a session — omit it. Never fill a default to make a count look real.
   Never name an environment variable you did not observe; never choose a path because it is
   conventional.

---

## 2. The descriptor contract — current keys only

The manifest is the **existing Agent Descriptor Spec** (`spec.js`). The top-level key set is
**closed**: an unknown key is a validation error with a suggestion, not a silently ignored field.
The skill emits **only** the keys below. Do not add keys, even if a research document proposes them.

### 2.1 Top-level keys — exactly these 19 (`DESCRIPTOR_TOP_LEVEL_KEYS`)

| Key | Required | Type / rule |
|---|---|---|
| `specVersion` | ✅ | integer, must equal `1` |
| `type` | ✅ | string, `^[a-z][a-z0-9_-]{1,31}$`; must not be a built-in type |
| `label` | ✅ | non-empty string (display name) |
| `provider` | — | non-empty string or `null` |
| `resourceAgent` | — | non-empty string; defaults to `type` |
| `defaultSourceName` | — | non-empty string; defaults to `label` |
| `quotaPrefix` | — | non-empty string or `null`; presentation only |
| `envHome` | — | non-empty string: the env var that selects the Agent home |
| `order` | — | finite number; defaults to `1000` |
| `supportLevel` | — | display string; **not** a capability, never parsed for behaviour |
| `defaultHome` | — | object `{ env?, fallback }` — single-candidate shorthand |
| `homeCandidates` | — | non-empty array of `{ env?, fallback }`, ordered, tried in order |
| `capabilities` | — | object of the 7 capability booleans (see 2.2) |
| `sessionCapabilities` | — | object of the same 7 booleans (per-session surface) |
| `sessions` | ✅ | object; see 2.3 |
| `executionStatus` | — | object; see 2.3 |
| `probe` | — | `{ "anyOf": [{ "glob": … }] }`, non-empty |
| `resources` | — | object; see 2.3 |
| `handoff` | — | object; see 2.3 |

`$comment`-prefixed keys (`$comment`, `$comment_session`, …) are reserved at **any** level and are
always ignored — you may use them to annotate your own manifest.

### 2.2 Capability flags — exactly these 7 (`DESCRIPTOR_CAPABILITIES`)

```
sessions, handoff, apiUsage, quota, executionStatus, attentionStatus, subscriptionQuota
```

A capability flag may only be `true` when the declared wiring can deliver it (see 2.5). For a
self-integrated Agent, the flags that no declarative form can serve must be `false` — **declared
unsupported**, with the knowledge moved to `report.requests[]` as a documented gap, never a metric.

### 2.3 Closed section kinds

| Section | `kind` values |
|---|---|
| `sessions.kind` | `builtin` \| `transcript` \| `none` |
| `resources.kind` | `builtin` \| `none` |
| `handoff.kind` | `none` \| `builtin` \| `shared-codex` |
| `executionStatus.kind` | `none` \| `transcript` \| `builtin` |
| `executionStatus` value vocabulary | `unknown` \| `working` \| `idle` \| `error` |
| `executionStatus.pick` | `first` \| `last` |
| `sessions.transcript.format` | `jsonl` |
| `sessions.layout` | `directory-per-session` \| `file-per-session` |
| `sessions.title.as` | `native` \| `metadata` \| `first-user-message` |

A `builtin` kind names a reader Margin ships. A self-integrated Agent is never `builtin` — it must
use `transcript` (its own plain-text store) or `none`.

### 2.4 The extractor catalogue — the whole vocabulary for `sessions`

| `kind` | Parameters | Meaning |
|---|---|---|
| `directoryName` | none | the session directory's name |
| `filename` | none | the transcript file's basename |
| `mtime` | `glob` (required), `pick: max\|min` | filesystem mtime — **file-write time, not session time**; a weaker claim, label it `weak` in the report |
| `record` | `where` (literal equalities only), `index` (non-negative int or `"last"`), `path` (dotted), `maxLength` (positive int) | a dotted field from the Nth (or last) matching JSONL record |
| `scanAbsolutePaths` | `parentOf` (bool), `requireMarker` (string\|null) | recover a workspace from absolute paths in transcript text — the fallback **after a bounded native-field window found no cwd** (Step 2); never chosen over a native cwd field, and labelled `weak` |

`id`, `createdAt`, `updatedAt` are **required** extractors for a `transcript` session store;
`workspace`, `title`, `model`, `provider` are optional (`null` is allowed and means "no binding —
do not infer").

Substitutions in path templates: exactly `{home}` and `{profile}`, plus `%ENV:NAME%` (an
environment variable read **into a path** — never a value channel). An unknown substitution token is
a validation error.

Every `sessions.roots[i]` must be `{home}` or a path beneath it — reads stay inside the Agent home.

### 2.5 Cross-field consistency — every one of these is a validation error

Run these against your draft before emitting (this is Stage 1, §4):

1. `capabilities.handoff === true` requires `handoff.kind !== "none"`.
2. `handoff.kind` of `builtin` or `shared-codex` requires `sessions.kind === "builtin"`.
3. `resources.kind === "builtin"` requires `sessions.kind === "builtin"`.
4. `sessions.kind === "builtin"` requires `capabilities.sessions !== false`.
5. `capabilities.executionStatus === true` requires `executionStatus.kind === "transcript"` (or a
   built-in reader — impossible for a self-integrated Agent).
6. `executionStatus.kind === "builtin"` requires `sessions.kind === "builtin"`.
7. `executionStatus.kind === "transcript"` requires `sessions.kind === "transcript"`.
8. `capabilities.quota === true`, `capabilities.apiUsage === true`, or
   `capabilities.subscriptionQuota === true` requires `resources.kind !== "none"`.

For a self-integrated Agent, rules 2, 3, 6 can never be satisfied — so `handoff`, `resources`, and
the resource-family capabilities are `none`/`false`, with the reasons recorded in the report.

### 2.6 Keys you must NOT emit

The current validator **refuses** these as `unknown top-level key`. Do not emit them, in any
version, until a future spec version ships them:

| Key | Why it is refused today |
|---|---|
| `generatedBy` | research-only; not in the shipped key set |
| `runtime` | research-only; no runtime contract exists |
| `agent` | research-only; not in the shipped key set |
| any other new top-level key | the key set is closed by design |
| `capabilities.runtimeControl` | not a known capability flag |
| any other new capability flag | the vocabulary is frozen at the 7 flags |

The validator's error looks like `unknown top-level key "generatedBy"` — with an edit-distance
suggestion for typos (`"resource"` → `did you mean "resources"?`). A skill-following manifest never
triggers it.

---

## 3. The six steps

Each step has a required output. A step that cannot be completed is a **reported gap** — record it
in `report.claims[]`/`report.unverified[]` with the reason.

### Step 0 — Resolve my own home

Read your own startup/config code or installed launcher and enumerate every location you could keep
data, in priority order: an explicit environment variable first, then platform defaults.

Observe, per candidate: the env var name (if any), the literal path template, and whether it exists
on this machine. Emit `homeCandidates[]` with `{ env?, fallback }` (ordered), and `envHome` for the
preferred variable. Report every candidate tried, **including ones that failed** — that is what makes
`Probe ok` / `Path does not exist` diagnosable later.

Never choose a path because it is conventional. If a variable is not set, that is an observation —
but do not name a variable you never saw in your own source.

### Step 1 — Characterise the session store

Under the resolved home, find where sessions live. Determine: the root path template relative to
home, the layout (one directory per session vs one file per session), the file extension/glob, the
format, and how many sessions exist right now.

Emit `sessions.roots[]`, `sessions.layout`, `sessions.transcript.glob`, `sessions.transcript.format`,
plus the observation (file count) into the report.

**Discovery sampling — bounded windows, not one line, not whole transcripts.**

Native workspace/session information is often written **beyond the first line**: many Agents emit
queue, lifecycle, or other bookkeeping records before the first conversational record. Sampling only
the first line can therefore miss the native fields the descriptor requires (a real Tier 1 trial
failed this way: the native `cwd` first appeared on line 3, after two `queue-operation` records).
Sample inside bounded windows instead:

1. Read the **first up to 10 records** of **one or two** transcript files, recording **field names
   and value types only** — never quote message content.
2. If a required native field (id, workspace/cwd, timestamps, title) has not appeared yet, extend
   the window forward **only until the first conversational record** (the first user/assistant
   turn) or a hard cap of **20 records** — whichever comes first.
3. Stop sampling as soon as every required field has been observed. Never read a complete
   transcript, never tail a file looking for "more evidence".
4. If a required field does not appear within the window, its absence is an observation: use the
   Step 2 fallback for that field or emit `null`, and record the gap in the report. Never assume a
   field exists further down in an unread part of the file.

The same windows apply to the content you inspect: identify credential- or token-bearing records
by their field names, and do not read, copy, quote, or hash their values (see rule 3).

**Roots describe the whole store.** `sessions.roots[]` must name the Agent's complete session
store, never the directory of the current trial or one specific cwd — pinning a root to the
workspace you are running in makes the descriptor self-referential and non-portable. If the
store's grouping cannot be expressed with the current layout semantics (§2.3), record the
limitation in `unverified[]`; do not narrow the root to work around it.

**Stop rule:** if the store is not plain text (SQLite, encrypted, binary, remote/API, or a store
spread across non-transcript files), **stop and emit `sessions.kind: "none"`** with reason
`opaque_store`. Do not attempt to reverse-engineer a schema; that is a Margin-side decision, not an
Agent-side one.

### Step 2 — Determine identity, time, workspace, and title

Inspect the **field names and value types observed inside the Step 1 sampling window** — not values,
except where a value is structurally required (a timestamp format, an absolute path). Search for
each field across the **whole bounded window, not just line 1**; bookkeeping records legitimately
precede the first conversational record.

| Field | Look for | Catalogue fallback |
|---|---|---|
| `id` | a native session/thread id field (may appear on bookkeeping records) | `{ "kind": "directoryName" }` / `{ "kind": "filename" }` when the id *is* the name |
| `createdAt` | a native timestamp on **any sampled record** — a parseable timestamp on a sampled record *is* the native `createdAt`, even when it sits on a bookkeeping record; do not downgrade it to `mtime` | `{ "kind": "mtime", "glob": …, "pick": "min" }` — label `weak` |
| `updatedAt` | a native timestamp on the last matching record | `{ "kind": "mtime", "glob": …, "pick": "max" }` — label `weak` |
| `workspace` | a recorded working-directory field (`cwd`), which may first appear on the first conversational record, several lines in | `{ "kind": "scanAbsolutePaths", "parentOf": true, "requireMarker": ".git" }` — a **mandatory consideration whenever no native cwd appeared in the bounded window**, label `weak`; never a fallback you skip |
| `title` | a native title field | `{ "kind": "record", "where": …, "index": 0, "path": …, "as": "first-user-message" }` |
| `model` / `provider` | native model/provider fields | omit (`null`) — do not infer |

`mtime` is not a timestamp: `createdAt`/`updatedAt` then reflect when files were written, not when
the session ran. Say so in the report.

**`workspace: null` is not a neutral value.** A candidate without a workspace binding is dropped
during projection, so a manifest whose every session lacks a workspace verifies as
`no_sessions` with zero detail unless diagnostics are inspected. If no native cwd appeared in the
window, either bind the `scanAbsolutePaths` fallback or report the gap honestly — never silently
emit `null` because the first line lacked a cwd.

### Step 3 — Determine the execution-status signal

Look for a **native terminal marker**: a turn/run status field, a lifecycle record, or a status
column. Observe the record type, the dotted path to the value, the raw values actually present, and
which record wins (`first` or `last`).

Emit `executionStatus: { "kind": "transcript", "where": …, "path": …, "map": …, "pick": … }`, or
`executionStatus: { "kind": "none" }` when no native marker exists.

- A failed **command** is not a failed **turn**. Map only a native terminal marker — never a generic
  message, a stack trace, or free text.
- Map **only raw values you observed**. A map is a closed lookup; an unseen value yields `unknown`,
  which is the honest answer.
- If the only honest signal is "an assistant turn exists", map it to `idle` — the format cannot
  distinguish a live `working` turn from a crashed mid-tool session.

### Step 4 — Determine the resource surface

Determine whether quota/usage truth exists, and of what kind: a local provider-written snapshot, a
credentialed endpoint, or nothing. Observe **existence only**: does a quota snapshot record type
exist? does an auth store exist and under which key **name**? is there a documented endpoint?

Emit `resources: { "kind": "none" }` — the catalogue's only legal value for a self-integrated Agent.
Everything else goes into `report.requests[]` as a capability request with a provenance string.

Never read, copy, hash, log, or transmit a credential value. Never call the endpoint. Never put a
quota number in the manifest — a number without a reader and a staleness rule is a fabricated metric.

### Step 5 — Determine handoff

For any Agent that is not a built-in, the answer is `handoff: { "kind": "none" }` and
`capabilities.handoff: false`. The shared Handoff Core consumes Codex-shaped records and each Agent
brings its own extraction layer; there is no declarative form for "distil this transcript". Claiming
`handoff: true` without a `kind` implementation is a validation error, not a fallback to another
Agent's transcript. Report it as a request.

### Step 6 — Emit

Write exactly two files into the scratch output directory `<out>`:

```
<out>/margin-agent.json          the manifest     (schema: manifest.schema.json, this directory)
<out>/margin-agent.report.json   the report       (schema: report.schema.json, this directory)
```

Then **stop**. Do not install. Do not modify anything. The manifest and report must both validate
against their schemas (self-check below), then the manifest must be verified (§5).

---

## 4. Stage 1 — self-check before emitting

Run every check below on your draft. This is a **correctness** control, not a security control — a
dishonest agent can pass it; the point is that a well-meaning one does not hand a human a manifest
Margin will reject for reasons the agent could have caught.

1. Every top-level key is in §2.1's list of 19 — and only those.
2. `specVersion` is exactly `1`.
3. `type` matches `^[a-z][a-z0-9_-]{1,31}$` and is not a built-in type.
4. Every capability flag is one of the 7 (§2.2) and is a boolean.
5. Cross-field rules 1–8 (§2.5) all hold.
6. Every `sessions.roots[i]` is `{home}` or beneath it.
7. Every `true` in `capabilities` appears in `report.claims[]` with `status: observed` or `weak`,
   citing the file/record/field that produced it.
8. Every capability you have but cannot express is `false` in the manifest **and** present in
   `report.requests[]` with provenance.
9. No credential-shaped value appears in either file; `report.redaction{}` documents the scan.
10. `report.unverified[]` names what you could not determine. An empty `unverified[]` on a first
    attempt is itself suspicious.

---

## 5. Verify — declaration is not evidence

The manifest is a claim. `margin agent verify` is the read-only command that observes whether the
declaration reads this machine through the same adapter the hosts consume and publishes at least one
invariant-clean session:

```
margin agent verify <out>/margin-agent.json [--path <home>] [--json] [--sample <n>]
```

It writes nothing, calls no network, reads no credential, and launches no Agent. Verdicts
(the `--json` document adds a stable `reasonCode` with the typed detail):

| Verdict | Exit | Meaning |
|---|---|---|
| `verified` | 0 | validation + composition + probe passed and ≥ 1 invariant-clean session projected |
| `no_sessions` | 2 | a session reader exists, ran, and projected zero sessions (`reader_returned_empty`) |
| `unavailable` | 3 | the session surface cannot be observed on this machine — including a descriptor that declares **no session source** (`sessions.kind` is `none`, `session_source_not_declared`), no home found, source disabled, or read failure |
| `rejected` | 4 | validation, composition, safety, or a projection invariant failed (reasonCode names the refusal) |

`unavailable` with `session_source_not_declared` is **not** `no_sessions`: there is no
session reader by declaration, not a reader that returned nothing. A manifest emitted by
this skill integrates session discovery, so a `none` verdict on it means the declared
session wiring is wrong or absent. The full contract is `docs/agent-verify.md`.

When the transcript discovery ran, the `--json` document additionally carries an **optional
`diagnostics`** block — debugging evidence that never changes the verdict:

```json
{
  "diagnostics": {
    "roots": [{ "root": "{home}/projects", "expanded": "<resolved path>", "exists": true }],
    "entriesExamined": 3,
    "skippedLayout": 0,
    "matchedFiles": 3,
    "candidateCount": 3,
    "projectedCount": 0,
    "dropped": [
      { "path": "<transcript file>", "reason": "missing_workspace", "missing": ["missing_workspace"] }
    ]
  }
}
```

- `matchedFiles` is the number of files the declared glob matched; `candidateCount` is the number
  with records that reached projection; `projectedCount` is the number of sessions published.
- `dropped[].reason` is observed only: `no_transcript_match`, `no_records`,
  `missing_native_session_id`, `missing_workspace`, `missing_created_at`, `missing_updated_at`,
  `duplicate_session`, or `missing_required_evidence` (with the full `missing[]` list). No cause is
  ever guessed: when `matchedFiles` is 0, the empty-projection cause is genuinely undetermined.
- This block is the first place to look when a `no_sessions` verdict is surprising. The human
  output renders the same counts and drop reasons.

**Required output of this skill:** run `margin agent verify` on the emitted manifest and record the
verdict and its evidence in the report. `verified` means "at least one invariant-clean session was observed" —
never "this Agent is fully supported". A manifest that has not been verified has no business being
presented as ready.

---

## 6. Complete examples

### 6.1 `margin-agent.json` — a valid manifest (current keys only)

```json
{
  "$comment": "Margin self-integration manifest. Data only; no code, no expressions.",
  "specVersion": 1,
  "type": "example",
  "label": "Example Agent",
  "provider": "example-labs",
  "resourceAgent": "example",
  "defaultSourceName": "Example",
  "envHome": "EXAMPLE_HOME",
  "order": 1000,
  "supportLevel": "Registered · Adapter required",
  "homeCandidates": [
    { "env": "EXAMPLE_HOME", "fallback": "{profile}/.example" },
    { "fallback": "{profile}/.config/example" }
  ],
  "capabilities": {
    "sessions": true,
    "executionStatus": true,
    "handoff": false,
    "apiUsage": false,
    "quota": false,
    "attentionStatus": false,
    "subscriptionQuota": false
  },
  "sessionCapabilities": { "executionStatus": true },
  "sessions": {
    "kind": "transcript",
    "layout": "directory-per-session",
    "roots": ["{home}/sessions"],
    "transcript": { "glob": "events.jsonl", "format": "jsonl" },
    "id": { "kind": "record", "where": { "kind": "session.start" }, "index": 0, "path": "session.id" },
    "createdAt": { "kind": "record", "where": { "kind": "session.start" }, "index": 0, "path": "session.createdAt" },
    "updatedAt": { "kind": "record", "where": { "kind": "session.end" }, "index": "last", "path": "session.updatedAt" },
    "workspace": { "kind": "record", "where": { "kind": "session.start" }, "index": 0, "path": "session.cwd" },
    "title": { "kind": "record", "where": { "kind": "turn.user" }, "index": 0, "path": "text", "as": "first-user-message" },
    "model": null,
    "provider": null
  },
  "executionStatus": {
    "kind": "transcript",
    "where": { "kind": "turn.assistant" },
    "path": "finishReason",
    "pick": "last",
    "map": { "stop": "idle", "tool_use": "working", "error": "error", "cancelled": "idle" }
  },
  "resources": { "kind": "none" },
  "handoff": { "kind": "none" },
  "probe": { "anyOf": [{ "glob": "{home}/sessions/*/events.jsonl" }] }
}
```

### 6.2 `margin-agent.report.json` — the evidence report

```json
{
  "$comment": "sha256 is the digest of margin-agent.json; this is a format-valid placeholder value only.",
  "reportVersion": 1,
  "manifest": { "path": "margin-agent.json", "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  "agent": {
    "self": { "type": "example", "version": "2.4.1", "executable": "example" },
    "environment": { "platform": "win32", "home": "<user>/.example", "detectedBy": "EXAMPLE_HOME" }
  },
  "claims": [
    {
      "claim": "sessions.roots[0]",
      "value": "{home}/sessions",
      "status": "observed",
      "evidence": {
        "command": "list <home>/sessions   (read-only)",
        "observedAt": "2026-10-14T09:00:00Z",
        "detail": "412 session directories present; newest 2026-10-02"
      }
    },
    {
      "claim": "sessions.workspace",
      "value": { "kind": "scanAbsolutePaths", "parentOf": true, "requireMarker": ".git" },
      "status": "weak",
      "evidence": {
        "detail": "no native cwd field found in the sampled record; workspace is recovered from transcript text",
        "sampledValues": ["<workspace>/margin"]
      }
    },
    {
      "claim": "capabilities.quota",
      "value": false,
      "status": "refused",
      "evidence": {
        "detail": "quota is served by a credentialed endpoint; no declarative form exists"
      }
    }
  ],
  "requests": [
    {
      "capability": "quota",
      "provenance": "GET https://example.invalid/v1/usage, window=subscription, auth=local auth store key 'example-go'",
      "publishableFields": ["window", "percentUsed", "remaining", "resetsAt"],
      "stalenessRule": "no trusted value before window reset; never a guessed 100%",
      "declarativeForm": "none",
      "note": "Do not surface this as a metric until a built-in reader exists."
    }
  ],
  "unverified": [
    "no archived-session mechanism observed; an archived session may still appear as active",
    "unknown whether multiple rollouts can share one native session id"
  ],
  "redaction": {
    "scanned": ["home paths", "credential stores", "session titles"],
    "redacted": [
      { "what": "user profile path", "replacement": "<user>" },
      { "what": "auth store value", "replacement": "<redacted>", "occurrences": 2 }
    ]
  }
}
```

The `status` vocabulary is the load-bearing part of the report, and it is deliberately small:

| status | meaning | may the claim appear as `true` in the manifest? |
|---|---|---|
| `observed` | the Agent read the thing itself and can describe it | yes |
| `weak` | the binding is a recovery/heuristic or a non-native field (mtime, scanAbsolutePaths) | yes, and the manifest must use the recovery binding shape |
| `unverified` | named in the manifest shape but not confirmed on this machine | only as a non-claim template |
| `refused` | the capability exists but no declarative form can express it | **no** — must be `false`, and appears in `requests[]` |

---

## 7. Failure modes — name them, do not hide them

| Situation | Required output |
|---|---|
| Session store is opaque (SQLite/encrypted/remote) | `sessions.kind: "none"`, reason `opaque_store`, a `requests[]` entry |
| Native fields appear only after bookkeeping records (beyond line 1) | run the full bounded sampling window (Step 1) before declaring a field absent; never conclude from one line |
| No native id, only a filename | `id: { "kind": "filename" }`, claim status `weak` |
| No native timestamps in the window | `mtime` extractor, claim status `weak`; report must say timestamps are file-write times |
| No native workspace field in the window | `scanAbsolutePaths` (+ `requireMarker` if a project marker exists), claim status `weak` — do not emit `workspace: null` without recording the gap |
| A `no_sessions` verdict was surprising | inspect `diagnostics` (`matchedFiles`/`projectedCount`/`dropped[]`) before changing anything; it reports observed blockers, never a guess |
| No terminal status marker | `executionStatus.kind: "none"` → `capabilities.executionStatus: false` |
| Status marker exists but no error value observed | map only observed values; `error` stays unmapped → `unknown` |
| Quota only via a credentialed endpoint | `resources.kind: "none"`, `capabilities.quota: false`, `requests[]` with provenance |
| Handoff would need a transcript distiller | `handoff.kind: "none"`, `capabilities.handoff: false`, `requests[]` |
| Multiple rollouts/files share one session id | report in `unverified[]` — an archival/dedup question Margin decides, not the Agent |
| The Agent cannot determine something | `unverified[]`, with the reason |

---

## 8. Deliberate non-goals of this skill

* **No new Agent reader.** A manifest may describe the Agent; it may never extend Margin's
  capability catalogue. If the store is opaque, the answer is `none` + a request, never a new form.
* **No OpenCode / SQLite / opaque-store support.** Opaque storage is a built-in-reader question,
  decided by a human, not by this skill.
* **No resource/quota support.** `resources` is `none`; quota knowledge goes to `requests[]`.
* **No runtime support.** There is no runtime contract; `runtime` is not a valid key.
* **No handoff changes.** `handoff` is `none` for a self-integrated Agent.
* **No install, no release changes.** Installing (`margin agent install --dry-run` first) is the
  user's confirmed step. This skill emits files and runs `verify`; it does nothing else.
