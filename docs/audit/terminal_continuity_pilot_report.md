# Terminal continuity pilot report

Date: 2026-08-23

Status: automated implementation verification complete; hands-on provider run recorded separately when executed.

## Implemented boundary

The terminal pilot supports one local `career_project` for resume delivery and job-application tracking. Natural-language messages use an adapter-neutral controller. The first runtime adapter uses Pi and registers exactly `memory_search`, `memory_propose`, `state_update`, and `action_update`.

The slash commands are `/state`, `/memory`, `/confirm-memory <memoryId> <version>`, `/new`, and `/exit`. `/new` closes the current Pi Session, creates a distinct Session, delivers a fresh bounded Margin context including open actions, and asks for the current status and next step. Memory confirmation is a host-owned terminal operation; the model cannot forge it.

## Safety boundary

Pi built-in file, command, edit, and write tools are disabled. Project extensions, skills, prompts, themes, and context files remain disabled. The pilot does not access recruitment sites, email, external accounts, or arbitrary local files and cannot submit applications or send messages.

Pilot state is isolated under `data/terminal-pilot/`. Reports contain only project/Session identifiers, context digests, four fixed tool names, result codes, and safety booleans. Credentials, full prompts, conversation text, assistant text, and model reasoning are excluded.

## Automated evidence

- terminal parser and bounded provenance formatters;
- controller project creation/resume, Session replacement, model-free inspection commands, sanitized errors, and idempotent closure;
- restricted Pi resources, exact tool allowlist, host-owned invocation context, and unexpected-tool rejection;
- CLI local-only disclosure, exit behavior, and sanitized report schema;
- full repository regression, Stage 1 fixture validation, Pi baseline audit, and diff checks.

## Credential-gated hands-on run

A YAPI-backed `gpt-5.6-terra` run completed on 2026-08-23 using the API key from the Windows user environment without writing the credential to the repository or report.

- project: `<PROJECT_ID>`;
- Session A: `<SESSION_A_ID>`;
- Session B after `/new`: `<SESSION_B_ID>`;
- context digest: `<CONTEXT_DIGEST>`;
- registered tools: exactly the four Margin tools;
- recorded result code: `allowed`;
- safety flags: local-only, built-in tools disabled, external writes disabled.

The run used read-only user instructions. Session B described the same active job-application task and next step after the Session boundary. This is a single technical smoke result, not a continuity success-rate or memory-quality measurement.

A second focused run exercised the missing action-continuity path after review. A fresh Session used natural language to invoke `action_update`, creating a pending action with audit evidence. After `/new`, the next Session received a context digest that included the open action, described it as pending, and `/state` displayed the same action and version. The sanitized result codes were `allowed` and `no_tool_call`; no-tool turns are no longer mislabeled as successful tool calls.

## Real-use failure and retrieval closure

A real Chinese progress update exposed four implementation failures: a mismatched `memoryPropose` permission name, Pi-populated empty optional fields entering the closed Core patch contract, missing model request IDs reaching required audit storage, and concurrent tool writes sharing one SQLite connection. The host also allowed optimistic assistant prose to appear above failed tool results. These failures were fixed with exact host permissions, empty-option pruning, host request-ID fallback, serialized adapter execution, operation-specific tool guidance, and a mandatory partial-write warning. The same task update then completed with `state_update=allowed`; `/state` showed task version 2 and the new current step.

A memory record was confirmed by the user at version 2. Before the retrieval fix it was stored but `/memory` returned no result because continuous Chinese text was treated as a whole token. Deterministic Chinese 2–3 character n-grams now provide the lexical half of lightweight hybrid retrieval. In a fresh Session, `/memory` recalled the same record and version with its source Session and confirmed provenance. A preceding ordinary acknowledgement produced no tool result and did not enter durable state.

The semantic half is optional and default-off. Migration 2 adds versioned SQLite embedding storage; a deterministic fake embedder verifies semantic-only recall, hybrid evidence, model-version isolation, and lexical fallback when embedding fails. No paid embedding API was called, and the real pilot currently runs in lexical fallback mode.

A pure four-way router now labels each natural-language turn as `ignore`, `state`, `action`, and/or `memory_proposal` before Pi is called. The label is hidden guidance only: it neither writes storage nor expands the four-tool permission boundary.

## Claim boundary

Passing tests show implementation behavior only. A hands-on run shows technical operability only. Neither establishes task success rate, recall quality, reliability, market need, adoption, or user value.

## Later technical evaluation

Pi Agent, DeepSeek Harness, and the Codex open-source project will be evaluated later using frozen repositories/versions and the same scenario. Dimensions include integration effort, Session/compaction support, tool governance, permission isolation, observability, provider compatibility, maintenance risk, Margin Core portability, and observed continuity behavior.
