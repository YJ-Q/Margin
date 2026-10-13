# Agent Capability Matrix — Codex / Claude / Pi

Status: **Research only.** No code in this slice. No proposal in this document is implemented.
Scope: what the three Agents Margin currently integrates actually expose, on three axes —
Session, Resource, Runtime — and where the integration boundary had to be hand-written.
Written at: `package.json` `0.1.0` (v0.1.0 Beta), commit `1c822e5`.
Evidence base: `src/agents/**`, `src/resources/**`, `src/runtime/**`, `src/core/handoff/session-source.js`,
`test/agent*.test.js`, `plugins/doubao/**`. Every claim below is traceable to one of those files.

---

## 0. How to read this matrix

The three axes used here are the ones the question asks about, and they are **not** the three
things Margin actually owns. That distinction is the first finding of this research.

| Axis | Question the axis answers | Where the answer lives today |
|---|---|---|
| **Session** | Where does this Agent keep its history, and how do I read one session's identity out of it? | `src/agents/externalSessionDiscovery.js`, `src/core/handoff/session-source.js`, `src/agents/descriptor/readers.js` |
| **Resource** | Where does this Agent's quota/usage truth come from, and is it subscription or API? | `src/resources/*.js` |
| **Runtime** | Can I observe, or control, whether this Agent is running? | `src/agents/executionStatus.js`, `src/agents/codex/codexTurnStatus.js`, `src/runtime/**` |

The fourth axis that actually decides integration cost — **Handoff** — is not in the question but
appears in every row below, because it is the only capability with no declarative form at all
(`src/agents/descriptor/spec.js`, header comment; `docs/architecture/integration_decision.md`).

---

## 1. The shared machinery (identical for all three)

Before the per-Agent detail it matters that most of the pipeline is **not** Agent-specific. This is
what makes the capability question tractable: only the *reader* differs.

| Layer | Module | What it owns | Per-Agent? |
|---|---|---|---|
| Source registry | `src/agents/sourceRegistry.js` | `~/.margin/agent-sources.json`, detection, tombstones (`suppressed`), capability/support projection | no — derives from descriptors |
| Descriptor loading | `src/agents/descriptor/load.js` | built-ins + `~/.margin/agents/*.json`, duplicate-type refusal, `problems` reporting | no |
| Adapter composition | `src/agents/descriptor/compose.js` | the ten-method adapter contract, `BASE_CAPABILITIES`, `unavailableResourceEnvelope` | no |
| Session DTO shape | `compose.js#asSnapshot`, `externalSessionDiscovery.js#projected` | `id / nativeSessionId / sourceId / canonicalId / cwd / createdAt / updatedAt / model / provider / executionStatus / attentionStatus / workspaceKey / workspaceName / displayTitle / titleSource` | no — field-identical by construction |
| Workspace identity | `session-source.js#resolveWorkspaceIdentity` | `canonicalizeWorkspacePath` → `git -C cwd rev-parse --show-toplevel` → `git:<root>` or `cwd:<root>`; 10 s TTL cache | no |
| Title derivation | `src/agents/sessionTitle.js#titleDto` | precedence `nativeTitle` → `metadataTitle` → `firstUserMessage` → `fallback-id` | no |
| Change signal | `computeSourceRevision` / `computeExternalSessionRevision` / `computeTranscriptRevision` | stat-only signature hashed with source identity; carries no session data | partially |
| Capability vocabulary | `sourceRegistry.AGENT_CAPABILITIES`, `spec.DESCRIPTOR_CAPABILITIES` | `sessions, handoff, apiUsage, quota, executionStatus, attentionStatus, subscriptionQuota` | no |

Two consequences worth stating up front:

1. **Sessions are cheap to integrate; resources and handoff are not.** A session reader is
   "read files, project fields". A resource reader is "find a credential, prove which provider is
   actually routing, call an endpoint, and own last-known-good semantics". A handoff reader is a
   transcript distiller. Those three cost classes are visible in the per-Agent rows below.
2. **`attentionStatus` is a declared capability that no Agent implements.** It is `false` for every
   built-in (`descriptor/builtin.js`) and every session DTO hard-codes `attentionStatus: 'none'`.
   It is in the vocabulary, in the DTO, and in the UI contract, and it has never been produced by a
   reader. This is the concrete precedent for "do not enumerate a capability before a reader exists",
   and it is cited again in `s10.1b-decision.md`.

---

## 2. Codex

### 2.1 Session

| | |
|---|---|
| **Storage location** | Home resolution `resolveCodexHome` (`session-source.js`): explicit arg → `$CODEX_HOME` → `{USERPROFILE\|HOME\|HOMEDRIVE+HOMEPATH\|homedir}/.codex`. Sessions: `{home}/sessions/**/rollout-*.jsonl` (recursive; filename filter `/^rollout-.+\.jsonl$/i`). Sibling native stores: `{home}/session_index.jsonl` (thread-name index), `{home}/archived_sessions/**` (a **different native lifecycle**, deliberately excluded from the default resumable projection), `{home}/thread_history_1.sqlite` (terminal turn projection). |
| **Data format** | JSONL, one JSON object per line. Load-bearing records: `session_meta` (`payload.session_id`, `payload.cwd`, `payload.thread_source`, `payload.git.branch`, `payload.git.commit_hash`, `payload.model_provider`, `payload.base_instructions`); `event_msg` with `payload.type` ∈ `task_started` / `task_complete` / `turn_aborted` (lifecycle) and `token_count` (rate limits + token usage); `response_item` with `payload.type: "message"`, `payload.role: "user"` (first eligible requirement). The filename itself encodes creation time: `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`. |
| **Native identity source** | `session_meta.payload.session_id`; fallback is the UUID segment of the filename (`parseFilename`). `canonicalId = codex:{sourceId}:{nativeSessionId}`. `rolloutId` is kept as a *separate* field because Codex can write more than one rollout under one session id. |
| **Workspace mapping** | `session_meta.payload.cwd` → `canonicalizeWorkspacePath` (realpath, `\`→`/`, lowercased on win32) → `git rev-parse --show-toplevel`; `workspaceKey = git:<root>` or `cwd:<root>`, `workspaceName = basename(root)`. Identity is a deterministic function of the canonical cwd alone; 10 s TTL bounds re-spawning git. |
| **Metadata available** | `nativeTitle` (from `session_index.jsonl` `thread_name` — a real native index, not a derived guess), `metadataTitle` (**always `null`**: `readRolloutFacts` hard-codes `summary: null`), `firstUserMessage` (first *eligible* user requirement — wrapper-envelope filtering plus explicit `files pasted by the user` `.txt` attachment recovery, `normalizeUserRequirement`), `branch`, `gitSha`, `rolloutId`, `lifecycle`, `threadSource`, `createdAt`/`updatedAt` (min/max of record timestamps), plus reader-internal `hasPartialTail` / `malformed`. |
| **Admission filter** | `resumableSessions` admits a rollout only when `(lifecycle ?? 'active') === 'active'` **and** `threadSource === 'user'`. Codex's own `thread_source` field distinguishes an end-user thread from `guardian_review` / `subagent` / `memory_consolidation`. Collisions on `canonicalId` merge: earliest `createdAt`, newest `updatedAt`, union of lifecycle events. |
| **Handoff** | `shared-codex` — Codex is the origin of the shared Handoff Core. This is why its descriptor uses the host-injected Codex capture/generate defaults rather than adapter-local methods (`compose.js`, `handoff.kind: 'shared-codex'`). |

Observed tension, recorded rather than resolved: `resumableSessions` requires the literal value
`'user'`, while `session-source.js#findThreadSource` (used by the metadata-only probe
`readThreadSourceFromPath`) documents that *absence* of `thread_source` means "unknown, assume
normal". The two call sites therefore disagree about a rollout written before the field existed.
This is noted as a question for implementation, not judged here.

### 2.2 Resource

| | |
|---|---|
| **Quota source** | Native JSONL only: `event_msg` / `payload.type === 'token_count'` / `.rate_limits`. Default reader (`readLatestCodexQuotaSnapshot`) scans `{home}/sessions` **and** `{home}/archived_sessions` and takes the newest by event timestamp. The live reader (`codexLiveResource.js`) reads only the **active** `sessions` tree, incrementally by byte offset, and keeps an in-process revision-keyed cache plus last-known-good. |
| **Subscription / API distinction** | Split into two records that are never added or converted: `resourceType: 'quota'` with `accessMode: 'subscription'` (provider-reported 5h/7d windows) and `resourceType: 'tokenUsage'` (foreground user session cumulative tokens). The agent record carries no `subscriptionQuota` flag for Codex — quota is emitted as records, not as a flag. |
| **Available fields** | `agent: 'codex'`, `provider: 'openai'`, `accessMode: 'subscription'`, `resourceType: 'quota'`, `timestamp`, `provenance: 'codex_native_jsonl_event_msg.token_count.rate_limits'`, `sourceVersion: 'codex_jsonl_rate_limits_v1'`, `sourceStability: 'verified-native-snapshot'`, optional `plan` (`rate_limits.plan_type`), optional `credits`, then per window (`primary`, `secondary`): `windowDurationMinutes`, `percentUsed`, `remaining` (= `100 - percentUsed`, clamped, exposed as **remaining** not used), `resetsAt` (epoch s), `stale`. |
| **Staleness rule** | A snapshot older than the window's own `resetsAt` has no trusted value for the *current* window: `remaining: null`, `stale: true`. Never a guessed fresh 100 % (`normalizeAgentResource.js`). `agentResourceService.resourceStatusOf` is the single owner of `ok / stale / unavailable`; consumers must not re-derive LKG. |
| **Failure semantics** | A failed read returns LKG marked `stale` and never advances `freshAt`. A fresh home with nothing trustworthy is `unavailable` — not `stale`, and not "0 used". |
| **Friction** | `readLatestCodexQuotaSnapshot` cannot be declared: it is a JSONL scan with archive-inclusive semantics. The live reader additionally derives `model` from `base_instructions` text via `parseModel` (a regex over a prompt string). `provider` comes from the native `payload.model_provider`, but `model` does **not** come from a native field. This is the one text-derived field in the Codex resource path and it is used for token-usage display only, never for session truth. |

### 2.3 Runtime

| | |
|---|---|
| **Execution status signals** | Two independent native signals, composed in `composeCodexTerminalStatuses`: (a) **SQLite terminal projection** — `{home}/thread_history_1.sqlite`, table `thread_turns`, latest row with `status IN ('completed','failed','interrupted')`; `status === 'failed'` **and** a non-empty structured `error_json` ⇒ `error`, otherwise ⇒ `idle`. (b) **In-process lifecycle tracker** — `task_started` ⇒ `working`, `task_complete` / `turn_aborted` ⇒ `idle`, read from records appended *during this process lifetime* via a byte cursor. Composition rule: a live event wins when `liveAt >= terminalAt`; otherwise the native error wins. `terminalLkg` retains the last terminal verdict across a failed read. |
| **Limitations** | No runtime control — Codex is observe-only; Margin never launches or drives it. The lifecycle tracker is **process-local by design**: a restart creates a cold baseline (every existing rollout is treated as pre-existing), so an old unmatched `task_started` can never revive a green dot. The observed Codex schema has *no* explicit failure/error lifecycle event, so `error` can only ever come from the SQLite projection — the source comment states this explicitly rather than mapping generic messages to red. A missing `thread_history_1.sqlite` is `available: false`, not an error. |
| **Handoff** | Codex-shaped records are the input format of the shared Handoff Core (`captureSession` / distiller in `src/core/handoff/**`). |

---

## 3. Claude Code

### 3.1 Session

| | |
|---|---|
| **Storage location** | Home from the descriptor: `$CLAUDE_HOME` → `{profile}/.claude`. Sessions: `{home}/projects/<project>/**.jsonl`. **A second native store outside Claude's own directory is load-bearing:** VS Code's `state.vscdb` at `{APPDATA\|{profile}/AppData/Roaming}/Code/User/globalStorage/state.vscdb`, `ItemTable` key `Anthropic.claude-code` → JSON `hiddenSessionIds`. That is Claude Code's archive truth, and it lives in the Code profile, not beside the JSONL files. |
| **Data format** | JSONL. Load-bearing fields: `type` (`user` / `assistant` / internal variants), `message.role`, `message.model`, `message.stop_reason`, `message.content` (string or blocks: `tool_use` / `text` / `tool_result`), `sessionId` or `session_id`, `cwd`, `timestamp` / `createdAt` / `time`, `aiTitle`, `title` / `name` / `summary`, `isApiErrorMessage`, `isSidechain`, `sidechain`, `agentId` / `agent_id`, `isMeta`, `toolUseResult`, `entrypoint`, `sessionKind`. |
| **Native identity source** | First record containing `sessionId` / `session_id` (found via a bounded breadth-first `nested()` walk over the record, so nesting depth is not assumed); fallback is the filename with `.jsonl` stripped. |
| **Workspace mapping** | First `cwd` found in any record; same `resolveWorkspaceIdentity` git-root canonicalisation as Codex. |
| **Metadata available** | `model` = **last** assistant `message.model`; `provider` = `null` (the session DTO does not claim a provider for Claude); `nativeTitle` = `aiTitle`; `metadataTitle` = first of `title` / `name` / `summary`; `firstUserMessage` = first user text that is not sidechain, not meta, and not a `tool_result`; `createdAt` = first timestamp, `updatedAt` = max timestamp. |
| **Admission filter** | Four independent exclusion rules, all source-backed: (1) any record carrying `agentId` / `agent_id`, `isSidechain` / `sidechain === true`, or record type `internal` / `sidechain`; (2) any record implying a programmatic entrypoint (`sdk-cli`, `sdk-ts`, `sdk-py`) or `sessionKind` ∈ `daemon` / `daemon-worker`; (3) any session id present in the VS Code `hiddenSessionIds` set; (4) sessions whose projected DTO would lack `id`, `cwd`, `createdAt`, or `updatedAt` are dropped rather than published with invented values. The archive read is **authoritative when it succeeds** — a read failure throws (`claude_archive_registry_read_failed`) instead of quietly un-archiving sessions. |
| **Handoff** | `handoff.kind: 'builtin'` with adapter-local `captureSession` + `generateClaudeHandoff`. Note the deliberate split preserved in `builtin.js`: source-level `capabilities.handoff: false` while `sessionCapabilities.handoff: true`. That is pre-existing product behaviour, not a bug, and the spec preserves both surfaces rather than collapsing them. |

### 3.2 Resource

| | |
|---|---|
| **Quota source** | **Not** Claude's own Anthropic usage. The only supported route is OpenCode Go, and it is admissible only after four independent proofs (`claudeOpenCodeGoBinding.js`): CC Switch `settings.json.currentProviderClaude` → `cc-switch.db` `providers` row (`app_type='claude'`, `is_current`); CC Switch `enableLocalProxy` and the `proxy_config` row for `claude`; Claude's own `settings.json` `env.ANTHROPIC_BASE_URL` pointing at the **loopback proxy** on the exact declared address/port; and the provider row's `meta.usage_script.codingPlanProvider === 'opencode_go'` with an `ANTHROPIC_BASE_URL` of `https://opencode.ai/zen/go`. Only then is `ANTHROPIC_AUTH_TOKEN` (\|\| `ANTHROPIC_API_KEY`) read and used against `GET https://opencode.ai/zen/go/v1/usage`. |
| **Subscription / API distinction** | Subscription only. `capabilities.apiUsage` is `false`; there is no API-usage reader for Claude at all. The quota reader is explicitly forbidden from falling back to Pi's auth store (`adapters.js` comment). |
| **Available fields** | Records carry `agent: 'claude-code'`, `provider: 'opencode-go'`, `accessMode: 'subscription'`, `resourceType: 'quota'`, `window` ∈ `5h` / `7d` / `M`, `windowDurationMinutes`, `plan: 'opencode-go'`, `percentUsed`, `remaining`, `resetsAt`, `status`, `timestamp`, `stale`, `provenance: 'opencode_go_zen_v1_usage'`, `sourceVersion`, `sourceStability: 'live-subscription-endpoint'`. Agent-level `subscriptionQuota: true` is set **only** when the reader succeeded and returned at least one window — never because a provider is merely named. |
| **Credential handling** | The credential is attached with `Object.defineProperty(..., { enumerable: false })` so accidental JSON serialisation cannot leak it. It is never written to the source registry, a DTO, telemetry, HANDOFF, or a log. |
| **Friction** | This is the highest-friction resource integration in the repo and it is **entirely outside the Agent's own storage**: the truth depends on a third-party switch app, a SQLite database, a proxy config, and an endpoint allow-list. Nothing about it is expressible as a path + extractor. |

### 3.3 Runtime

| | |
|---|---|
| **Execution status signals** | `readClaudeExecutionStatus` (`executionStatus.js`) classifies the **last assistant turn only**, from records discovery already parsed: `isApiErrorMessage === true` ⇒ `error`; `message.stop_reason === 'tool_use'` (or `stop_reason` absent *while* a `tool_use` block is present) ⇒ `working`; a text block present ⇒ `idle`; nothing interpretable ⇒ `unknown`. Sidechain/subagent turns are skipped locally as well as by discovery. Coverage is stated in-source over 3 895 observed assistant records on the development machine. |
| **Limitations** | Observation only. A Claude **runtime** exists in the repo (`src/runtime/claude/claudeAgentLoop.js`) but is reachable only from the Feishu surface, which is a different owner context (Surface D). The Board's adapter contract exposes no runtime method, so on the Board Claude is read-only. A tool result reporting a failed command is deliberately **not** an Agent error — the turn continues — so it never maps to `error`. |

---

## 4. Pi

Pi is the only one of the three that plays two unrelated roles, and conflating them is a real
modelling hazard for any manifest design:

* **Pi as an observed Agent** — sessions on disk read by the adapter (this section).
* **Pi as Margin's own runtime** — the embedded agent that Margin launches and governs
  (`src/runtime/pi/marginPiAdapter.js`, `piTerminalPilotRuntime.js`, `piWebRuntimeCoordinator.js`),
  pinned to `@earendil-works/pi-coding-agent@0.84.2`, with built-in file/command/edit/write tools
  disabled and only four governed Margin tools registered (`memory_search`, `memory_propose`,
  `state_update`, `action_update`).

A manifest that describes "session / resource / runtime capability" must be able to say *which* of
these it means. See `agent-manifest-schema.md` §5.

### 4.1 Pi as an observed Agent

| | |
|---|---|
| **Storage location** | Home: `$PI_HOME` → `{profile}/.pi`. Sessions: `{home}/agent/sessions/<sessionDir>/<file>.jsonl` (**two-level**: a directory per session, discovered by iterating `readdirSync({home}/agent/sessions)` then the `.jsonl` files inside each). Two config/credential stores sit beside them and are part of resource truth: `{home}/agent/models.json` (provider config) and `{home}/agent/auth.json` (credentials). |
| **Data format** | JSONL. Load-bearing records: `type: 'session'` carrying `id` and `cwd`; `type: 'message'` with `message.role: 'assistant'`, `message.stopReason`, `message.content` blocks (`toolCall` / `text`), `message.usage.totalTokens`, `message.provider`; `type: 'model_change'` carrying `provider` and `model` / `modelId`; plus `title` / `name` / `summary`, `timestamp`. |
| **Native identity source** | The first `type === 'session'` record's `id`. A file with no such record is skipped. |
| **Workspace mapping** | `session.cwd`; fallback is any nested `cwd` in the file. Same git-root canonicalisation. |
| **Metadata available** | `provider` and `model` from the **last** `model_change` record (this is a genuine native change log, not a guess); `metadataTitle` = first of `title` / `name` / `summary`; `firstUserMessage`; `createdAt` = first timestamp, `updatedAt` = max timestamp. No `nativeTitle` — `titleDto` falls through to `metadataTitle`, then `firstUserMessage`, then `fallback-id`. |
| **Admission filter** | Requires a `session` record and a resolvable `cwd`; the shared `projected()` also requires `createdAt` and `updatedAt`. No subagent/sidechain concept was observed, so none is invented. |
| **Handoff** | `handoff.kind: 'builtin'` with adapter-local `captureSession` + `generatePiHandoff`. |

### 4.2 Pi Resource

Two independent readers under one source, **never added or converted** (`adapters.js#piResourceStatus`):

| Reader | Source | Classification |
|---|---|---|
| **API Today** (`piApiUsage.js`) | Local aggregation over `{home}/agent/sessions/**/*.jsonl`: assistant messages with `message.usage.totalTokens`, scoped to the **local calendar day** (`start.setHours(0,0,0,0)`), bounded to `timestamp ∈ [startOfDay, now]`. | API vs subscription comes from `{home}/agent/models.json`. `configuredApiProviders` starts from a literal `'deepseek'` and adds `YAPI` **only** when the native config declares both an `api` protocol and a `baseUrl`. Records whose provider is `opencode-go` are counted as `excludedSubscriptionResponses`; records whose provider is unknown are counted as `excludedUnknownResponses` and **never added to the total**. |
| **OpenCode Go quota** (`opencodeGoQuota.js`) | `{home}/agent/auth.json` → `['opencode-go'].key` → `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer …`. | Pure subscription. Windows `rolling` / `weekly` / `monthly` → labels `5h` / `7d` / `M`. `percent` is *used*; `remaining` is exposed. |

| | |
|---|---|
| **Available fields (API Today)** | `resourceType: 'tokenUsage'`, `accessMode: 'api'`, `scope: 'today'`, `totalTokens`, `trustedResponseCount`, `coverage: { partial, excludedUnknownResponses, excludedSubscriptionResponses, readFailed }`, `provenance: { source: 'pi-jsonl', home, files, trustedApiResponses, … }`. |
| **Available fields (Go quota)** | The same window record shape as Claude's, with `agent: 'pi'`, `provider: 'opencode-go'`. |
| **Failure semantics** | Identical discipline to Codex: a read failure never becomes truth. The `piApiUsage` cache retains the last trusted snapshot marked stale and marks the identity dirty so the *same* `(revision, day, config)` re-attempts; a successfully read empty day is a legitimate `0`. The cache key is `revision + local day + provider-classification signature`, so a config edit that changes the API/subscription classification invalidates without touching the session revision. |
| **Friction** | The API/subscription decision depends on reading and interpreting a **provider config file**, and one provider name (`deepseek`) is a literal in source. This is the narrowest possible version of that rule and unknown providers are excluded rather than assumed, but it is an interpretation, not a native declaration. |

### 4.3 Pi Runtime (as an observed Agent)

| | |
|---|---|
| **Execution status signals** | `readPiExecutionStatus`: last assistant `message.stopReason` — `'error'` ⇒ `error`; `'toolUse'` (or absent while a `toolCall` block is present) ⇒ `working`; `'stop'` / `'aborted'` / a text block ⇒ `idle`; otherwise `unknown`. `'aborted'` is a user interrupt and is deliberately `idle`, matching Codex's treatment of `interrupted`. Coverage stated in-source over 34 sessions / 4 551 assistant turns. |
| **Limitations** | Tool-result `isError` records are failed **commands**, not failed turns, and are deliberately not mapped to `error`. Observation only — the *governed* Pi runtime is a separate subsystem with its own tool allow-list and audit trail. |

---

## 5. Cross-Agent comparison

### 5.1 Session

| | Codex | Claude | Pi | 豆包 (plugin only) |
|---|---|---|---|---|
| Home env var | `CODEX_HOME` | `CLAUDE_HOME` | `PI_HOME` | `DOUBAO_AGENT_HOME` |
| Layout | recursive `rollout-*.jsonl` | `<project>/**.jsonl` | `<sessionDir>/<file>.jsonl` | `<sessionDir>/agents/*/system/trajectory.jsonl` |
| Reader | builtin | builtin | builtin | **declarative** |
| Native id | `session_meta.payload.session_id` | `sessionId`/`session_id` | `session.id` | `directoryName` |
| Workspace | `session_meta.payload.cwd` | `cwd` | `session.cwd` | **`scanAbsolutePaths` + `.git` marker** |
| Title source | native index (`session_index.jsonl`) | `aiTitle` / `title` | `title`/`name`/`summary` | first user record |
| Timestamps | record timestamps | record timestamps | record timestamps | **file mtime min/max** |
| Extra native store | `thread_history_1.sqlite`, `archived_sessions/` | VS Code `state.vscdb` (`hiddenSessionIds`) | `models.json`, `auth.json` | — |
| Declarable? | no (SQLite + shared handoff core) | no (multi-file + external archive store) | no (two-level layout + config-driven classification) | **yes** |

### 5.2 Resource

| | Codex | Claude | Pi |
|---|---|---|---|
| Subscription quota | provider JSONL `token_count.rate_limits` | OpenCode Go endpoint, gated on 4 external proofs | OpenCode Go endpoint from Pi's own `auth.json` |
| API usage | separate `tokenUsage` record | **none** (`apiUsage: false`) | local JSONL aggregation, calendar-day scoped |
| Credential needed | no | yes (via CC Switch) | yes (own auth store) |
| Network | no | yes (`opencode.ai`) | yes (`opencode.ai`) |
| Declarable? | no | no | no |
| Distinct `accessMode` values | `subscription` + separate token record | `subscription` | `api` **and** `subscription`, in one agent record |

### 5.3 Runtime / execution status

| | Codex | Claude | Pi |
|---|---|---|---|
| Signal | SQLite `thread_turns` (terminal) **+** in-process lifecycle cursor | last assistant `stop_reason` / `isApiErrorMessage` | last assistant `stopReason` |
| Can report `error` | only from SQLite | yes, native API-error marker | yes, native `stopReason` |
| Margin drives it | no | no (only via the separate Feishu surface) | **yes** (Surface B interaction + terminal pilot) |
| Declarable (`executionStatus.kind: 'transcript'`)? | no | no | no |

### 5.4 Capability flags as declared today (`descriptor/builtin.js`)

| Flag | Codex | Claude | Pi | Produced by a reader? |
|---|---|---|---|---|
| `sessions` | ✅ | ✅ | ✅ | yes |
| `handoff` (source) | ✅ | ❌ | ✅ | yes (built-in only) |
| `handoff` (session) | ✅ | ✅ | ✅ | yes (built-in only) |
| `apiUsage` | ✅ | ❌ | ❌ | yes (Codex token record) |
| `quota` | ✅ | ❌ | ❌ | yes (Codex rate limits) |
| `executionStatus` | ✅ | ✅ | ✅ | yes |
| `subscriptionQuota` | — | ❌ | ✅ | yes (OpenCode Go) |
| `attentionStatus` | ❌ | ❌ | ❌ | **never — no reader exists** |

Note `apiUsage: false` for Pi even though `piApiUsage.js` exists and produces a `tokenUsage`
record. The source registry projects `capabilities` straight from the descriptor, so the *flag* and
the *resource record* are two different surfaces that are allowed to disagree. That is a real
inconsistency between "what the registry advertises" and "what the bar shows", and it is recorded
here because any self-declaration protocol will make it worse (an Agent will declare the flag it
thinks it has, not the one a reader can prove).

---

## 6. Gaps observed while building this matrix

These are observations about the **existing** implementation, found by reading it against its own
stated principles (`spec.js` header: *"a descriptor that claims a capability its declared wiring
cannot deliver is the exact failure this spec exists to prevent"*). None were changed in this slice.

| # | Observation | Evidence | Why it matters for self-integration |
|---|---|---|---|
| G1 | `capabilities.quota`, `capabilities.apiUsage`, and `capabilities.subscriptionQuota` are **not** cross-checked against `resources.kind`. `spec.js` cross-checks `handoff` and `executionStatus` only. `compose.js` then wires `unavailableResourceEnvelope` for `resources.kind: 'none'`. | `spec.js#validateDescriptor` cross-field block; `compose.js#unavailableResourceEnvelope` | A plugin can declare `quota: true` with no wiring and validate cleanly, then render as permanently `unavailable` on the bar. That is precisely the "silent half-wiring" the spec says it exists to reject — the discipline was applied to two of the four capability families. |
| G2 | **Unknown top-level keys are not rejected.** Validation checks a known set and ignores the rest. Nested extractor objects *are* strict (`directoryName`/`filename` reject extra keys). | `spec.js#validateDescriptor` vs `spec.js#checkExtractor` | A single typo (`"resource"` for `"resources"`, `"root"` for `"roots"`) is silently ignored and the descriptor defaults to `none`/empty. For a human author this is a footgun; for an **agent-generated** manifest it is the most likely failure mode. |
| G3 | `roots` templates are expanded literally (`{home}`, `{profile}`, `%ENV:X%`) and then `readdirSync`'d directly, with **no containment check** that the resolved root is inside the declared home. | `readers.js#discoverTranscriptSessions`, `#expandTemplate` | Bounds exist (4 000 files/session, depth 12, 2 000 sessions) but a root of `{profile}` or `/` is a legal declaration that makes Margin enumerate unrelated directories. |
| G4 | `%ENV:X%` expands **any** process environment variable, and the result is used as a path. | `readers.js#expandTemplate` | Path-only, and the path must exist, so the risk is low. But a manifest can reference `%ENV:OPENAI_API_KEY%`; the expansion must never be reported back in an error message without care. |
| G5 | `attentionStatus` is in the capability vocabulary, the session DTO, and every built-in descriptor, and has no reader. | `sourceRegistry.AGENT_CAPABILITIES`, `compose.js#BASE_CAPABILITIES` | Precedent for capability-before-implementation. Cited in the decision doc. |
| G6 | Capability flag and resource record can disagree (Pi: `apiUsage: false`, `tokenUsage` record produced). | `builtin.js` vs `adapters.js#piAgent` | A protocol where the **Agent** declares its own capabilities will produce declarations that drift from readers unless the declaration is verified by observation, not accepted. |
| G7 | Codex `model` in the live resource path is regex-extracted from `base_instructions` text. | `codexLiveResource.js#parseModel` | The only text-derived field in a resource path, and a reminder that "provider-reported" and "verified native field" are not the same claim. |

---

## 7. What this matrix implies (handed to the other research documents)

1. **Session discovery is the declarable axis.** Two of the three built-ins would be plugins if their
   layout were simple; 豆包 proves a real Agent can be integrated with data alone.
2. **Resource and Runtime are not declarable today, and not because nobody tried.** Each of the three
   built-ins has a hand-written resource reader for a *stated reason* (SQLite projection, external
   provider-proof chain, config-driven classification). No amount of manifest expressiveness removes
   the credential, the network, or the interpretation.
3. **Handoff is not declarable at all**, by design, and the spec says so rather than inventing a form.
4. **The declarative surface is the part that grows.** `executionStatus`, `sessionCapabilities`,
   `probe`, `homeCandidates`, and `scanAbsolutePaths` were each added for one real Agent's real gap.
   Any protocol that lets an Agent author its own descriptor will increase the rate at which that
   surface grows, and every added knob is permanent public surface.
5. **A self-declared manifest is a claim, not evidence.** G1/G2/G6 are three different ways an
   unverified claim silently degrades to "Agent appears integrated, shows nothing".
