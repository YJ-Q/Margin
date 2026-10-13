# Integration Security Boundary

Status: **Research only.** No code in this slice. Nothing here is implemented.
Related: `margin-agent-integration-skill.md`, `agent-manifest-schema.md`.
Written at: commit `1c822e5`.

---

## 1. The question

If an Agent can generate its own integration, it can also generate an integration that does something
Margin did not intend. Two designs are on the table:

* **A — declarative manifest.** The Agent emits data. Margin validates it against a closed schema and
  composes a reader from its own fixed catalogue.
* **B — generated adapter code.** The Agent emits code (JS, or a plugin, or a script) that Margin
  loads and runs.

This document argues A, states the residual risks of A honestly, and specifies what B would require if
it were ever wanted.

---

## 2. Why declarative manifest first

### 2.1 The repository already decided this, and wrote down why

`src/agents/descriptor/spec.js`, header:

> *"A descriptor is DATA, never code. Margin validates it against this closed spec and composes an
> adapter from a fixed catalogue of readers. Nothing in a descriptor is evaluated as an expression,
> and a descriptor cannot introduce behaviour outside the catalogue. **That is the deliberate limit
> which keeps a user-supplied JSON file from becoming an execution surface inside the Margin
> process.**"*

`src/agents/agentInstall.js`, header:

> *"Neither of them fetches anything over the network: obtaining the plugin is the Agent's job, so
> **Margin never gains a download-and-execute surface**."*

The design under research (agent self-integration) does not create a new decision point here. It
*increases the number and variety of manifest authors* — from a handful of human plugin authors to
every Agent the user wants to onboard — and therefore **raises the value of the boundary that already
exists**. That is the main security argument for doing the skill on top of the descriptor spec rather
than beside it.

### 2.2 Declaration happens before use, and can be refused

The decisive property of the declarative path is *ordering*:

```
emit → validate (closed schema, closed enums, literal-only filters)
     → compose (is a reader named that actually exists?)
     → resolve (does a candidate home exist and pass its probe?)
     → project (read-only; failures returned as ok:false, never as "no sessions")
     → install (explicit, dry-runnable, user-confirmed)
```

Every stage before `install` is side-effect-free and refuses rather than degrades. Concrete evidence
that refusal is the house style, not an aspiration:

| Behaviour | Where | Note |
|---|---|---|
| malformed / unsatisfiable descriptor is **reported**, never silently skipped | `load.js` (header + `problems[]`) | *"a malformed or unsatisfiable descriptor is REPORTED, never silently skipped"* |
| a user descriptor can never take over a built-in type | `load.js` → `descriptor_duplicate_type` | anti-privilege-escalation |
| a built-in type can never be installed from, or removed by, a file | `agentInstall.js` → `builtin_type` | |
| `capabilities.handoff: true` with `handoff.kind: "none"` is a **validation error** | `spec.js` cross-field block | not a runtime fallback to another Agent's transcript |
| a probe failure is a distinct, reported outcome | `readers.js#probeDescriptor` | "registered but reads nothing" made diagnosable |
| a read failure throws and becomes `ok: false` | `compose.js#snapshotRead`, `discoverTranscriptSessions` | a transient failure can never be published as an empty Agent |
| dry-run is first-class on install and uninstall | `agentInstall.js`, `agentSourceCli.js` | the intended loop is repeatable |

Declarative-first is not a purity argument. It is that **a refused manifest produces a diagnostic, and
a refused code plugin produces an incident.**

### 2.3 The catalogue is small enough to audit

`readers.js` is ~390 lines and contains: two substitutions, one glob compiler (`*` / `**`, everything
else escaped so a glob cannot smuggle a regex), four field extractors, one transcript format, and one
text scan for absolute paths. There is no `eval`, no `new Function`, no `require`, no `import`, no
regex-from-data, no operator evaluation (`where` is literal equality only).

That is the entire expressiveness of a manifest. A reviewer can hold it in their head, and the
security-relevant question ("can data in this file cause an action?") has a one-word answer: no, apart
from reads bounded by the walk limits in §3.1.

---

## 3. Why not generated adapter code

Seven concrete reasons, in descending order of how hard they are to argue with.

### 3.1 Margin's process holds credentials

The credentials Margin reads today, and where they live:

| Credential | Source | Handling today |
|---|---|---|
| OpenCode Go key | `{piHome}/agent/auth.json` → `['opencode-go'].key` (`opencodeGoQuota.js#resolveOpenCodeGoCredential`) | held in memory only while the request is built; **never** in the source registry, a DTO, telemetry, HANDOFF, or a log |
| Claude OpenCode Go token | CC Switch `cc-switch.db` → `providers.settings_config.env.ANTHROPIC_AUTH_TOKEN` \|\| `…_API_KEY` (`claudeOpenCodeGoBinding.js`) | attached with `Object.defineProperty(..., { enumerable: false })` so accidental JSON serialisation cannot leak it |

Both are reachable from any module running in the Margin process. The existing readers are careful for
a reason — and their care is *code review*, not a mechanism. Generated adapter code would run in the
same process with the same `process.env`, the same filesystem access, and the same in-memory access.
A single `JSON.stringify` of a value the author did not think about exfiltrates a paid credential.

There is no sandbox today. The `enumerable: false` trick is a *serialisation* guard, not an access
guard.

### 3.2 Margin's process already has broad filesystem and process authority

The readers legitimately do things that are indistinguishable from what a malicious adapter would
want: recursive directory walks, reading the user's profile, spawning `git rev-parse`
(`session-source.js#probeWorkspaceIdentity`), spawning a short-lived Node child with
`ELECTRON_RUN_AS_NODE=1` to read VS Code's SQLite (`claudeArchiveState.js`), and reading
`state.vscdb`. Any of those primitives, pointed at a different path, is a data-exfiltration or
DoS primitive. Code in-process inherits all of them.

### 3.3 The audit surface becomes unbounded

Today, "what can a manifest do?" is answered by reading 390 lines of `readers.js` **once**, forever,
regardless of how many Agents are installed. With generated code, it is answered by reading every
generated adapter, and re-answering it on every Agent upgrade, on every machine. Nothing about the
declarative layer's reviewability survives.

### 3.4 Data can be diffed, reviewed, and rolled back; code must be trusted or sandboxed

A manifest is a few hundred bytes of JSON. It can be diffed between Agent versions, held in review,
rejected, and regenerated. The install path is already publish-by-rename and idempotent
(`agentInstall.js#writeDescriptorFile`, `sourceRegistry.js#writeAgentSourceRegistry`), so a bad
manifest is replaced, not accumulated.

There is no equivalent safe handling for a bad code adapter except "do not run it", which means either
trust or a sandbox (§4).

### 3.5 The failure modes of A are legible; the failure modes of B are not

From the capability matrix, the failure modes of a declarative manifest are known and bounded:

| Failure | Diagnostic today |
|---|---|
| typo'd key | silently ignored (**G2** — proposed to become an error) |
| capability claimed without wiring | validation error for `handoff`/`executionStatus`; silently `unavailable` for the resource family (**G1** — proposed to become an error) |
| wrong root | `probe ok` / `Path does not exist`, reported per candidate |
| valid but empty | distinct `no_sessions` outcome (proposed Stage 3) |

Every one of these is a *message*. A code adapter's failure modes include silent wrong answers,
credential leakage, and arbitrary side effects, and none of them produce a message.

### 3.6 It contradicts the multi-context discipline the project just adopted

ADR 003 splits Margin into a writable **Core** (state Margin owns, reachable only via
`MarginApplicationContract`) and a **read-only Runtime Context** (external Agent facts). The Runtime
adapter discipline is explicit: *"Runtime adapter 不得直接写 SQLite、不得缓存可写状态"* — no direct
SQLite writes, no writable cached state.

Generated adapter code is exactly a mechanism for putting arbitrary code in the Runtime Context. It
would carry no Core authority today only because the reader happens not to be wired to Core — which is
a wiring fact, not an enforced boundary. A future refactor that injects a Core handle into an adapter
(e.g. the `run.bind_session` resolver, which is already injected into the Board as `resolveRuns`)
would silently hand every generated adapter that handle too.

### 3.7 The information advantage does not require code

The premise of the whole research is that the Agent knows its own layout better than Margin. That
knowledge is *facts*: a path, a field name, a status value, a layout. Every one of them is expressible
as data — 豆包 is the proof: a non-trivial third-party Agent, integrated with a JSON file and zero
Margin code (`plugins/doubao/`, `test/agentDescriptor.test.js`).

Generated code would only be needed for the capabilities that are *already* hand-written readers:
resource, handoff, and runtime control. Those are exactly the capabilities where the interesting
question is not "what does the Agent know" but "should Margin do this at all" — i.e. credentials,
network egress, and process control. Delegating those to the Agent's own generator is delegating the
decision, not the work.

---

## 4. Risks in the declarative design itself

Being honest about A does not mean claiming A is risk-free. These are the real risks, with what exists
today and what is proposed. Risk IDs are referenced from `s10.1b-decision.md`.

### R1 — Path over-reach (highest practical risk)

| | |
|---|---|
| **What** | `sessions.roots` is expanded from a template (`{home}`, `{profile}`, `%ENV:X%`) and then `readdirSync`'d directly (`readers.js#discoverTranscriptSessions`). There is **no containment check** that a resolved root sits inside the declared home. `roots: ["{profile}"]` or `["C:/"]` is a legal declaration. |
| **Impact** | Margin enumerates and parses unrelated files. Bounds limit the damage (4 000 files per session walk, depth 12, 2 000 sessions) but do not prevent the walk. Combined with the fact that a manifest is *generated by the Agent being integrated*, a buggy generator is as likely as a hostile one. |
| **Today** | Bounds only: `MAX_FILES_PER_SESSION = 4000`, depth `12`, `MAX_SESSIONS = 2000`, `MAX_PATH_CANDIDATES = 200`, `MAX_META_PROBE_BYTES = 256 KiB`. |
| **Proposed** | Reject a resolved home that is a filesystem root or the profile root; require every `roots` expansion to be path-contained within the resolved home. A pure semantic rule with no expressiveness cost. |

### R2 — Resource amplification / denial of service

| | |
|---|---|
| **What** | A manifest can point at a very large tree. Even inside the home, an Agent with hundreds of thousands of session files makes a revision poll (`stat`-only, recursive) and a discovery expensive. |
| **Impact** | UI stalls, CPU burn, git-spawn storms (mitigated by the 10 s identity cache). |
| **Today** | Per-call bounds and the stat-only revision signature (`≈1 ms` claimed for the Codex tree). No per-source time budget. |
| **Proposed** | Keep the bounds; add a wall-clock budget for a single discovery and report `source_read_failed`/`too_large` distinctly rather than truncating silently. Do not add this speculatively — only if Stage 3 observation measures a real cost. |

### R3 — Credential disclosure by the *skill*, not the manifest

| | |
|---|---|
| **What** | The Agent inspects its own auth store to answer Step 4 and pastes a key value into the report or the transcript. This is the most likely real-world leak in the whole design, because the skill *asks* the Agent to go looking at its own credential files. |
| **Impact** | A key ends up in a Markdown report, a chat log, or a committed artifact. |
| **Today** | Two precedents exist to reuse: `test/repositoryPrivacy.test.js` (a privacy guard that scans for escaped path forms and was hardened after a false-green incident), and `claudeArchiveState.js#sanitized` (a redaction helper that rewrites `C:\Users\<name>\` → `C:\Users\<user>\`). Neither is wired to a manifest. |
| **Proposed** | (a) `SKILL.md` rule 3: existence, path, and key *name* may be reported; values may not; a hash of a short secret is also a secret; (b) the report carries a `redaction{}` block; (c) Margin **scans the manifest and the report at install time** for anything that looks like a credential (long high-entropy tokens, known key prefixes, `auth.json` value shapes) and blocks install on a hit. This is the one place where a scanner is worth its cost. |

### R4 — False claims / silent half-wiring

| | |
|---|---|
| **What** | A manifest declares a capability whose wiring cannot deliver it. |
| **Impact** | "Agent appears integrated, shows nothing" — the failure the spec header names as the most confusing part of onboarding. |
| **Today** | Enforced for `handoff` and `executionStatus`. **Not** enforced for `quota`, `apiUsage`, `subscriptionQuota` (**G1**): a plugin can declare `quota: true` with `resources.kind: "none"`, validate cleanly, and render permanently `unavailable`. |
| **Proposed** | The four cross-field rules in `agent-manifest-schema.md` §6.3, plus the closed top-level key set (**G2**) so a typo'd capability key cannot be silently ignored. |

### R5 — Provenance and trust

| | |
|---|---|
| **What** | A self-generated manifest is a claim by an interested party. There is no signature, no `generatedBy`, and no distinction between "the vendor shipped this plugin" and "the Agent wrote this about itself". |
| **Impact** | A user cannot tell which trust posture they are in; an install report cannot either. |
| **Today** | Nothing. `source: 'builtin'` vs a file path is the only provenance. |
| **Proposed** | `generatedBy` (informational only — **no behaviour may branch on it**), and keep the existing dry-run + explicit user confirmation. Do **not** add signatures in v0.1: a signature proves *who* wrote the manifest, not that it is true, and there is no key-distribution story worth its cost. |

### R6 — Type squatting

| | |
|---|---|
| **What** | A plugin registers `type` values that a future built-in will want. |
| **Impact** | Low. |
| **Today** | Handled correctly and should stay: a built-in descriptor owns its type, the user file is reported as `descriptor_duplicate_type` and does not take effect. |
| **Proposed** | Document it as a security property, not just a loading preference. Reserve the namespace `margin-*` and obvious vendor names if that ever matters — not needed now. |

### R7 — Environment-variable expansion as a data channel

| | |
|---|---|
| **What** | `%ENV:NAME%` expands any process environment variable. |
| **Impact** | Low. The value is used as a **path** and the path must exist, so it is not a value channel. A manifest referencing `%ENV:OPENAI_API_KEY%` produces a non-existent path, not a leaked value. The real risk is the *reverse* direction: a path or error message containing an environment-derived value being reported back. |
| **Today** | `expandTemplate` is path-only; `resolveAgentHome` reports resolved candidate paths. |
| **Proposed** | State "path channel only" as an explicit schema rule, and redact resolved paths in install/verify output the way `claudeArchiveState.sanitized` already does. |

### R8 — Round-tripping through the Agent's own context

| | |
|---|---|
| **What** | The skill asks the Agent to read session files and quote a sampled record. A sampled record can contain the user's private conversation, source code, or a secret the user pasted into a prompt. |
| **Impact** | Private content lands in the report or the Agent's context window, and from there possibly in a log or a commit. |
| **Today** | The design's discipline is "field names and value *types* only" (`SKILL.md` Step 2). |
| **Proposed** | The skill must state: sample **key names and value shapes**, not values; the only value-level exceptions are a timestamp format, an absolute path in a declared-root context, and the enumerated raw values of the status field. The report's `claims[].evidence` must not carry raw record content. Add this to the redaction scan in R3. |

### R9 — Behavioural drift of an already-installed manifest

| | |
|---|---|
| **What** | The Agent upgrades, keeps the same manifest, and the manifest now points at a path that means something different — or a tombstone/registration silently survives. |
| **Impact** | Stale reads, or a removed Agent reappearing. |
| **Today** | Well handled: the descriptor cache is keyed on the directory signature (file set + size + mtime); detection never resurrects a `suppressed` record; `registerAgentSource` treats a disabled/suppressed/manual record as sticky. |
| **Proposed** | Nothing. This is a place where the existing design is already correct and should be preserved verbatim by any change. |

---

## 5. What a future sandbox adapter would require

If Margin ever decides that a capability genuinely needs generated code — most plausibly a
credentialed resource reader — the following is the *minimum* shape. This is not a proposal; it is the
checklist that would have to be satisfied, recorded so that "let the Agent write code" is a
well-defined idea rather than a vague one.

**Process isolation**
1. A separate process, with no access to Margin's in-memory state, no Core handle, no adapter
   registry.
2. No inheritance of Margin's environment. An explicit, minimal env allow-list per adapter.
3. A declared, enforced read-root grant list — the adapter may open files only under those roots, and
   the grant is checked by the host, not the adapter.

**Network and credentials**
4. Network denied by default. Any egress requires a declared host allow-list AND explicit user
   consent at install time, shown in the dry-run report.
5. Credential brokering: the **host** performs the authenticated request. The adapter never receives
   the secret. (This is what `claudeOpenCodeGoBinding.js` already does conceptually — Margin resolves
   the binding and builds the request, and the credential is non-enumerable.)
6. No telemetry, no dynamic host resolution, no redirect following outside the allow-list.

**Contract**
7. The interface is the existing bounded adapter shape, spoken over a line-framed stdio/RPC —
   `discoverSessions`, `getSessionRevision`, `collectResourceSnapshot`, `probe`, and nothing else. No
   new methods invented by the adapter.
8. The host owns LKG / staleness / `resourceStatusOf` semantics (§2.2 of the capability matrix). An
   adapter may report a reading; it may not report a *status*.
9. Every call carries a request id and a deadline; a hung adapter is killed and reported as
   `source_read_failed`.

**Resource limits**
10. CPU, memory, wall-clock, and file-count ceilings per call, enforced by the host.
11. Output size caps on every response, matching the existing `OUTPUT_LIMIT_BYTES = 32 KiB`
    discipline in `marginPiAdapter.js`.

**Supply chain**
12. The artifact is content-addressed and pinned by hash; an update is a new artifact and a new
    install, never an in-place mutation.
13. Optional signature/attestation, with a stated key-distribution story. Absent that story,
    provenance is recorded (`generatedBy`) but not trusted.

**Operability**
14. Per-adapter disable and a global kill switch, effective without a restart.
15. An audit line for every file opened and every request made, written where the user can read it.
16. A documented review path: what a reviewer must read before enabling, and what "correct" looks
    like.

Until 1–16 exist, a manifest that names any of these capabilities is refused, and the Agent's
knowledge of them goes into `report.requests[]` as documentation. That is the whole of the security
boundary:

> **The Agent may describe itself. The Agent may not extend Margin's capability catalogue, and may not
> execute anything inside Margin.**

---

## 6. Residual risk statement

After the proposed mitigations, the following remain true and should be stated in the skill and the
decision record rather than papered over:

1. **A manifest can be wrong.** It is a claim, not evidence. Stage 3 observation reduces this to "the
   projection succeeded on this machine at this time", which is the strongest claim the system can
   honestly make.
2. **A manifest can enumerate files the user did not intend.** R1's containment rule removes the
   worst cases; a legitimate home can still contain private files, and Margin will read the ones the
   manifest names as transcripts.
3. **A malicious Agent can lie in its report.** `claims[].evidence` is written by the Agent. The
   defence is that Margin's own Stage 2/3 checks do not read the report — the report is for the human.
4. **Redaction is best-effort.** R3's scan catches shapes, not meaning. The strongest control is that
   the skill never needs a credential value.
5. **Installing a manifest grants a read grant, not a write grant** — and that is the property worth
   preserving above all others. The Runtime Context is read-only by construction
   (`docs/architecture/adr/003-surface-and-state-ownership.md`); nothing in this research may weaken
   it.

---

## 7. Summary

| Question | Answer |
|---|---|
| Why declarative manifest first? | It is the format Margin already ships, it is refused rather than degraded, it happens before any side effect, and the entire expressiveness fits in ~390 auditable lines with no evaluation. |
| Why not generated adapter code? | It would run with Margin's credentials, filesystem, and process authority in-process; there is no sandbox; the audit surface becomes unbounded; it contradicts the Runtime Context's read-only discipline; and the information advantage it would buy is expressible as data. |
| What risks exist? | Path over-reach (R1), resource amplification (R2), credential disclosure by the skill (R3), false claims / half-wiring (R4), missing provenance (R5), type squatting (R6), env-as-channel (R7), private content in the report (R8). Drift (R9) is already handled correctly. |
| What would a sandbox adapter require? | A separate process with explicit grants, no inherited env, network-deny-by-default, host-side credential brokering, the existing bounded contract over a framed channel, host-owned status semantics, hard resource limits, content-addressed pinning, a kill switch, an audit line, and a documented review path — sixteen conditions, none of which exist today. |
