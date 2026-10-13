# Margin Agent plugin — Nova (synthetic fixture)

`agent.json` here is **not** a real Agent integration. It is the *output* of a Margin Integration
Skill run against a synthetic "unknown future Agent" fixture called **Nova**, used to validate that
Margin's existing descriptor protocol can accept an Agent it has never seen — with no Margin code
change and no hand-written adapter.

The full validation, including the fixture data and the negative cases, lives in
`test/agentSelfIntegration.test.js`. The research report is
`docs/research/agent-self-integration-validation.md`.

## What the fixture Agent exposes

Nova is deliberately **not** shaped like the shipped 豆包 plugin. 豆包 has no native working directory
and no native timestamps, so it uses `scanAbsolutePaths` and `mtime`. Nova is the opposite and is
therefore a harder case for the bounded catalogue: every projection field is a **native value** read
from a nested record stream.

| Fixture surface | Where it lives | Descriptor binding |
|---|---|---|
| session data | `{home}/sessions/<rollout>/events.jsonl` (JSONL, append-only) | `sessions.kind: "transcript"`, `transcript.glob` |
| native session identity | `session.id` on the `session.start` record | `sessions.id: { kind: "record", … }` |
| workspace information | `session.cwd` on the `session.start` record | `sessions.workspace: { kind: "record", … }` |
| timestamps | `session.createdAt` / `session.updatedAt` (ISO-8601) | `createdAt` / `updatedAt` `record` extractors |
| execution status | `turn.assistant.finishReason` | `executionStatus: { kind: "transcript", … }` |

The native session id is intentionally **different** from the rollout directory name
(`rollout_0001/` holds native id `nova-7f3a1c9e`), so the test proves the id is preserved from the
record rather than inferred from a path.

## Install contract (identical to any plugin)

```bash
margin agent install plugins/nova/agent.json --path <nova-home> --dry-run
margin agent install plugins/nova/agent.json --path <nova-home>
margin agent uninstall nova
```

`test/agentSelfIntegration.test.js` runs exactly this loop against a fresh temp profile and proves the
descriptor is validated, dry-run installs change nothing, install composes an adapter, the composed
adapter projects sessions with native identity / workspace / timestamps intact, invalid declarations
are refused, and uninstall leaves no trace.

## Boundaries this fixture demonstrates (not gaps to paper over)

* **`quota`, `apiUsage`, `subscriptionQuota`, `handoff` are `false` on purpose.** Nova exposes quota
  behind a credentialed endpoint and handoff behind its own transcript distiller. The declarative
  catalogue has no form for either, and a capability claimed without a declared reader is a
  validation error. Those requests belong in the skill's *report*, never in the manifest.
* **A header held outside the transcript is not expressible.** The `record` extractor reads the
  single JSONL file matched by `transcript.glob`; an Agent whose native id/cwd/timestamps live in a
  sibling `meta.json` projects zero sessions. That is a catalogue boundary. The correct response,
  per `docs/research/s10.1b-decision.md`, is a human decision to add one declarative primitive or a
  built-in reader — never to grow the fixture or generate adapter code.

## Provenance

Unlike the `doubao` plugin, this file carries no `generatedBy` field: the research proposal for
provenance (`docs/research/agent-manifest-schema.md` §7.3) is **not yet implemented**, and the
current hardened validator treats `generatedBy` (like `runtime`) as an unknown top-level key and
refuses it. A skill targeting the current protocol must emit only current keys. See the report's
"Blockers" section.
