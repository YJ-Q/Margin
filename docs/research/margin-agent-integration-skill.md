# Margin Agent Self-Integration Skill

Status: **Research only.** No code in this slice. Nothing described here is implemented.
Depends on: `agent-capability-matrix.md` (what the three current integrations actually expose),
`agent-manifest-schema.md` (the artifact the skill emits).
Written at: `package.json` `0.1.0` (v0.1.0 Beta), commit `1c822e5`.

---

## 1. Thesis

> A coding agent understands its own runtime environment better than Margin does. It should inspect
> its own session/resource/runtime capabilities and emit a declarative integration manifest that
> Margin consumes.

**The thesis is already half-implemented, and that is the most important finding of this document.**

Margin does not need a new protocol to accept an integration. It already has one:

| Existing piece | File | What it does |
|---|---|---|
| A closed, validated manifest format | `src/agents/descriptor/spec.js` | `DESCRIPTOR_SPEC_VERSION = 1`; data only, no expressions, no `eval` |
| A bounded reader catalogue | `src/agents/descriptor/readers.js` | 2 substitutions, one glob dialect, 4 field extractors, 1 transcript format |
| Composition into the real adapter contract | `src/agents/descriptor/compose.js` | descriptor + optional built-in reader → the ten-method adapter every host consumes |
| A loader with reporting, not silent skipping | `src/agents/descriptor/load.js` | `~/.margin/agents/*.json`, built-in-type protection, `problems[]` |
| Install / uninstall / dry-run | `src/agents/agentInstall.js` | idempotent, candidate-reporting, **never fetches anything** |
| A real third-party example | `plugins/doubao/agent.json` + `README.md` | a non-trivial Agent integrated with zero Margin code |
| CLI + HTTP | `margin agent install\|uninstall\|list\|detect` (`src/cli/agentSourceCli.js`), `POST /api/agents/install\|uninstall` | the two operations an Agent needs |

What is missing is not a mechanism. It is the **procedure** the agent follows to produce the
manifest, and the **evidence** that the manifest is true. Today a manifest is authored by a human who
already read the Agent's source. The skill replaces that human with the Agent itself — and the
missing evidence layer is exactly where the risk lives.

So the skill is defined here as:

> **A read-only self-inspection procedure, shipped as documentation, that a coding agent executes
> inside its own environment to emit (a) a manifest Margin can validate and (b) a validation report
> that states, per claim, what was observed and what was not.**

It adds two things to the existing system: a **procedure** (`SKILL.md`) and a **report artifact**
(`margin-agent.report.json`). It adds no new format, no new mechanism, and no executable surface.

---

## 2. Why the Agent, and not Margin

The alternative is Margin maintaining a hardcoded adapter per Agent. The repository already contains
the cost of that approach in its own history, stated in source:

* `compose.js`, header: *"Keeping it in one place is what makes 'add an Agent' stop meaning 'edit nine
  files'."*
* `sourceRegistry.js`, comment on the removed allowlist: *"The allowlist was the single hard blocker
  for a new Agent — `margin agent add deepseek` failed outright and a hand-edited registry entry was
  dropped without a word."*
* `agentInstall.js`, header: *"Neither of them fetches anything over the network: obtaining the plugin
  is the Agent's job, so Margin never gains a download-and-execute surface."*

The Agent has an information advantage Margin structurally cannot close:

| Question | Who can answer it |
|---|---|
| Which env var selects my home on this machine? | the Agent, from its own startup code |
| Is my session store JSONL, SQLite, or encrypted? | the Agent |
| Which field is my stable session id? | the Agent |
| Do I have a terminal/turn status field, or only a log? | the Agent |
| Does my quota come from a local snapshot or a credentialed endpoint? | the Agent |
| Do I require a proxy or a switch app to be reachable? | the Agent |

Margin can only answer these by reading the Agent's source, on every platform, forever. The Agent can
answer them by looking at itself, once, on the machine it is actually running on.

**But the information advantage is about *discovery*, not about *trust*.** The Agent is the best
source of "where is my session file"; it is the worst source of "this manifest is safe and correct".
The design below separates those two roles deliberately.

---

## 3. What the skill is

Three files, all data, distributed as an ordinary Markdown skill:

```
margin-agent-integration/
  SKILL.md                 the procedure (the only thing the Agent reads)
  manifest.schema.json     the closed JSON Schema for the emitted manifest   [see agent-manifest-schema.md]
  report.schema.json       the closed JSON Schema for the emitted report
```

`SKILL.md` is Markdown plus an ordered list of read-only commands. It is what a coding agent loads
when the user says *"integrate yourself with Margin"*.

**It is not**: a Margin plugin, a package, a CLI subcommand, an SDK, an MCP server, a daemon, or
anything that runs inside the Margin process. The Agent already has file-read and shell tools; the
skill tells it what to look at and what to write down.

### 3.1 Non-negotiable rules stated at the top of `SKILL.md`

1. **Read-only.** No writes outside one scratch output directory. Never write to Margin's
   `~/.margin/**`. Installation is a separate, user-confirmed step (`margin agent install --dry-run`
   first) that the skill does not perform.
2. **No network.** The skill never fetches, registers, uploads, or telemetry-pings.
3. **No credential values in any artifact.** Existence, path, and key *name* may be reported; the
   value may not. A hash is not acceptable either — a hash of a short secret is a secret.
4. **No executable content, ever.** The manifest is data. The skill must not emit code, a patch, a
   script, a hook, a driver, or a "run this to finish setup" snippet. If a capability needs code, the
   correct output is `kind: "none"` plus a `requests` entry in the report.
5. **No claim without an observation.** Every `true` capability must cite the file, record, and field
   that produced it. Every unverified capability must be `false`, not `true`-pending.
6. **No invented values.** If a session cannot be projected with a real id, a real workspace, and real
   timestamps, it is not a session — omit it rather than fill a default. This is the existing
   `projected()` / `buildTranscriptSession()` rule, restated as a rule for the Agent.

---

## 4. How a new agent discovers its own capabilities

The procedure is six bounded steps. Each step has a required output; a step that cannot be completed
is a **reported gap**, never a skipped step with a default.

### Step 0 — Resolve my own home

| | |
|---|---|
| Do | Read my own startup/config code or installed launcher and enumerate every location I could keep data, in priority order. Prefer an explicit environment variable; then platform defaults. |
| Observe | For each candidate: the env var name (if any), the literal path template, and whether it exists on this machine. |
| Emit | `agent.home.candidates[]` with `{ env, pathTemplate, exists }`, plus `agent.home.resolved`. |
| Never | Choose a path because it is conventional. Report every candidate tried, including the ones that failed, because that is what makes `Probe ok` / `Path does not exist` diagnosable later. |

Mirrors `resolveAgentHome` (`readers.js`), which already returns the full candidate list rather than
just the winner.

### Step 1 — Characterise the session store

| | |
|---|---|
| Do | Under the resolved home, find where sessions live. Determine: the root path template relative to home, the layout (one directory per session, or one file per session), the file extension and glob, the format, and how many sessions exist right now. |
| Observe | File count. Layout by inspection. Format by reading the **first complete line** of one file. |
| Emit | `session.roots[]`, `session.layout`, `session.transcript.glob`, `session.transcript.format`, and `observation.sessionFileCount`. |
| Never | Read whole transcripts. Read one complete record; that is enough to learn the shape. |
| Stop rule | If the store is not plain text (SQLite, encrypted, binary, or a remote API), **stop and report** `session.kind: "none"` with reason `opaque_store`. Do not attempt a schema reverse-engineering pass; that is a Margin-side decision, not an Agent-side one. |

### Step 2 — Determine identity, time, workspace, and title

For each of the five projection fields, the Agent inspects the **sampled record's field names and
value types only** — not values, except where a value is structurally required (a timestamp format,
an absolute path).

| Field | What the Agent looks for | Fallback in the catalogue |
|---|---|---|
| id | a native session/thread id field | `{ "kind": "directoryName" }` or `{ "kind": "filename" }` when the id *is* the directory/file name |
| createdAt | a native timestamp on the first record | `{ "kind": "mtime", "glob": "…", "pick": "min" }` |
| updatedAt | a native timestamp on the last record | `{ "kind": "mtime", "glob": "…", "pick": "max" }` |
| workspace | a recorded working directory field | `{ "kind": "scanAbsolutePaths", "parentOf": true, "requireMarker": ".git" }` **only if** no cwd is recorded anywhere |
| title | a native title field | `{ "kind": "record", "where": {...}, "index": 0, "path": "...", "as": "first-user-message" }` |
| model / provider | a native model change or message model field | omit (`null`) — do not infer |

Two constraints the Agent must respect, because they are how the existing readers stay honest:

* **`scanAbsolutePaths` is the last resort, not the default.** It reads meaning out of free text. The
  catalogue bounds it deliberately: no ordering rules, no priorities, no include/exclude patterns,
  and `requireMarker` is a *preference*, never a filter (`readers.js` comment). An Agent that reaches
  for it because a native `cwd` field exists but was not found is producing a heuristic binding, and
  the report must say so.
* **mtime is not a timestamp.** Using `mtime` means the Agent has no native time field;
  `createdAt`/`updatedAt` then reflect *when the Agent wrote files*, not when the session ran. That is
  a legitimate but weaker claim, and it must be labelled in the report.

### Step 3 — Determine the execution-status signal

| | |
|---|---|
| Do | Look for a **native terminal marker**: a turn/run status field, a lifecycle event record, or a status column in a projection store. |
| Observe | The exact record type, the dotted path to the value, the observed set of raw values, and which record wins (first or last matching). |
| Emit | either `executionStatus.kind: "transcript"` with `where` / `path` / `map` / `pick`, or `executionStatus.kind: "none"`. |
| Never | Map a generic message, a tool failure, a stack trace, or free text to `error`/`working`. Only a native terminal marker counts. The existing readers state this rule and follow it: a failed *command* is not a failed *turn* (`executionStatus.js`). |
| Never | Emit `map` entries for raw values not actually observed in the sample. A map is a closed lookup; an unseen value yields `unknown`, by design. |

If the only honest signal is "an assistant turn exists", say so and map it to `idle`. That is exactly
what the 豆包 plugin does, and its comment explains why: the format cannot distinguish a live
`working` state from a crashed mid-tool session, so claiming `working` would be a false positive
(`plugins/doubao/agent.json`, `$comment_executionStatus`).

### Step 4 — Determine the resource surface

| | |
|---|---|
| Do | Determine whether quota/usage truth exists, and of what kind: a local provider-written snapshot, a credentialed endpoint, or nothing. |
| Observe | Only *existence*: does a quota snapshot record type exist? does an auth store exist and under which key **name**? is there a documented endpoint? |
| Emit | `resources.kind` — which in the current catalogue can only be `"none"` for a self-integrated Agent (see §6). Everything else goes into `report.requests[]` as a capability request with a provenance string. |
| Never | Read, copy, hash, log, or transmit a credential value. Never call the endpoint. Never put a quota number in the manifest — a number without a reader and a staleness rule is a fabricated metric. |

### Step 5 — Determine handoff

For any Agent that is not a built-in, the answer is `handoff.kind: "none"`. This is not a limitation
of the skill; it is a property of the current design: the shared Handoff Core consumes Codex-shaped
records, and each Agent brings its own extraction layer (`spec.js` header). A manifest that claims
`capabilities.handoff: true` without a `handoff.kind` implementation is a **validation error**, not a
fallback to another Agent's transcript. Report it as a request.

### Step 6 — Emit

Write exactly two files into the scratch output directory:

```
<out>/margin-agent.json          the manifest        (schema: agent-manifest-schema.md)
<out>/margin-agent.report.json   the validation report
```

Then stop. Do not install. Do not modify anything.

---

## 5. Artifacts

### 5.1 `margin-agent.json` — the manifest

The declaration. Closed schema, data only, no expressions, no code. Defined in full in
`agent-manifest-schema.md`. In v0.1 it is the existing Agent Descriptor Spec plus three additive
fields: `agent` (identity/provenance), `capabilities.runtimeControl` (must be `false`), and
`generatedBy`.

### 5.2 `margin-agent.report.json` — the validation report

The evidence. This is the artifact the skill adds, and it is the one that makes the whole idea
auditable. It is **not** input to Margin's runtime; it is what a human (or a later `margin agent
verify`) reads to decide whether to trust the manifest.

```jsonc
{
  "reportVersion": 1,
  "manifest": { "path": "margin-agent.json", "sha256": "…" },
  "agent": {
    "self": { "type": "example", "version": "2.4.1", "executable": "example" },
    "environment": { "platform": "win32", "home": "…", "detectedBy": "EXAMPLE_HOME" }
  },

  // One entry per manifest claim. `status` is the whole point of the report.
  "claims": [
    {
      "claim": "session.roots[0]",
      "value": "{home}/.sessions",
      "status": "observed",              // observed | weak | unverified | refused
      "evidence": {
        "command": "dir …   (read-only, redacted)",
        "observedAt": "…",
        "detail": "412 session directories present; newest 2026-10-02"
      }
    },
    {
      "claim": "session.workspace",
      "value": { "kind": "scanAbsolutePaths", "requireMarker": ".git" },
      "status": "weak",
      "evidence": {
        "detail": "no native cwd field found in the sampled record; workspace is recovered from transcript text",
        "sampledValues": ["C:\\…\\margin"]   // redacted to a single example
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

  // Capabilities this Agent has but the current catalogue cannot express. Explicitly NOT metrics.
  "requests": [
    {
      "capability": "quota",
      "provenance": "GET https://example.invalid/v1/usage, window=subscription, auth=local auth store key 'opencode-go'",
      "publishableFields": ["window", "percentUsed", "remaining", "resetsAt"],
      "stalenessRule": "no trusted value before window reset; never a guessed 100%",
      "declarativeForm": "none",
      "note": "Do not surface this as a metric until a built-in reader exists."
    }
  ],

  // What the Agent could NOT determine, so a human knows where the manifest is thin.
  "unverified": [
    "no archived-session mechanism observed; an archived session may still appear as active",
    "unknown whether multiple rollouts can share one native session id"
  ],

  // Proof that rule 3 was followed.
  "redaction": {
    "scanned": ["home paths", "credential stores", "session titles"],
    "redacted": [
      { "what": "user profile path", "replacement": "<user>" },
      { "what": "auth store value", "replacement": "<redacted>", "occurrences": 2 }
    ]
  }
}
```

The `status` vocabulary is the load-bearing part, and it is deliberately small and honest:

| status | meaning | may it appear as `true` in the manifest? |
|---|---|---|
| `observed` | the Agent read the thing itself and can describe it | yes |
| `weak` | the binding exists but is a recovery/heuristic or a non-native field | yes, **but the manifest must mark the binding** (e.g. `title.as`, `scanAbsolutePaths`) |
| `unverified` | named in the manifest shape but not confirmed on this machine | yes, only if the value is a non-claim (a template to try) |
| `refused` | the capability exists but no declarative form can express it | **no** — must be `false`, and appears in `requests[]` |

---

## 6. Validation

Three stages, in increasing authority. The first two are cheap; the third is the one that produces
truth.

### Stage 1 — Agent self-check (inside the skill, before emitting)

`SKILL.md` embeds the spec's cross-field rules as a checklist the Agent must run on its own draft:

* `capabilities.handoff === true` requires `handoff.kind !== "none"` → for a new Agent this is
  unsatisfiable, so `handoff` must be `false`.
* `capabilities.executionStatus === true` requires either `executionStatus.kind === "transcript"`
  with `where`/`path`/`map`, or a built-in reader → for a new Agent it must be the transcript form.
* `capabilities.sessions === false` with `sessions.kind === "builtin"` is an error.
* `resources.kind === "builtin"` requires `sessions.kind === "builtin"` → for a new Agent both are
  `"none"`/`"transcript"`.
* Every `true` in `capabilities` must appear in `claims[]` with `status: observed` or `weak`.

Stage 1 exists so the Agent does not hand a human a manifest that Margin will reject for reasons the
Agent could have caught. It is **not** a security control — a dishonest Agent can pass it. It is a
correctness control.

### Stage 2 — Margin dry-run (`margin agent install <manifest> --dry-run`)

Today this already performs, without changing anything:

| Check | Where |
|---|---|
| closed-spec validation (`specVersion`, `type`, `label`, closed `kind` enums, extractor shapes, literal-only `where`) | `spec.js#validateDescriptor` |
| cross-field capability/wiring consistency | `spec.js` cross-field block |
| composition satisfiability (does a reader exist for every referenced `kind`) | `compose.js#compositionProblems`, surfaced by `load.js` as `descriptor_adapter_missing` |
| built-in type protection and duplicate-type refusal | `agentInstall.js`, `load.js` |
| home resolution over every candidate, with per-candidate exists/probe result | `readers.js#resolveAgentHome` |
| structural probe | `readers.js#probeDescriptor` |

The report already distinguishes `descriptorChange` ∈ `created|updated|unchanged` and
`sourceChange` ∈ `registered|enabled|adopted|unchanged`, which is the property that makes a
repeatable loop possible.

### Stage 3 — Observation (the missing link, proposed)

Stage 2 proves the manifest is **well-formed and satisfiable**. It does not prove it is **true**. A
manifest can resolve a home, pass the structural probe, and still project zero sessions — which is
the single most confusing outcome the existing code comments keep warning about
(*"Registered but reads nothing"*).

The minimal addition that closes this is a read-only verification step:

```
margin agent verify <manifest> [--path <home>] [--dry-run]
```

which runs Stage 2 and then, against the resolved home:

1. enumerate the declared roots, reporting the count;
2. project **at most a handful** of sessions through the composed adapter;
3. assert the projection invariants the readers already enforce — every session has a non-empty
   `nativeSessionId`, a resolvable workspace, and `createdAt`/`updatedAt` that parse as dates;
4. report `sessionsObserved`, `projectionFailures[]` with the reason a session was dropped, and
   `executionStatusDistribution`.

Exit status is decided by observation, not by declaration:

| outcome | meaning |
|---|---|
| `verified` | validation + composition + probe + ≥ 1 correctly projected session |
| `no_sessions` | structurally valid, zero sessions projected → report `probe ok, session count 0` |
| `unavailable` | the home does not exist on this machine → manifest is installable, source not registered |
| `rejected` | validation, composition, or a projection invariant failed |

`no_sessions` must **not** be an error and must **not** be `verified`. It is a distinct, reportable
state, because "installed but not yet attached" is legitimate (`agentInstall.js` already warns
`no_home_found` rather than failing).

**Full parity with the existing built-ins is out of reach and should not be the goal.** Codex, Claude,
and Pi all pass Stage 3 (their readers project real sessions) but all three would fail a naive parity
test on resources and handoff. `verified` therefore means *"the declared surfaces observe correctly"*,
never *"this Agent is supported"*.

### 6.1 What the three stages cannot validate

Stating this explicitly, because a report that hides it is worse than no report:

| Not validated | Why | Where it must be said |
|---|---|---|
| that the Agent will keep this layout in its next version | no upstream commitment exists | `report.unverified[]` |
| that an archived/deleted session is excluded | the Agent may have no archive signal at all (Codex has one; 豆包 does not) | `report.unverified[]` |
| that no credential leaked | the Agent asserts it; only a scan can partially check | `report.redaction{}` + a Margin-side scan at install |
| that `weak` bindings are *correct*, only that they are labelled | a workspace recovered from free text can be wrong | manifest binding shape + report status |
| that the Agent did not simply lie | nothing can; mitigations are in `integration-security-boundary.md` | install-time user confirmation |

---

## 7. Division of labour

| Step | Owner | Authority |
|---|---|---|
| Discover own layout, fields, status signal, resource surface | **Agent** | claims |
| Emit manifest + report | **Agent** | claims |
| Redact secrets from artifacts | **Agent**, checked by **Margin** | claim + scan |
| Validate schema and cross-field consistency | **Margin** | authoritative |
| Decide whether a reader exists for a declared `kind` | **Margin** | authoritative |
| Resolve candidate homes against the real filesystem | **Margin** | authoritative |
| Project real sessions and report failures | **Margin** | authoritative |
| Install (write `~/.margin/agents/<type>.json`, register source) | **Margin**, after user confirmation | authoritative |
| Clear a tombstone / uninstall | **Margin** | authoritative |
| Add a new `kind` to the catalogue | **Margin**, by human decision | **never delegated** |

The last row is the boundary this whole design defends. The Agent may describe *itself*; it may not
extend *Margin's* capability catalogue. See `integration-security-boundary.md`.

---

## 8. Failure modes the skill must name, not hide

| Failure | Required output |
|---|---|
| Session store is opaque (SQLite/encrypted/remote) | `session.kind: "none"`, reason `opaque_store`, a `requests[]` entry |
| No native id, only a filename | `id: { "kind": "filename" }`, claim status `weak` |
| No native timestamps | `mtime` extractor, claim status `weak`, and the report must say timestamps are file-write times |
| No native workspace field | `scanAbsolutePaths` (+ `requireMarker` if a project marker exists), claim status `weak` |
| No terminal status marker | `executionStatus.kind: "none"` → `capabilities.executionStatus: false` |
| Status marker exists but no error value ever observed | map only the observed values; `error` stays unmapped → `unknown`, which is the honest answer |
| Quota only via a credentialed endpoint | `resources.kind: "none"`, `capabilities.quota: false`, `requests[]` with provenance |
| Handoff would need a transcript distiller | `handoff.kind: "none"`, `capabilities.handoff: false`, `requests[]` |
| Multiple rollouts/files share one session id | report it in `unverified[]` — it is an archival/dedup question Margin must decide, not the Agent |
| The Agent cannot determine something | `unverified[]`. An empty `unverified[]` on a first attempt is itself suspicious and the skill says so. |

---

## 9. What this design deliberately does not do

* **No adapter code generation.** See `integration-security-boundary.md` for the full argument.
* **No new manifest format.** v0.1 is the existing descriptor with three additive fields
  (`agent-manifest-schema.md`). Introducing a second format alongside `~/.margin/agents/*.json`
  would mean two loaders, two validators, and a migration — for no new capability.
* **No network on Margin's side.** Unchanged from today.
* **No capability that no reader can serve.** `runtimeControl` is pinned `false` in v0.1; resource
  and handoff capabilities for a self-integrated Agent are `false` and land in `requests[]`.
* **No Marketplace, registry, index, or version-resolution.** Obtaining the skill is the Agent's job.
* **No replacement of the built-in readers.** Codex, Claude, and Pi keep their hand-written readers;
  the matrix shows why each one exists.
