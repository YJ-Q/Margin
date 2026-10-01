# Changelog

All notable changes to Margin will be documented in this file.

## [Unreleased]

### Added

- transport-neutral Application Contract `1.0` with closed commands/queries, frozen DTOs, stable errors, capability checks, and host-bound Run control
- additive Migration 004 for Workstream/Artifact contract fields, persistent NeedsOwner, and monotonic Event cursor allocation
- checksum-safe Migration 005 for populated v1/v2/v3 Workstream title backfill, plus historical Event cursor upgrade coverage
- safe Event Envelope and deterministic Activity projection over the canonical Event Log without an Activity table
- real SQLite restart E2E coverage for the complete Phase 2A Workstream/Run/Artifact/Checkpoint/NeedsOwner lifecycle
- pinned Pi SDK `@earendil-works/pi-coding-agent@0.84.2` and Node 22.23.1 development runtime contract
- SHA256-verified Node runtime bootstrap and reproducible Pi installation audit
- isolated Pi SDK spike for Session create/restore/fork, compaction, and one audit-only custom tool
- isolated inline registration for environment-authenticated OpenAI Responses-compatible providers, including the YAPI Stage 0 endpoint
- Pi version/license, integration decision, current-state audit, and contribution-boundary documents
- Stage 1 protocol `1.0.0`, ten synthetic continuity fixtures, SHA-256 manifest binding, and a repository validation CLI
- default-off Margin Core with additive versioned project, task, decision, memory, event, action, audit, and migration storage
- governed `memory_search`, `memory_propose`, `state_update`, and `action_update` handlers with explicit permissions and confirmation gates
- isolated Stage 3 continuity planner facade, four-tool Pi adapter, deterministic cross-session harness, and optional credential-gated live smoke command
- terminal-first workspace cleanup decision, implementation plan, and auditable cleanup report
- local interactive job-application continuity pilot with `/state`, `/memory`, `/new`, and `/exit`
- runtime-neutral pilot controller and restricted Pi Session adapter
- runtime-neutral Workstream and Run state machines, versioned Run/Artifact/Checkpoint schema, and transaction-backed Application Services
- host-owned persistent Run start, status, pause, resume, stop, and checkpoint controls with restart recovery
- read-only legacy Echo inventory and explicit approval-gated export tooling
- transcript-derived `executionStatus` for Claude (`stop_reason` / `isApiErrorMessage`) and Pi (`stopReason`) built-in sessions, plus a declarative idle status for 豆包; the Web Board now renders a confirmed-idle dot distinct from the grey no-evidence state (Task 111)
- the Phase 0/1 PoC **Review conclusion** (`docs/validation/margin_poc_review_conclusion.md`): answers "how much valid development state is recovered per 1K tokens" from the frozen evidence — ~1.9K median handoff tokens, 50/50 correct fields on the 10 parseable single-model B-arm runs (~1.87 correct fields/1K tokens; 1.56 as-run), byte median compression 99.4% — and records a conditional-Go verdict with four gated next steps

### Changed

- the terminal pilot now routes persistent Workstream, Run, and Checkpoint operations through the shared Application Contract
- Runtime `activate/halt` callbacks now carry stable operation descriptors; the terminal adapter deduplicates effective retries and treats already-halted persisted references as successful no-ops
- legacy Project and governed Decision events now map through an explicit anonymous-safe whitelist; NeedsOwner resolutions retain both selected option and summary
- the compatibility Express runtime is API-only and no longer serves static frontend assets
- the terminal client now consumes the unified Application Core and is the default entry point; the frozen Express/Echo API is explicitly deprecated
- the test command uses the pinned Node 22.23.1 runtime so Pi tests are reproducible on Windows

### Removed

- obsolete Electron shell, static Margin frontend, desktop launchers, and Electron dependency
- UI-centred case-study site, screenshots, generated PDFs, frontend mocks, build scripts, and artifact-only tests

### Security

- the Stage 0 spike disables Pi built-in file, command, edit, and write tools
- user/project Pi extensions and resource discovery are disabled; the audit tool is registered through one explicit inline extension factory
- verification rejects stale evidence, configuration drift, incorrect runtime binaries, and tool evidence without a matching per-run nonce
- spike evidence is written only to ignored local data and excludes credentials and full conversation text

### Not Yet Complete

- the production chat path has not been migrated to Pi
- production use still requires an explicit credential-management and provider-configuration design; the isolated YAPI-backed Stage 0 spike has passed
- production chat integration, legacy-data migration, comparative evaluation, and real-user research remain future stages
- Stage 3 does not activate production chat, migrate legacy data, run the 50-task evaluation, compare A/B/C baselines, measure recall, or conduct user research

### Verified

- Task 111 multi-Agent execution status: full suite `622/622` automated tests pass on 2026-10-02, including Claude/Pi built-in transcript-status discovery, 豆包 declarative idle, and the confirmed-idle Board dot
- Phase 2A final-fix acceptance: `352/352` automated tests, Stage 1 fixture validation `10/10`, and Pi baseline audit passed on 2026-08-24; YAPI Live Pi was not rerun and remains a declared gap
- real Pi SDK execution with `yapi/gpt-5.6-terra`: tool call, new Session, restore, fork parent relationship, and manual compaction
- Stage 0 verification gate: `212/212` automated tests passed on 2026-08-20
- Stage 1 fixture structure and manifest integrity are reproducibly validated; no model-performance or user-outcome result is implied

## [0.1.0-backend-mvp] - 2026-07-06

This release marks the first stabilized backend-oriented MVP for Margin.

### Added

- modular Express backend routes for chat, state, actions, learning, memory, summary, and TTS
- SQLite-backed memory store with memory notes, insight notes, salience, reinforcement, pinning, and priority buckets
- mixed memory retrieval that combines direct topic match, emotional resonance, learning continuity, core anchors, and recent thread signals
- page-ready backend view models for learning, reflection, and memory modules
- explainability blocks for `/chat` and `/state`
- local backup and export tooling:
  - `npm run backup`
  - `npm run export:data`
  - `npm run import:data`
- JSON request logging with request IDs
- runtime environment validation for provider and logging configuration
- backend-oriented release documentation:
  - `docs/API_CONTRACT.md`
  - `docs/BACKEND_STATUS.md`
  - `docs/BACKUP_AND_EXPORT.md`
  - `docs/RELEASE_CHECKLIST.md`

### Improved

- `/state` now exposes `current_action`, `current_learning`, `current_reflection`, and `current_memory`
- `/memory` now returns a page-ready `current_memory` aggregate
- `/summary/recent` now returns a page-ready `current_reflection` aggregate
- learning flow continuity is better reflected in state and action decisions
- memory retrieval is more aligned with Margin's long-term companion behavior instead of simple recency lookup

### Verified

- backend test suite status: `19/19` passing
- export flow verified locally
- import dry-run verified locally
- JSON snapshot restore tested against a fresh database

### Not In Scope Yet

- rebuilt public frontend experience
- production deployment playbooks
- long-term memory clustering beyond the current MVP retrieval strategy
- release-tag automation or CI release pipeline
