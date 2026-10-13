# Agent Self-Integration Validation — synthetic "Nova" fixture

Status: **Prototype / research validation slice. Report only; no core code changed.**
Version: `package.json` `0.1.0` (v0.1.0 Beta), commit `a3dafb4`.
Depends on: `margin-agent-integration-skill.md`, `agent-manifest-schema.md`,
`integration-security-boundary.md`, `s10.1b-decision.md`.
Artifacts: `plugins/nova/agent.json`, `plugins/nova/README.md`, `test/agentSelfIntegration.test.js`.

---

## 0. Question

> Can Margin's **existing** descriptor protocol support Agent self-integration without adding
> hardcoded adapters?

The slice answers it by running the full workflow against a synthetic Agent Margin has never seen:

```
Nova fixture  →  Integration Skill output (descriptor)  →  validateDescriptor
              →  install --dry-run  →  compose (adapterFor)  →  read-only verification
              →  session discovery
```

**No-go constraints honoured:** no real fourth Agent, no capability expansion, no runtime provider, no
quota provider, no handoff change, no release change, no plugin marketplace, no runtime code
execution, no generated adapters. `src/**` is untouched.

---

## 1. Fixture design

**Nova** is a synthetic Agent whose on-disk shape is deliberately *harder* than the shipped `doubao`
plugin. `doubao` has no native working directory and no native timestamps, so it leans on
`scanAbsolutePaths` (recovered workspace) and `mtime` (file-write times). Nova is the opposite: every
projection field is a **native value read from a nested record stream**, and its native id is
deliberately different from its rollout directory name.

### 1.1 On-disk layout

```
{home}/sessions/
  rollout_0001/events.jsonl      native id nova-7f3a1c9e
  rollout_0002/events.jsonl      native id nova-2b8d4f01
  rollout_0003/events.jsonl      interrupted: no session.end record
```

`{home}` resolves from `NOVA_HOME`, falling back to `{profile}/.nova` (then `{profile}/.config/nova`).

### 1.2 Record stream (the "unknown Agent" schema)

```jsonc
{"kind":"session.start","seq":1,"session":{"id":"nova-7f3a1c9e","cwd":"D:\\repo\\margin-core","createdAt":"2026-05-04T09:12:33.000Z"},"title":"Wire descriptor validation harness"}
{"kind":"turn.user","seq":2,"text":"Wire descriptor validation harness"}
{"kind":"turn.assistant","seq":3,"finishReason":"tool_use","model":"nova-1-large","provider":"nova-labs"}
{"kind":"turn.assistant","seq":4,"finishReason":"stop","model":"nova-2-large","provider":"nova-labs"}
{"kind":"session.end","seq":5,"session":{"updatedAt":"2026-05-04T09:41:07.000Z"}}
```

### 1.3 Surface → binding

| Fixture surface | Native location | Descriptor binding |
|---|---|---|
| session data | `{home}/sessions/<rollout>/events.jsonl` | `sessions.kind:"transcript"`, `transcript.glob` |
| native session identity | `session.id` on `session.start` | `id: { kind:"record", where:{kind:"session.start"}, path:"session.id" }` |
| workspace information | `session.cwd` on `session.start` | `workspace: { kind:"record", …, path:"session.cwd" }` |
| created / updated timestamps | `session.createdAt` / `session.updatedAt` (ISO-8601) | `record` extractors, `pick`/`index` |
| execution status | `turn.assistant.finishReason` | `executionStatus:{ kind:"transcript", map:{…} }` |

The fixture builder lives in `test/agentSelfIntegration.test.js` (`writeNovaFixture`); the `cwd`
values are the only machine-local part, because a real Agent records the absolute directory it
actually ran in.

---

## 2. Generated descriptor

The "Integration Skill output" is `plugins/nova/agent.json` — **data only**. Key bindings:

```jsonc
{
  "specVersion": 1,
  "type": "nova", "label": "Nova", "provider": "nova-labs", "resourceAgent": "nova",
  "envHome": "NOVA_HOME",
  "homeCandidates": [
    { "env": "NOVA_HOME", "fallback": "{profile}/.nova" },
    { "fallback": "{profile}/.config/nova" }
  ],
  "capabilities": { "sessions": true, "handoff": false, "apiUsage": false, "quota": false,
                    "executionStatus": true, "attentionStatus": false },
  "sessionCapabilities": { "executionStatus": true },
  "sessions": {
    "kind": "transcript", "layout": "directory-per-session",
    "roots": ["{home}/sessions"],
    "transcript": { "glob": "events.jsonl", "format": "jsonl" },
    "id":        { "kind": "record", "where": { "kind": "session.start" }, "index": 0,      "path": "session.id" },
    "createdAt": { "kind": "record", "where": { "kind": "session.start" }, "index": 0,      "path": "session.createdAt" },
    "updatedAt": { "kind": "record", "where": { "kind": "session.end" },   "index": "last", "path": "session.updatedAt" },
    "workspace": { "kind": "record", "where": { "kind": "session.start" }, "index": 0,      "path": "session.cwd" },
    "title":     { "kind": "record", "where": { "kind": "turn.user" },     "index": 0,      "path": "text", "as": "first-user-message" },
    "model":     { "kind": "record", "where": { "kind": "turn.assistant" },"index": "last", "path": "model" },
    "provider":  { "kind": "record", "where": { "kind": "turn.assistant" },"index": "last", "path": "provider" }
  },
  "executionStatus": {
    "kind": "transcript", "where": { "kind": "turn.assistant" },
    "path": "finishReason", "pick": "last",
    "map": { "stop": "idle", "tool_use": "working", "error": "error", "cancelled": "idle" }
  },
  "resources": { "kind": "none" },
  "handoff":   { "kind": "none" },
  "probe": { "anyOf": [{ "glob": "{home}/sessions/*/events.jsonl" }] }
}
```

The descriptor uses **only current protocol keys**. `resources`/`handoff` are `none` and the
resource/handoff capabilities are `false` by design — Nova's quota needs a credential and its handoff
needs a distiller, neither of which the catalogue expresses, and claiming one without a reader is a
validation error.

---

## 3. Validation flow

| Stage | What runs | Result |
|---|---|---|
| 1. Skill output | `plugins/nova/agent.json` | data only; no code, no expressions |
| 2. `validateDescriptor` | `src/agents/descriptor/spec.js` | **ok** |
| 3. `installAgentDescriptor --dry-run` | `src/agents/agentInstall.js` | `ok`, `descriptorChange:"created"`, `sourceChange:"registered"`, **no writes** |
| 4. `install` + `adapterFor` | `compose.js` | adapter composed with **no Margin code change** |
| 5. Read-only verification | `resolveAgentHome` + `probeDescriptor` + `collectSessionSnapshots` | probe `ok`, invariants pass |
| 6. Session discovery | `discoverTranscriptSessions` | 2 of 3 rollouts projected |

Hardened validation exercised at stage 2 (`test/agentSelfIntegration.test.js`):

* **Closed top-level keys** — `checkTopLevelKeys` rejects any key outside
  `DESCRIPTOR_TOP_LEVEL_KEYS` (19 keys) with an edit-distance suggestion; `$comment*` stays reserved.
* **Capability / resource consistency** — `quota` / `apiUsage` / `subscriptionQuota` require
  `resources.kind !== "none"`; `handoff`/`executionStatus` must match their section `kind`.
* **Root containment** — static: `sessions.roots[i]` must be `{home}` or beneath it
  (`checkSessionRoot`); dynamic: `isPathContained` re-checks the expanded root at read time.

---

## 4. Verification result

Captured from a fresh temp profile (real output, reproduced by `npm test`):

```
[valid] ok=true
[install] true created registered <temp>/nova-home
[discovered] 2
{"nativeSessionId":"nova-7f3a1c9e","canonicalId":"nova:nova-433633e38807:nova-7f3a1c9e",
 "cwd":"…\\workspaces\\margin-core","workspaceName":"margin-core",
 "createdAt":"2026-05-04T09:12:33.000Z","updatedAt":"2026-05-04T09:41:07.000Z",
 "executionStatus":"idle","displayTitle":"Wire descriptor validation harness",
 "model":"nova-2-large","dir":"rollout_0001"}
{"nativeSessionId":"nova-2b8d4f01","canonicalId":"nova:nova-433633e38807:nova-2b8d4f01",
 "cwd":"…\\workspaces\\margin-web","workspaceName":"margin-web",
 "createdAt":"2026-05-04T10:02:11.000Z","updatedAt":"2026-05-04T10:05:48.000Z",
 "executionStatus":"error","displayTitle":"Fix workspace name resolution",
 "model":"nova-1-small","dir":"rollout_0002"}
```

Acceptance criteria from the slice brief:

| # | Criterion | Result |
|---|---|---|
| 3a | at least one session discovered | **2** projected; the interrupted `rollout_0003` is dropped, not published with invented values |
| 3b | native id preserved | `nova-7f3a1c9e` / `nova-2b8d4f01` read from `session.id`; directory is `rollout_0001`, so the id is **not** path-derived |
| 3c | workspace resolved | `cwd` = native `session.cwd`; `workspaceName` = `margin-core` / `margin-web` |
| 3d | timestamps parsed | exact native ISO values, `Date.parse` finite; **not** file mtimes |
| 1 | declarative descriptor generated | §2 / `plugins/nova/agent.json` |
| 2 | passes hardened validation | closed keys + capability/resource + root containment, all green |
| 4 | invalid declarations fail | §6 below, each with the exact current error |
| 5 | no Margin core changes | `src/**` untouched; the adapter composes from the descriptor alone |

Additional invariants verified: `probe.valid === true`; `readSessionSnapshots` envelope `ok`; a
64-char revision hash; resource envelope honestly `unavailable` (no fabricated record); detection
does not duplicate the registration; uninstall then detection does not resurrect Nova.

---

## 5. Is self-integration feasible?

**Yes — for the session axis, through the current protocol, with zero core changes.** A synthetic
Agent Margin has never seen was described by a ~60-line JSON file, validated by the current hardened
spec, installed, composed into the full ten-method adapter contract, probed, and projected into
correct session DTOs with native identity, workspace, and timestamps intact.

This is a stronger result than the existing `doubao` evidence, because Nova exercises the *native*
path (`record` extractors for id / cwd / created / updated) rather than the recovery path
(`scanAbsolutePaths` + `mtime`). The bounded catalogue is sufficient for a plausible unknown Agent
whose store is plain single-file JSONL.

**Scope of the claim, stated precisely.** Feasible for: session discovery, native identity, native
workspace, native timestamps, transcript-derived execution status, and multi-candidate home
resolution. **Not** feasible, and not attempted: resources (credential/network), handoff (distiller),
runtime control, and multi-source/archived session shapes. Those remain built-in-reader territory per
`s10.1b-decision.md`.

**The §7 gate is not satisfied by this slice.** `s10.1b-decision.md` §7 requires a *real* Agent,
driven *unaided* by the skill. A synthetic fixture validates the **mechanism** and the **failure
handling**; it cannot answer "does a real Agent's self-description survive first contact". This slice
is the pre-spike harness, not the S10.2 spike.

---

## 6. Invalid declarations must fail — proof

Each is refused by the *current* validator with an actionable message (captured verbatim):

| Invalid declaration | Current error |
|---|---|
| `capabilities.quota: true`, `resources.kind:"none"` | `capabilities.quota is true but resources.kind is none; declare a resource reader that can deliver it` |
| `capabilities.apiUsage` / `subscriptionQuota` likewise | same rule, per capability |
| `roots: ["{profile}/.nova/sessions"]` | `sessions.roots[0] must be {home} or a path beneath it so reads stay inside the Agent home` |
| `roots: ["C:/nova/sessions"]` | same root-containment error |
| `roots: ["{home}/../escape"]` | passes the static anchor, then `session_root_outside_home` thrown at read time by `isPathContained` |
| `generatedBy: { … }` | `unknown top-level key "generatedBy"` |
| `runtime: { kind:"none", control:false }` | `unknown top-level key "runtime"` |
| `resource: { kind:"none" }` (typo) | `unknown top-level key "resource"; did you mean "resources"?` |
| `capabilities.handoff: true`, `handoff.kind:"none"` | `capabilities.handoff is true but handoff.kind is none` |

All nine are asserted in `test/agentSelfIntegration.test.js`.

---

## 7. Blockers discovered

Ordered by how much they matter for a *self-integration program*, not for this fixture.

### B1 — The proposed manifest fields are ahead of the implementation (documentation/implementation drift)

`agent-manifest-schema.md` marks `generatedBy` (§7.3) and `runtime` (§5.3) as **[proposed]** additive
fields, and `margin-agent-integration-skill.md` §5.1 says the skill emits them. The current validator
**closes the top-level key set** (V1, already shipped as a hardening fix) and therefore **refuses
both**. A skill that follows the research document literally would fail validation on its very first
field. The skill's instructions and the shipped spec must be reconciled: today's skill output must
emit **only current keys**, and `generatedBy`/`runtime` stay research until implemented.
*This is a documentation gap, not a missing primitive.*

### B2 — There is no read-only verification verb (`margin agent verify`)

The slice's "read-only verification" stage had to be assembled inside the test from
`resolveAgentHome` + `probeDescriptor` + `collectSessionSnapshots` + manual invariant checks. This is
exactly **V4** in `s10.1b-decision.md` §5, and it does not exist: `margin agent` supports
`list|detect|add|remove|enable|install|uninstall`. Without it, "installed but reads nothing" remains
indistinguishable from "not yet attached" outside a test harness. **This is a genuine missing
primitive** (read-only, no persistent side effect). Not implemented here, per the no-go constraints.

### B3 — A header held outside the transcript is not expressible (catalogue boundary, not a bug)

`discoverTranscriptSessions` reads exactly one transcript file — `transcriptFiles[0]` — and the
`record` extractor reads records from that file only. An Agent whose native id/cwd/timestamps live in
a sibling `meta.json`, or whose session spans multiple rolling JSONL files, projects **zero**
sessions. Demonstrated deterministically (`the catalogue boundary is observable` test: 0 sessions).
Per `s10.1b-decision.md` §10, the correct response is a **human decision** to add one declarative
primitive or a built-in reader — never a stronger DSL generated by the Agent, and never an adapter
written for the fixture.

### B4 — Provenance/evidence has nowhere to live in the descriptor

The skill's core contribution is *evidence* (`agent-manifest.report.json`: per-claim
`observed|weak|unverified|refused`). The descriptor format has no room for any of it, and the report
is a separate artifact Margin does not consume. That is arguably correct (evidence is for humans),
but it means self-integration **cannot be audited from the installed artifact alone**. Recorded as a
V0.2 design question, not a request.

**Non-blockers, for the record:** closed keys, capability/resource consistency, root containment,
built-in-type protection, and tombstone/uninstall all behaved exactly as the hardening tests promise.

---

## 8. Recommendation for V0.2

1. **Do not add any declarative primitive or adapter for Nova.** The fixture is a validation
   instrument, not a request. Ship it as data + test + docs.
2. **Reconcile B1 before publishing the skill.** Remove `generatedBy`/`runtime` from the skill's
   emitted shape, or implement them in the same change that flips them from [proposed] to shipped.
   A skill whose sample output fails the current validator is worse than no skill.
3. **Implement V4 `margin agent verify <manifest> [--path <home>]`** — the one new behaviour this
   slice proves is needed. It is read-only and composes four existing calls:
   `resolveAgentHome` → `probeDescriptor` → `composeAdapter` → `collectSessionSnapshots`, then asserts
   the projection invariants (non-empty `nativeSessionId`, resolvable workspace, parseable
   `createdAt`/`updatedAt`) and exits `verified | no_sessions | unavailable | rejected`. The harness
   in `test/agentSelfIntegration.test.js#verifyNovaIntegration` is a working reference for it.
4. **Make B3 a gate, not a guess.** If the first real Agent (S10.2) needs a header outside the
   transcript, treat it as evidence for **A** (one built-in reader) or one reviewed declarative
   primitive — decided by a human, documented, and never inferred from a fixture.
5. **Keep the §7 gate.** This slice validates the mechanism; it does **not** satisfy "one real Agent,
   unaided, five exit criteria". S10.2 still requires a real Agent, and its failure interpretation
   stands (B2 strengthens the "must be observed, not declared" case).
6. **Publish the boundary.** B4 and the report/descriptor split belong in the skill's
   `unverified[]`/`requests[]` guidance so a future Agent-author does not try to smuggle evidence or
   an unwired capability into the manifest.

---

## 9. Files

| File | Role |
|---|---|
| `plugins/nova/agent.json` | the skill-generated descriptor (fixture Agent) |
| `plugins/nova/README.md` | fixture design + catalogue boundaries |
| `test/agentSelfIntegration.test.js` | full workflow + nine negative cases + boundary probe |
| `docs/research/agent-self-integration-validation.md` | this report |

Run: `node --test test/agentSelfIntegration.test.js` (7 tests, all pass). The descriptor/install/CLI/privacy suites
(82 tests) also pass unchanged, confirming no core regression.
