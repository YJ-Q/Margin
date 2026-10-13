# Manifest Schema v0.1

Status: **Research only.** No code in this slice. Nothing here is implemented; the "current" columns
describe what exists today at commit `1c822e5`, and every proposal is marked **[proposed]**.
Related: `agent-capability-matrix.md`, `margin-agent-integration-skill.md`,
`integration-security-boundary.md`.

---

## 1. Framing: v0.1 is a superset of what already ships

The single most important schema decision is **not to invent a new format**. Margin already ships a
versioned, validated, closed, data-only manifest format with a reader catalogue, a loader, a
composition step, an installer, a CLI, an HTTP surface, and a real third-party example:

```
specVersion: 1        (src/agents/descriptor/spec.js, DESCRIPTOR_SPEC_VERSION)
```

Calling the researched artifact "Manifest v0.1" is therefore a **naming and containment** decision
plus three additive fields — not a new mechanism. The alternative (a parallel `margin-agent.json`
format with its own loader) would give Margin two validators, two problem surfaces, and a migration,
in exchange for nothing.

| Term used in this research | Actual key today | Status |
|---|---|---|
| agent identity | `type`, `label`, `provider`, `resourceAgent`, `order` | exists |
| session provider | `sessions` | exists |
| resource provider | `resources` | exists (2 legal values) |
| runtime provider | — | **[proposed]** `runtime` |
| capability flags | `capabilities`, `sessionCapabilities` | exists |
| versioning | `specVersion` | exists; `generatedBy` **[proposed]** |

---

## 2. Top-level shape

### 2.1 Current state

`validateDescriptor` checks a **known set** of keys and ignores everything else. Nested extractor
objects are strict — a `directoryName` extractor with an extra key is an error — but the top level is
not. Practical consequence: `"resource"` instead of `"resources"`, or `"root"` instead of `"roots"`,
is silently ignored and the descriptor quietly defaults to `none`/empty. For a human author that is a
footgun; for an **agent-generated** manifest it is the most likely failure mode in existence.
(Recorded as G2 in the capability matrix.)

### 2.2 v0.1 **[proposed]** — closed key set

Unknown top-level keys become a validation error. `$comment` remains reserved at any level and is
always ignored, as today.

| Key | Required | Type | Notes |
|---|---|---|---|
| `specVersion` | ✅ | integer, literal `1` | must equal `DESCRIPTOR_SPEC_VERSION`; unknown value is refused, never forward-compatibly guessed |
| `generatedBy` | — | object | **[proposed]** provenance; see §7.3 |
| `type` | ✅ | string, `^[a-z][a-z0-9_-]{1,31}$` | the Agent's own namespace; built-in types are reserved (see §3.4) |
| `label` | ✅ | string | human display name |
| `provider` | — | string \| null | provider identity for display grouping |
| `resourceAgent` | — | string | defaults to `type`; the `agent` key a resource record carries |
| `quotaPrefix` | — | string \| null | presentation only |
| `defaultSourceName` | — | string | defaults to `label` |
| `envHome` | — | string | env var name; reused as the default-home override |
| `order` | — | number | defaults to `1000`; sort key among descriptors |
| `supportLevel` | — | string | display string; defaults to `Registered · Adapter required` |
| `homeCandidates` | — | array | ordered; see §3.2 |
| `defaultHome` | — | object | single-candidate shorthand for `homeCandidates` |
| `probe` | — | object | `{ anyOf: [ { glob } ] }`; structural check |
| `capabilities` | — | object | §6 |
| `sessionCapabilities` | — | object | §6 |
| `sessions` | ✅ | object | §4 |
| `resources` | — | object | §5 |
| `runtime` | — | object | **[proposed]** §5.3 |
| `executionStatus` | — | object | §4.4 |
| `handoff` | — | object | §8 (deliberately closed to `none` for new Agents) |

---

## 3. Agent identity

### 3.1 Identity fields (exist today)

```jsonc
{
  "type": "doubao",                    // namespace; must match the regex; must not be a built-in type
  "label": "豆包",                      // display
  "provider": "doubao",                // provider identity (for grouping / quota prefix)
  "resourceAgent": "doubao",           // the `agent` field resource records carry; defaults to `type`
  "defaultSourceName": "Doubao",        // the name a detected source gets
  "quotaPrefix": "Go",                  // presentation only, not capability
  "supportLevel": "Session discovery"   // informational; Margin never derives behaviour from it
}
```

**Rule:** `supportLevel` is a *display string*, not a capability. Behaviour is decided by
`capabilities` + the section `kind`s, never by parsing this string. Today this holds
(`sourceRegistry#supportFor` returns it verbatim for display); the schema should say so explicitly so
an Agent cannot upgrade itself by writing a flattering string.

### 3.2 Home resolution (exists today)

```jsonc
"envHome": "DOUBAO_AGENT_HOME",
"homeCandidates": [
  { "env": "DOUBAO_AGENT_HOME", "fallback": "%ENV:LOCALAPPDATA%/Doubao/…/workspace" },
  { "fallback": "{profile}/AppData/Local/Doubao/…/workspace" },
  { "fallback": "{profile}/.doubao/agent_mode/workspace" }
]
```

* Two substitutions exist and only two: `{home}` and `{profile}`.
* `%ENV:NAME%` reads a process environment variable. It is expanded **into a path** and the path must
  exist; it is never a value channel. **[proposed]** state this in the schema so no future reader
  treats it as one.
* An unknown substitution token is a validation error today (`checkTemplateString`) — keep that.
* Resolution is ordered, reports every candidate, and prefers a candidate that exists **and** passes
  `probe` over one that merely exists.

**[proposed]** new constraint: the resolved candidate home must not be a filesystem root or the
profile root, and every declared `sessions.roots` expansion must be **contained within** the resolved
home. Today there is no such check (G3): `roots` is expanded and `readdirSync`'d directly, so a root
of `{profile}` is a legal declaration. Containment is a one-line semantic rule with no expressiveness
cost, and it is the only thing standing between a self-declared manifest and "enumerate the user's
home directory".

### 3.3 Probe (exists today)

```jsonc
"probe": { "anyOf": [ { "glob": "{home}/.sessions/*/agents/*/system/trajectory.jsonl" } ] }
```

Structural only: "does this directory look like this Agent's home?" A directory that exists but fails
its probe is a weaker signal than one that exists and passes. Keep as-is; the observation step in the
skill's Stage 3 is what turns structure into evidence.

### 3.4 Type namespace rules (exist today — restate in the schema)

* A user manifest can **never** own a built-in `type`. The built-in wins and the user file is reported
  as `descriptor_duplicate_type`. This is the anti-privilege-escalation rule and must stay.
* A built-in `type` can never be installed from a file, and can never be uninstalled — only its
  source. Reported, not applied.
* Registering a format-valid type whose adapter does not exist is a **legitimate, inspectable state**
  (`Registered · Adapter required`), not an error. Keep.

---

## 4. Session provider (`sessions`)

### 4.1 Shape (exists today)

```jsonc
"sessions": {
  "kind": "transcript",              // builtin | transcript | none   (closed enum)
  "layout": "directory-per-session",  // directory-per-session | file-per-session
  "roots": ["{home}/.sessions"],      // non-empty; templates only
  "transcript": { "glob": "agents/*/system/trajectory.jsonl", "format": "jsonl" },
  "id":         { "kind": "directoryName" },
  "createdAt":  { "kind": "mtime", "glob": "agents/*/system/*", "pick": "min" },
  "updatedAt":  { "kind": "mtime", "glob": "agents/*/system/*", "pick": "max" },
  "workspace":  { "kind": "scanAbsolutePaths", "parentOf": true, "requireMarker": ".git" },
  "title":      { "kind": "record", "where": { "role": "user" }, "index": 0, "path": "content", "as": "first-user-message" },
  "model":      null,
  "provider":   null
}
```

### 4.2 The closed extractor catalogue (exists today — this is the whole vocabulary)

| `kind` | Parameters | Semantics |
|---|---|---|
| `directoryName` | none | the session directory's name |
| `filename` | none | the transcript file's basename |
| `mtime` | `glob`, `pick: max\|min` | filesystem mtime of files matching `glob` within the session dir |
| `record` | `where` (literal equalities only), `index` (non-negative int or `"last"`), `path` (dotted), `maxLength` | a dotted field read from the Nth (or last) matching JSONL record |
| `scanAbsolutePaths` | `parentOf` (bool), `requireMarker` (string) | recover a path from absolute paths found in transcript text |

Bounded deliberately: one glob dialect (`*` within a segment, `**` across segments — everything else
escaped, so a glob cannot smuggle a regex), one transcript format (`jsonl`), no expression evaluator,
no `eval`, no regex, no operators in `where` (literal equality only).

### 4.3 Required minimum (exists today)

`id`, `createdAt`, `updatedAt` are **required**; `workspace`, `title`, `model`, `provider` are
optional. This is intentional: a session that cannot be identified, ordered, or placed is not
published at all. `buildTranscriptSession` returns `null` rather than filling defaults, and the
`projected()` path does the same for the built-in readers.

**[proposed]** make the *strength* of a binding explicit in the schema so "weak" is machine-readable
rather than a report-only adjective. Two additions, both optional, both non-executable:

```jsonc
"workspace": { "kind": "scanAbsolutePaths", "parentOf": true, "requireMarker": ".git",
               "confidence": "recovered" },   // → "native" | "recovered"
"createdAt": { "kind": "mtime", "glob": "…", "pick": "min",
               "confidence": "file-write-time" }   // → "native" | "file-write-time"
```

Rationale: the difference between "the Agent records a cwd" and "we guessed the cwd from text" is a
**truth** difference, and Margin's stated principles are source-backed semantics and no heuristic
state. Today that difference is visible in the reader code and in the plugin's comments but not in the
data. Making it a validated enum costs nothing and makes the difference impossible to lose in a
report. (Counter-argument: it is another knob on a surface that keeps growing. Mitigation: exactly two
enumerated values, no free text, and readers may ignore it.)

### 4.4 `executionStatus` (exists today)

```jsonc
"executionStatus": {
  "kind": "transcript",   // none | transcript | builtin  (closed enum)
  "where": { "role": "assistant" },
  "path": "role",
  "map": { "assistant": "idle" },   // values must be one of unknown|working|idle|error
  "pick": "last"                     // first | last
}
```

Semantic rule the schema must state: classify the **last matching turn**; an unmapped raw value
yields `unknown`, never a guessed status; a failed command is not a failed turn. `kind: "builtin"`
means a shipped reader owns enrichment (§4.1 `readExecutionStatus` in the adapter contract) and
requires `sessions.kind: "builtin"`.

---

## 5. Resource and runtime providers

### 5.1 `resources` today

```jsonc
"resources": { "kind": "none" }   // closed enum: none | builtin
```

That is the entire section. `builtin` means "the shipped adapter for this `type` collects resources",
which for a self-integrated Agent is impossible by construction.

### 5.2 Why there is no declarable resource provider in v0.1

From the capability matrix, all three built-in resource readers are unwritable in a path+extractor DSL,
and each for a *different* structural reason:

| Agent | Reason a manifest cannot express it |
|---|---|
| Codex | rate limits live in a JSONL record, but the reader owns archive-inclusive selection, byte-offset incremental reads, an in-process LKG, and a window-reset staleness rule that maps an expired window to `remaining: null` |
| Claude | the quota is only legitimate after four external proofs (a switch app, a SQLite row, a loopback proxy config, an endpoint allow-list) plus an out-of-band credential |
| Pi | one source, two readers (a calendar-day JSONL aggregation and a credentialed endpoint), classified by reading a **provider config file**, and never added together |

The three irreducible things are: **a credential**, **a network call**, and **an interpretation**.
A DSL that expressed them would be a programming language with a credential model — that is the
boundary argued in `integration-security-boundary.md`, not a schema gap.

### 5.3 `runtime` **[proposed]**

```jsonc
"runtime": {
  "kind": "none",       // closed enum for v0.1: none | builtin
  "control": false       // MUST be false in v0.1 — a validation error if true
}
```

Why add a section whose only legal values are `none`/`false`:

1. **The absence is currently unstated.** Today the adapter contract has no runtime methods at all
   (`compose.js` exposes `detect`, `validateSource`, `discoverSessions`, `collectSessionSnapshots`,
   `readSessionSnapshots`, `getSessionRevision`, `getResourceStatus`, `collectResourceSnapshot`,
   `probe`, optional `readExecutionStatus`, optional `captureSession`/`generateHandoff`). There is no
   "launch", "stop", "pause", or "send" — and no place in a descriptor that would say so.
2. **Observation already exists under a different name.** `executionStatus` *is* the runtime axis
   Margin can read. Adding `runtime` lets the schema say "observation yes, control no" instead of
   leaving a reader to infer it.
3. **Without a closed key set, an Agent will invent it.** Given G2, a manifest can already carry an
   ignored `"runtime": { "launch": "example.exe --serve" }` and nothing rejects it. A validated
   section that must be `false` converts a silent ignore into a loud refusal.

Counter-argument, stated: a section with one legal value is surface with no capability, which is the
`attentionStatus` mistake (§6.4). If the reviewer prefers strict minimalism, the defensible
alternative is to **omit `runtime` and instead forbid any key matching `/^runtime/` at the top level**
— same protection, no new section. Either is acceptable; the unacceptable option is leaving it
unvalidated.

### 5.4 Non-executable capability requests go in the report, not the manifest

An Agent that knows it *has* a quota endpoint must be able to say so without that becoming a metric
someone renders. The schema decision is:

* **Manifest** carries only executable claims. A capability that no reader can serve is `false`.
* **Report** (`margin-agent.report.json`, `requests[]`) carries the provenance string, the
  publishable field names, and the staleness rule — as *documentation of a gap*, explicitly not a
  metric. `margin-agent-integration-skill.md` §5.2 shows the shape.

This keeps the manifest honest ("`quota: false` — I cannot deliver it") while keeping the knowledge
("here is the endpoint and the windows, if you ever want a reader"). It also means the resource-bar
UI never has to defend against a manifest that claims a metric without a staleness rule.

---

## 6. Capability flags

### 6.1 Vocabulary (exists today)

```
sessions, handoff, apiUsage, quota, executionStatus, attentionStatus, subscriptionQuota
```

Duplicated deliberately in two places (`sourceRegistry.AGENT_CAPABILITIES` and
`spec.DESCRIPTOR_CAPABILITIES`) so that a typo is a validation error. Keep the duplication or collapse
it to one import — but do not let the two drift.

### 6.2 Two surfaces (exists today, preserve)

`capabilities` (source level) and `sessionCapabilities` (per-session DTO level) are genuinely
different. Claude today: source `handoff: false`, session `handoff: true`. That is pre-existing
product behaviour; the spec preserves both rather than collapsing them. The DTO composes
`BASE_CAPABILITIES ← capabilities ← sessionCapabilities` (`compose.js#asSnapshot`).

### 6.3 Cross-field rules

**Exist today:**

| Rule | Error code |
|---|---|
| `capabilities.handoff === true` requires `handoff.kind !== "none"` | `invalid_descriptor` |
| `handoff.kind` ∈ {`builtin`,`shared-codex`} requires `sessions.kind === "builtin"` | `invalid_descriptor` |
| `resources.kind === "builtin"` requires `sessions.kind === "builtin"` | `invalid_descriptor` |
| `sessions.kind === "builtin"` requires `capabilities.sessions !== false` | `invalid_descriptor` |
| `capabilities.executionStatus === true` requires a transcript extractor, or `sessions.kind === "builtin"` | `invalid_descriptor` |
| `executionStatus.kind === "builtin"` requires `sessions.kind === "builtin"` | `invalid_descriptor` |
| `executionStatus.kind === "transcript"` requires `sessions.kind === "transcript"` | `invalid_descriptor` |
| a referenced reader must actually exist | `descriptor_adapter_missing` (composition) |

**[proposed] the four missing rules.** The spec's own header states the principle — *"a descriptor
that claims a capability its declared wiring cannot deliver is the exact failure this spec exists to
prevent"* — and applies it to `handoff` and `executionStatus` but **not** to the resource family.
Today a plugin can declare `quota: true` with `resources.kind: "none"`, validate cleanly, and render
as permanently `unavailable` on the bar (G1). Add:

| Rule | Rationale |
|---|---|
| `capabilities.quota === true` requires `resources.kind !== "none"` | same discipline as `handoff` |
| `capabilities.apiUsage === true` requires `resources.kind !== "none"` | apiUsage and quota are both resource-family |
| `capabilities.subscriptionQuota === true` requires `resources.kind !== "none"` | Pi sets this flag from a *reader result*, never from a declaration — a declaration must not be able to set it |
| `runtime.control === true` is an error in v0.1 | no runtime control contract exists |

Note the asymmetry with Pi: Pi's `subscriptionQuota` is set **data-driven** at read time ("only present
when the structured reader actually succeeded / held LKG. Never claimed solely because the provider is
named opencode-go" — `adapters.js`). So `subscriptionQuota` is arguably not a *declarable* capability
at all. **[proposed]** either forbid it in `capabilities` for user manifests, or allow it only when
`resources.kind === "builtin"`. The former is stricter and simpler.

### 6.4 The `attentionStatus` lesson

`attentionStatus` is in the capability vocabulary, in `BASE_CAPABILITIES`, in every built-in
descriptor (`false`), and in every session DTO (`'none'`). No reader has ever produced a non-`none`
value. It is a capability enumerated before an implementation existed, and it is now permanent
surface that the DTO, the registry, and the UI contract all carry.

The schema rule that follows: **a capability flag may only exist if a reader can set it.** v0.1 is the
moment to freeze the vocabulary at what is actually produced — `sessions`, `handoff`,
`executionStatus`, `apiUsage`, `quota`, `subscriptionQuota` — and either implement or retire
`attentionStatus`. Adding an eighth flag should require a reader in the same change.

---

## 7. Versioning

### 7.1 `specVersion` (exists today)

An **integer**, currently `1`, compared with strict equality. Any other value is a validation error.

Deliberately not semver, deliberately not negotiated. A manifest is refused rather than
forward-compatibly guessed, because the failure mode of guessing is a silently half-wired Agent — the
exact thing the loader's comments call the most confusing part of onboarding. A breaking change
increments the integer; old manifests are reported, not silently degraded.

### 7.2 Author revision **[proposed]**

```jsonc
"manifestVersion": "2.4.1"    // the AUTHOR's own revision string; informational only
```

Never used for behaviour. Its purpose is diffing: "the Agent upgraded and the manifest changed" is a
question a report should be able to answer. Free-text, no semantics, optional.

### 7.3 `generatedBy` **[proposed]** — what makes a self-generated manifest distinguishable

```jsonc
"generatedBy": {
  "kind": "self-inspection",       // closed enum: "self-inspection" | "human" | "vendor"
  "skillVersion": "0.1.0",          // the skill release that produced it
  "agentVersion": "2.4.1",          // the Agent's own version, as the Agent reports it
  "generatedAt": "2026-10-03T12:00:00Z",
  "reportSha256": "…"                // binds the manifest to its evidence report
}
```

This is the only genuinely new *semantic* field in v0.1, and it is small. It exists because
"installed by the vendor as a plugin" and "generated by the Agent inspecting itself" are different
trust situations, and the install report should be able to say which one it is looking at. It is
purely informational — **no behaviour may branch on `generatedBy`**. If a future version wants to
branch on it (e.g. a stricter validation mode for self-generated manifests), that is a `specVersion`
bump.

Rules: optional (so every existing descriptor — built-in and plugin — remains valid); `kind` is a
closed enum; `reportSha256` is a hash of the report, not of anything secret.

### 7.4 Compatibility statement

A `specVersion: 1` manifest that is valid today must remain valid under v0.1, with exactly one class
of exception: **the closed top-level key set and the four proposed cross-field rules are new errors.**
A previously-valid descriptor that relied on an unknown top-level key being ignored, or on
`quota: true` with no resource wiring, is now rejected. Both are the same class of change: refusing a
silent half-wiring. That is the intended direction (§6.4) and should be called out in the changelog,
not discovered at runtime.

---

## 8. `handoff` — deliberately closed for new Agents

```jsonc
"handoff": { "kind": "none" }   // closed enum: none | builtin | shared-codex
```

`builtin` and `shared-codex` both require `sessions.kind: "builtin"`, i.e. a shipped reader. A
self-integrated Agent therefore can only ever write `none`, and `capabilities.handoff: true` with
`kind: "none"` is a **validation error**, not a fallback to another Agent's transcript. There is no
declarative form for "distil this transcript", and the spec says so rather than inventing a DSL. v0.1
keeps this exactly as-is.

---

## 9. Deliberate omissions

Named here so they are decisions rather than oversights. Each has a reason and an explicit
revisit condition — not a date.

| Omitted | Why not in v0.1 | What would have to change first |
|---|---|---|
| `transport` / `launch` (how to start the Agent) | no consumer; the adapter contract has no launch method | a real runtime-control contract, with its own security boundary |
| `network` (endpoints, auth, headers) | requires a credential model and an allow-list; see §5.2 | a sandboxed resource-reader design |
| `code` (any pointer to executable content) | makes a manifest an execution surface — see `integration-security-boundary.md` | a sandboxed adapter with its own process and grants |
| `schedule` / `watch` | Margin polls by revision, has no watcher, and the capability matrix shows no Agent that needs one | a slice that needs it |
| `attachments` / artifact lanes | out of scope for session/resource/runtime | — |
| a capability flag with no reader | the `attentionStatus` lesson (§6.4) | the reader, in the same change |
| a plugin registry / marketplace / index | obtaining the plugin is the Agent's job; Margin never fetches | an explicit product decision |
| signature / attestation of the manifest | a signature proves *who* wrote it, not that it is *true*; there is no key distribution story | a signing story worth its cost |

---

## 10. Complete example (a self-integrated Agent, v0.1)

This is `plugins/doubao/agent.json` expressed under the proposed v0.1 shape, with the proposed fields
marked. It remains valid under today's validator (the additions are optional and the top-level keys
already exist).

```jsonc
{
  "$comment": "Generated by the Margin self-integration skill. Data only; no code, no expressions.",
  "specVersion": 1,

  "generatedBy": {                                  // [proposed]
    "kind": "self-inspection",
    "skillVersion": "0.1.0",
    "agentVersion": "1.9.2",
    "generatedAt": "2026-10-03T12:00:00Z",
    "reportSha256": "9f2c…"
  },

  "type": "doubao",
  "label": "豆包",
  "provider": "doubao",
  "resourceAgent": "doubao",
  "defaultSourceName": "Doubao",
  "envHome": "DOUBAO_AGENT_HOME",
  "supportLevel": "Session discovery",

  "homeCandidates": [
    { "env": "DOUBAO_AGENT_HOME", "fallback": "%ENV:LOCALAPPDATA%/Doubao/User Data/Default/.doubao/agent_mode/workspace" },
    { "fallback": "{profile}/AppData/Local/Doubao/User Data/Default/.doubao/agent_mode/workspace" },
    { "fallback": "{profile}/.doubao/agent_mode/workspace" }
  ],

  "capabilities": {
    "sessions": true,
    "executionStatus": true,
    "handoff": false,
    "apiUsage": false,
    "quota": false,
    "subscriptionQuota": false,
    "attentionStatus": false
  },
  "sessionCapabilities": { "executionStatus": true },

  "sessions": {
    "kind": "transcript",
    "layout": "directory-per-session",
    "roots": ["{home}/.sessions"],
    "transcript": { "glob": "agents/*/system/trajectory.jsonl", "format": "jsonl" },
    "id": { "kind": "directoryName" },
    "createdAt": { "kind": "mtime", "glob": "agents/*/system/*", "pick": "min", "confidence": "file-write-time" },
    "updatedAt": { "kind": "mtime", "glob": "agents/*/system/*", "pick": "max", "confidence": "file-write-time" },
    "workspace": { "kind": "scanAbsolutePaths", "parentOf": true, "requireMarker": ".git", "confidence": "recovered" },
    "title": { "kind": "record", "where": { "role": "user" }, "index": 0, "path": "content", "as": "first-user-message" },
    "model": null,
    "provider": null
  },

  "executionStatus": {
    "kind": "transcript",
    "where": { "role": "assistant" },
    "path": "role",
    "pick": "last",
    "map": { "assistant": "idle" }
  },

  "resources": { "kind": "none" },
  "runtime": { "kind": "none", "control": false },   // [proposed]
  "handoff": { "kind": "none" },

  "probe": { "anyOf": [{ "glob": "{home}/.sessions/*/agents/*/system/trajectory.jsonl" }] }
}
```

And the corresponding `requests[]` entry in the report, which is where the Agent's real quota
knowledge goes — as a documented gap, never as a metric:

```jsonc
{
  "capability": "quota",
  "provenance": "GET /alice/commerce/sale/subscription/quota/summary on the 豆包 gateway; three rolling windows",
  "publishableFields": ["window", "percentUsed", "remaining", "resetsAt"],
  "stalenessRule": "required, not observed — no trusted value before window reset",
  "declarativeForm": "none",
  "note": "Credential-bearing. Do not surface as a metric until a built-in reader exists."
}
```

---

## 11. Schema-rule summary

| # | Rule | Status |
|---|---|---|
| 1 | `specVersion` integer, strict equality, refuse unknown | exists |
| 2 | Closed key set at top level; unknown key is an error; `$comment` ignored | **[proposed]** |
| 3 | Closed `kind` enums everywhere: `sessions`, `resources`, `handoff`, `executionStatus`, `runtime` | exists / **[proposed]** for `runtime` |
| 4 | Closed extractor catalogue; no expressions, no regex, no operators | exists |
| 5 | Every `capabilities.X === true` requires wiring for X | exists for `handoff`, `executionStatus`; **[proposed]** for `quota`, `apiUsage`, `subscriptionQuota` |
| 6 | No capability flag without a reader | **[proposed]** (§6.4) |
| 7 | Resolved home must not be a root; `sessions.roots` must be contained in the home | **[proposed]** |
| 8 | `%ENV:X%` is a path channel only | exists in effect; **[proposed]** as an explicit rule |
| 9 | Weak bindings are labelled (`confidence`), not silently equal to native ones | **[proposed]** |
| 10 | Built-in types are unreachable from a manifest; built-in descriptors cannot fail silently | exists |
| 11 | `generatedBy` records provenance; **no behaviour branches on it** | **[proposed]** |
| 12 | The manifest is data. No field may name executable content. | exists; restate as a schema invariant |
