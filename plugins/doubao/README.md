# Margin Agent plugin — 豆包

This directory is what an Agent fetches when it is asked to integrate itself with Margin. It is a
**plugin repository**, and the only thing in it that matters is `agent.json`.

## What a plugin is

A plugin is **data, never code**. Margin validates `agent.json` against the
[Agent Descriptor Spec](../../src/agents/descriptor/spec.js) and composes an adapter from its own
fixed reader catalogue. Nothing in the file is evaluated as an expression, a glob cannot smuggle in a
regex, and no path in it is executed. That is the whole reason a third-party repository can be
installed without Margin gaining a download-and-run surface.

What the spec can express:

| | |
|---|---|
| `sessions.kind: "transcript"` | where the Agent keeps sessions (`roots`, `layout`) and how to read one (`transcript`) |
| field extractors | `directoryName`, `filename`, `mtime`, `record`, `scanAbsolutePaths` |
| `homeCandidates` | the ordered places the Agent might be installed |
| `probe` | a structural check that a directory really looks like this Agent |
| `resources.kind` / `handoff.kind` | a reference to a built-in reader, or `none` |

What it cannot express, and must therefore say `none` for: a credential-bearing subscription
endpoint, an opaque or encrypted store, request signing, and **handoff** (the shared Handoff Core
consumes Codex-shaped records, and each Agent brings its own extraction layer). A descriptor that
claims `capabilities.handoff: true` without a `handoff.kind` implementation is a **validation
error**, not a runtime fallback to some other Agent's transcript.

## The install contract

An Agent that wants to onboard itself does exactly this:

```bash
# 1. Fetch this repository (the Agent's own job — Margin never downloads anything).
git clone <plugin-url> ./margin-agent-doubao

# 2. See what it would do, changing nothing.
margin agent install ./margin-agent-doubao/agent.json --dry-run

# 3. Install. Margin resolves the descriptor's candidate homes against THIS machine,
#    writes it to ~/.margin/agents/doubao.json, and registers the source it found.
margin agent install ./margin-agent-doubao/agent.json
```

`install` is idempotent and reports every candidate it tried:

```
Installed doubao (豆包): descriptor created at C:\Users\<user>\.margin\agents\doubao.json
  candidate  C:\Users\<user>\AppData\Local\Doubao\User Data\Default\.doubao\agent_mode\workspace  exists  probe ok
  candidate  C:\Users\<user>\.doubao\agent_mode\workspace  missing  Path does not exist
  home       C:\Users\<user>\AppData\Local\Doubao\User Data\Default\.doubao\agent_mode\workspace
  source     registered (doubao-1a2b3c4d5e6f)
```

The same two operations over HTTP, for a host that is not a shell:

```
POST /api/agents/install     { "descriptor": {...}, "path": null, "dryRun": false }
POST /api/agents/uninstall   { "type": "doubao", "dryRun": false }
```

## Removing it again

```bash
margin agent uninstall doubao          # descriptor + every registration of this type
margin agent remove <sourceId>         # just the source, keeping the plugin installed
margin agent enable <sourceId>         # undo a removal
```

Removal is complete, and that is a property worth stating explicitly because it is easy to get
wrong:

* An Agent that **detection would recreate** is removed as a *tombstone* (`suppressed: true`) rather
  than deleted. Deleting the record only moved the problem to the next detection pass, which made an
  auto-detected Agent impossible to get rid of.
* An Agent detection **cannot** recreate is deleted outright.
* `uninstall` purges registrations instead of tombstoning them, because it removes the descriptor in
  the same operation — there is nothing left to suppress.
* Built-in types (`codex`, `claude`, `pi`) can never be uninstalled, only their sources removed. A
  plugin file cannot take over a built-in type either: that is reported, not applied.

## Why 豆包 is a plugin and not built in

A type is built in only when Margin also ships the *reader* for it. 豆包 is fully expressible by the
declarative catalogue, so it lives here — which is also what makes the install/remove round trip
testable. Its quota panel is a real capability (`GET /alice/commerce/sale/subscription/quota/summary`
on the 豆包 gateway, three rolling windows) but it needs a credential-bearing reader, so it stays
`resources: { "kind": "none" }` until that reader exists. Claiming `quota: true` before then would put
an unavailable metric on the bar and call it support.

## Testing loop

```bash
margin agent install plugins/doubao/agent.json
margin agent list                       # doubao appears with capabilities:sessions
# ... exercise it ...
margin agent uninstall doubao
margin agent list                       # gone; `margin agent detect` will not bring it back
```

`test/agentDescriptor.test.js` runs exactly this loop against a synthetic workspace.
