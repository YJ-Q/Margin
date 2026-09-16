# Phase 2A Application Contract Acceptance Report

Status: accepted after the 2026-08-24 final-review fix wave based on `20ec6c3`.

## Scope and completion matrix

| Work item | Result | Evidence |
| --- | --- | --- |
| Contract types, validators, DTOs | Complete | Closed inputs, bounded/frozen camelCase outputs, safe stable errors, Runtime ID separation, unique NeedsOwner option IDs, reconstructable resolution DTO |
| Migration 004 and persistence | Complete | Additive Workstream/Artifact fields, `margin_needs_owner`, `margin_event_cursors`, transaction and historical cursor-backfill tests |
| Migration 005 compatibility | Complete | v1–v4 checksums unchanged; blank legacy Workstream titles backfilled without replacing the row; legacy create path writes a bounded title |
| Gateway commands and queries | Complete | Real Services/Repository integration, capability and host-authority checks, idempotency, optimistic concurrency, stable Artifact missing-Workstream error |
| Runtime Adapter contract | Complete | Frozen `{operation,key,runtimeReference}` descriptor on every callback; post-callback persistence failure and same-key retry tests for start/pause/stop |
| Event and Activity contract | Complete | Whitelisted Event Envelope, legacy Project and Decision mapping, anonymous fallback actor, deterministic Activity, stable restart pagination and privacy tests |
| CLI migration | Complete | Terminal Phase 2A Workstream/Run/Checkpoint resources use `execute/query`; failed Run commands retain their business key; persisted halts are process-idempotent |
| Restart acceptance | Complete | Real SQLite lifecycle E2E plus populated v1/v2/v3 Gateway and CLI restart upgrades preserve canonical Workstream identity/version |
| Phase 2B code | Not started | No HTTP/Web/Feishu/Scheduler/Worker implementation was added |

## Final architecture and boundary wording

```text
Surface Adapter (CLI now; Web/Feishu/Scheduler/Worker later)
  -> MarginApplicationContract.execute/query/events
  -> Workstream/Run/Artifact/Checkpoint/NeedsOwner Services
  -> PersistentWorkRepository
  -> one canonical Margin SQLite

Runtime Adapter <-> Run.runtimeReference
```

The Gateway is transport-neutral, has no database handle, cache, or aggregate map, and returns only validated frozen DTOs. It is the only Surface entry for Phase 2A Contract-governed resources. Runtime `v1Tools`, continuity, and memory confirmation remain separate governed Phase 0/1 boundaries; this acceptance does not claim they were migrated into the Gateway.

Aggregate tables remain the current-state source of truth. `margin_events` remains append-only factual/integration history, not current-state authority. Activity is derived in memory from already sanitized Event Envelopes and has no table or shadow state.

## Schema and legacy compatibility

Migration 004 remains byte/checksum compatible and supplies the Phase 2A schema shape:

- `margin_projects`: `priority`, `current_state`;
- `margin_artifacts`: `metadata`, `preview_metadata`;
- `margin_needs_owner`: persistent NeedsOwner identity, options, status, resolution, version, and source evidence;
- `margin_event_cursors`: `sequence` to unique `event_id`, historical row-order backfill, and `AFTER INSERT` trigger assignment.

Migration 005 is a data-only compatibility migration. It deterministically replaces blank/whitespace Workstream titles with a bounded legacy goal; only malformed empty-goal history uses a deterministic ID-based fallback. It does not create a replacement Workstream or alter its ID/version. The legacy `store.createProject()` path now writes a bounded non-empty title from explicit title or goal so upgraded callers cannot recreate the defect.

Populated databases recorded through v1, v2, and v3 were upgraded through v5, queried through the Gateway, started through the CLI, closed, reopened, and started again. Each retained the same Workstream ID and version. A separate populated-v3 test proves Migration 004 assigns historical cursor sequences by Event row order, the trigger allocates the next sequence, and restart preserves `[1,2,3,4]`.

## SQLite transaction and Runtime Adapter contract

Repository mutations still commit aggregate state, audit evidence, Event row, and trigger-assigned cursor in one SQLite transaction. Artifact create without `runId` now checks Workstream existence inside that transaction and returns non-retryable `workstream_not_found` before the foreign-key write.

Runtime callbacks are external to SQLite atomicity. Every `activate` and `halt` receives a frozen descriptor:

```js
{ operation: 'run.pause', key: '<stable business idempotencyKey>', runtimeReference: { kind: 'pi', id: '<runtime id>' } }
```

The Runtime Adapter contract requires repeated `(operation,key,runtimeReference)` calls to return the same result and produce only one effective Runtime side effect. Callback invocation itself may repeat. The terminal adapter implements this contract with in-process operation-result memoization and treats `haltSession` for an already halted persisted reference as a successful no-op. It also retains a failed Run command's business key for retry while generating a fresh Gateway request ID.

There is no distributed transaction between Runtime and SQLite. If activation succeeds and evidence persistence fails, SQLite rolls back to queued while the Runtime may remain active; a same-key retry must reuse the Adapter's activation result and converge the row. If halt succeeds and evidence persistence fails, SQLite rolls back to running while Runtime may be halted; a same-key retry may invoke the callback again but must not repeat the effective halt. The first failure is honestly returned as retryable `storage_failure`. The no-duplicate-effective-side-effect guarantee exists only when the Runtime Adapter honors this idempotency contract.

Explicit `checkpoint.create` emits `checkpoint.created`. Lifecycle checkpoints created by `run.pause` or `run.stop` remain part of the Run transition transaction and are represented by `run.paused` or `run.stopped`, not by a second checkpoint event.

## NeedsOwner and Decision semantics

NeedsOwner options are bounded and have unique IDs. Resolve parses the stored bounded options inside the same `BEGIN IMMEDIATE` transaction. A non-empty option list requires a listed `optionId`; missing or unknown IDs fail with `invalid_request` without changing state or evidence. Empty options require `optionId:null`.

Resolution is persisted and mapped as the frozen, reconstructable object `{ optionId, summary }`, so a supplied summary never discards the selected option. Stale concurrent resolve remains guarded by `expectedVersion`. NeedsOwner resolution does not create or mutate a Decision.

The governed v1 Decision writer still owns Decision mutation. Its historical payload is `{}`, so the public Event mapper now recognizes only the immutable safe identities `decision.created`, `decision.superseded`, and `decision.revoked`. Legacy `entity_type='project'` created/updated/completed evidence maps only to supported Workstream event types. Raw payload is never exposed, and actor remains `{type:null,subjectId:null}` when audit linkage cannot be proven.

## RED / GREEN evidence

- Legacy Workstream RED: v1/v2/v3 Gateway reads returned failure and legacy `createProject()` returned `title:''`; GREEN after Migration 005 and explicit legacy title write.
- Legacy Event RED: the first page returned zero mapped items for Project/Decision `{}` payload evidence; GREEN with six ordered whitelisted events across restart and anonymous actors.
- Runtime RED: post-halt pause/stop retry produced `2` effective halts instead of `1`; terminal repeated `haltSession` three times. Post-activation retry similarly produced `2` effective activations. GREEN after descriptor propagation and Adapter idempotency.
- Terminal retry-key RED: the first failed pause and retry had different business keys; GREEN with one stable key and distinct Gateway request IDs.
- NeedsOwner RED: duplicate create and missing/unknown option resolves were accepted, while resolution was an unparseable scalar; GREEN with transactional checks and `{optionId,summary}`.
- Artifact RED: missing Workstream was reported as retryable `storage_failure`; GREEN as non-retryable `workstream_not_found` with unchanged Artifact/Event/Audit counts.
- Historical cursor evidence was pre-existing GREEN; the missing populated-v3 backfill/trigger/restart regression was added without fabricating a failure.

## Verification evidence

Commands were run from the repository root on 2026-08-24:

- Focused direct Node suite covering migrations, schema, Phase 2A persistence/validation/commands/queries/events, Run control, terminal tests and E2E: exit 0; `83` tests passed, `0` failed.
- `npm test`: exit 0; `352` tests passed, `0` failed, `0` cancelled, `0` skipped, `0` todo.
- `npm run validate:stage1`: exit 0; JSON reported `ok:true`, protocol `1.0.0`, total `10`, `career_project:5`, `learning_research:5`, `manifestBound:true`.
- `npm run audit:pi`: exit 0; Pi baseline `v0.84.2`, package `0.84.2`, MIT license, required Node `22.19.0`, observed runtime `22.23.1`, empty failures, `ok:true`.
- `git diff --check`: exit 0 with no whitespace errors; Git emitted LF-to-CRLF working-copy notices only.

These results cover repository tests, the synthetic Stage 1 fixture set, and the installed Pi/runtime baseline. They do not constitute a Live model result.

## Known risks and validation gap

- YAPI Live Pi was not invoked. Credential-gated Live validation remains a known gap before a Runtime-dependent Web E2E.
- Runtime/SQLite convergence depends on the Runtime Adapter honoring the explicit idempotency contract. A non-conforming remote Adapter can duplicate side effects; no distributed atomicity is claimed.
- A caller that abandons a retry after a post-callback persistence failure can leave Runtime and SQLite temporarily divergent; a future remote Adapter needs reconciliation and observability.
- Phase 2A capability checks and opaque host authority are in-process boundaries, not HTTP authentication or multi-user RBAC.
- SQLite cursor behavior is accepted for the current single-node Core. Phase 2B should load-test paging and connection contention before selecting an update transport.

## Phase 2B recommendation

Proceed with a separate Phase 2B design for a thin HTTP adapter and minimum Workbench only after preserving the Gateway as the sole Surface entry for Phase 2A Contract-governed resources. Start with Workstream list/detail, Run controls, and Activity updates driven by Event cursor; keep browser state as a DTO cache, never an authority. Keep Runtime tools, continuity, and memory confirmation on their existing governed boundaries until separately designed. Defer Feishu, Scheduler, Worker, workspace editing, and multi-Agent UI.
