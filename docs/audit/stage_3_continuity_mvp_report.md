# Stage 3 Margin continuity MVP audit report

Status: implementation evidence recorded. This report documents an isolated engineering MVP and makes no product-performance, recall-quality, or user-outcome claim.

## Implemented boundary

Stage 3 keeps Margin Core default-off. When explicitly enabled, the Core continues to expose its four governed tool handlers and separately exposes `planContext(input, options)`. The facade reads a scoped continuity snapshot and invokes the deterministic planner; it imports no Pi package.

The internal Pi adapter registers only `memory_search`, `memory_propose`, `state_update`, and `action_update`. It receives permissions, provenance, and confirmation records through the host callback. Margin Core remains the authority for permission denial, confirmation gating, durable state, and audit evidence.

The planner is bounded, deterministic, read-only, and source-addressable. It emits project, active-task, confirmed-decision, confirmed-memory, and recent-dialogue entries with entity identifiers, versions where available, source session identifiers, selection reasons, exclusions, and a digest. It does not import Pi or alter recall state.

## Deterministic evidence

- Adapter tests cover the exact four registered tools, host-owned invocation context, default denial, bounded output, and sanitized handler failures.
- Planner tests cover deterministic ordering, bounded exclusions, source provenance, project isolation, current confirmed records, and no database mutation.
- The Session A to Session B harness test verifies distinct sessions, context delivery, trace-safe digest evidence, clean closure, and empty-recall behavior.
- Existing Core tests continue to cover permission denial and confirmation gating.
- The Stage 1 manifest remains bound to its synthetic fixture bytes; production server, chat route, and legacy memory store remain unchanged from the Stage 2 boundary.

## Optional live smoke

The credential-gated live smoke command is available through `npm run spike:pi-continuity`. Live smoke was run with `yapi/gpt-5.6-terra` on 2026-08-22 after securely loading the API key from the Windows user environment into that process only.

A sanitized live smoke run created distinct Session A and Session B identifiers, registered exactly the four Margin tools, and produced a context digest. Its report recorded `toolsRegistered`, `sessionBoundary`, `contextDelivered`, `provenancePresent`, and `safetyPolicy` as true.

This is evidence that the isolated integration path can run against the configured provider. A single smoke run does not establish task success, recall quality, reliability, cost, market demand, or user value.

## Explicit exclusions

The following remain outside Stage 3 and are neither implemented nor claimed:

- production chat activation;
- legacy migration or automatic import of existing data;
- 50-task evaluation;
- A/B/C comparison;
- recall metrics;
- user research.

Production activation, broad evaluation, and user validation require a later explicit decision and separate evidence.
