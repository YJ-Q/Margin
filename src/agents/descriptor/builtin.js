// The descriptors Margin ships.
//
// These are authored as plain data and pass through exactly the same validator and composition path
// as a descriptor a third party drops into ~/.margin/agents. They are kept in a JS module rather
// than JSON files so packaging cannot silently exclude them (a missed file would disable a built-in
// Agent at runtime) and so declaration order is explicit instead of filesystem-dependent.
//
// Membership rule: a type is built in only when Margin also ships the READER for it — `sessions.kind:
// 'builtin'`, `resources.kind: 'builtin'`, or both. Every one of these delegates to a reader module
// in adapters.js. An Agent that is fully expressible by the declarative catalogue belongs in a
// plugin under plugins/, even when it happens to be one the team uses daily: keeping it there is what
// keeps install/uninstall honest, because a built-in type can never be removed.
//
// A hand-written built-in adapter exists for handoff because the shared Handoff Core consumes
// Codex-shaped records and each Agent brings its own extraction layer — a capability the spec has no
// declarative form for and deliberately does not invent.

export const builtinDescriptors = Object.freeze([
  Object.freeze({
    specVersion: 1,
    type: 'codex',
    order: 10,
    label: 'Codex',
    provider: 'openai',
    resourceAgent: 'codex',
    defaultSourceName: 'Codex',
    envHome: 'CODEX_HOME',
    defaultHome: { fallback: '{profile}/.codex' },
    supportLevel: 'Full support',
    capabilities: { sessions: true, handoff: true, apiUsage: true, quota: true, executionStatus: true, attentionStatus: false },
    sessionCapabilities: { handoff: true, apiUsage: true, quota: true, executionStatus: true },
    sessions: { kind: 'builtin' },
    resources: { kind: 'builtin' },
    // Codex reads executionStatus from its SQLite terminal projection during discovery,
    // so this is builtin kind — the adapter's discovery function owns the full lifecycle
    // + terminal composition. No separate readExecutionStatus step is needed.
    executionStatus: { kind: 'builtin' },
    // Codex is the origin of the shared Handoff Core, so its capture/generate are the host-injected
    // Codex defaults rather than adapter-local methods.
    handoff: { kind: 'shared-codex' },
  }),
  Object.freeze({
    specVersion: 1,
    type: 'claude',
    order: 20,
    label: 'Claude',
    provider: null,
    resourceAgent: 'claude-code',
    quotaPrefix: 'Go',
    defaultSourceName: 'Claude',
    envHome: 'CLAUDE_HOME',
    defaultHome: { fallback: '{profile}/.claude' },
    supportLevel: 'Session discovery',
    // Source-level handoff stays false while a Claude *session* still advertises it. That split is
    // pre-existing behaviour and is preserved deliberately: collapsing the two surfaces here would
    // be a silent product change disguised as a refactor.
    capabilities: { sessions: true, handoff: false, apiUsage: false, quota: false, executionStatus: true, attentionStatus: false },
    sessionCapabilities: { handoff: true, executionStatus: true },
    sessions: { kind: 'builtin' },
    resources: { kind: 'builtin' },
    // Claude status is derived during built-in discovery from the last assistant turn's stop_reason
    // and native API-error marker in the project JSONL (see executionStatus.js). It follows the same
    // "last turn wins" rule as a descriptor transcript extractor, but cannot be declarative because
    // Claude's session reader spans the archive-filtered multi-file project layout.
    executionStatus: { kind: 'builtin' },
    handoff: { kind: 'builtin' },
  }),
  Object.freeze({
    specVersion: 1,
    type: 'pi',
    order: 30,
    label: 'Pi',
    provider: 'pi',
    resourceAgent: 'pi',
    quotaPrefix: 'Go',
    defaultSourceName: 'Pi',
    envHome: 'PI_HOME',
    defaultHome: { fallback: '{profile}/.pi' },
    supportLevel: 'Session discovery',
    capabilities: { sessions: true, handoff: true, apiUsage: false, quota: false, executionStatus: true, attentionStatus: false, subscriptionQuota: true },
    sessionCapabilities: { handoff: true, executionStatus: true },
    sessions: { kind: 'builtin' },
    resources: { kind: 'builtin' },
    // Pi status is derived during built-in discovery from the last assistant message's stopReason
    // (toolUse -> working, stop -> idle, error -> error, aborted -> idle); see executionStatus.js.
    executionStatus: { kind: 'builtin' },
    handoff: { kind: 'builtin' },
  }),
]);
