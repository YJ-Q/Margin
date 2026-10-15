# Margin

Margin is a memory-driven personal AI companion built around Workstreams, Runs,
durable state, and safe continuation. Its visual and product language is paper,
ink, margin notes, and returning to the live line of unfinished work.

### Current Status: Margin Board; V0.2 scope under audit

The default local surface is the React Margin Board: external Agent sessions,
source management, evidence-backed status, and handoff where an existing adapter
supports it. The Board reads Runtime facts; Core writes remain behind the
Application Contract. Session-to-Run links use the existing bridge.

The Core database is `data/terminal-pilot/margin-core.sqlite`. The Terminal pilot
and the API-only Application Gateway remain alternate surfaces; the former
Workbench UI has been removed.

V0.2's thesis is "Trust before reach." Tier 1 Self-Integration supports only session
sources expressible by the existing declarative reader catalogue. The shipped
[Integration Skill](skills/margin-agent-integration/SKILL.md) v0.1.1 emits data-only
manifest/report artifacts; [agent verify](docs/agent-verify.md) checks observed
session evidence before separate, user-confirmed installation. A verified sample
does not establish complete session coverage or resource/runtime/handoff support.
Opaque/private storage requires a native reader; OpenCode/SQLite and grouped-root
support are deferred. See the [V0.2 readiness audit](docs/roadmap/v0.2-readiness.md)
for the frozen scope, evidence limits, and release blockers.

The legacy Echo dataset is retired: it is not migrated, merged, or
double-written, and the local frozen `data/echo.sqlite` copy was physically
deleted on 2026-10-02 after a recorded decision
(`docs/audit/legacy_retirement_plan.md` §7).

## Quick Start

Install dependencies and copy the environment template:

```powershell
npm install
Copy-Item .env.example .env
```

Build the browser application, then start the production Board:

```powershell
npm run build
npm start
```

`npm start` only serves an already-built `web/dist`; it never runs a hidden
build. Production startup fails with `margin_surface_assets_missing` and tells you to run
the build when the assets are absent. The default address is
`http://127.0.0.1:3100`.

For development, run the HTTP adapter with Vite middleware:

```powershell
npm run dev
```

`run-margin-local.cmd` starts the same Margin Board with the pinned local Node
22 runtime.

### Pi interaction through the alternate Application Gateway

The API-only Application Gateway (`npm run legacy:workbench`, port 3000) uses
the same safe Pi provider defaults as the Terminal pilot:

```dotenv
MARGIN_PI_PROVIDER=yapi
MARGIN_PI_MODEL=gpt-5.6-terra
MARGIN_PI_BASE_URL=https://yapi.click/v1
MARGIN_PI_API=openai-responses
MARGIN_PI_API_KEY_ENV=YAPI_API_KEY
YAPI_API_KEY=
```

The credential value stays process-local and is never written to reports or
normal startup output. When provider configuration is missing or invalid, the
Gateway remains available and interactions return the stable
`runtime_unavailable` code. The browser never calls Pi directly.

Pi is pinned to `@earendil-works/pi-coding-agent` `0.84.2`. Its built-in file,
command, edit, and write tools are disabled for this path. Only the governed
Margin continuity tools are exposed, so model text is not evidence of a state
change; persisted DTO versions, tool result codes, and Event Cursor movement
are the evidence.

## Alternate Surfaces

The Terminal continuity pilot remains available as an advanced/debug surface:

```powershell
npm run pilot:terminal
```

Its commands include `/state`, `/status`, `/pause`, `/resume`, `/stop`,
`/checkpoint`, `/memory`, `/confirm-memory <memoryId> <version>`, `/new`, and
`/exit`.

The old Express product API is archived; its local dataset has since been
physically deleted (2026-10-02). The launcher is retained for a clear migration
message and exits without starting a server:

```powershell
npm run legacy:api
```

`run-echo-local.cmd` reports the same archived status. The historical API source
has been removed; neither launcher starts a server or opens a database.

## Web Transport

The alternate Application Gateway exposes the following routes; these are not
the default Board's routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | bounded readiness and contract version |
| `POST` | `/api/commands` | Application Gateway commands |
| `POST` | `/api/queries` | Application Gateway queries |
| `GET` | `/api/events` | monotonic Event Cursor reads |
| `POST` | `/api/interactions` | governed Pi interaction |

The server owns actor, surface, capabilities, correlation identity, Core path,
and runtime boundaries. Browser input cannot supply trusted host context.
Responses exclude credentials, stacks, Pi internals, session material, hidden
reasoning, and Chain-of-Thought.

The default Board exposes session, source, resource-status and handoff routes.
See the [interface registry](docs/architecture/interface-registry.md) for both
surfaces and their ownership boundaries.

## Environment

Board and alternate Gateway settings:

```dotenv
PORT=3000
NODE_ENV=development
MARGIN_SURFACE_HOST=127.0.0.1
MARGIN_SURFACE_PORT=3100
MARGIN_CORE_DB_PATH=./data/terminal-pilot/margin-core.sqlite
MARGIN_LOG_LEVEL=info
```

The default bind address is loopback. Remote exposure, authentication, and
multi-user authorization are outside this phase.

Legacy settings such as `MARGIN_LLM_PROVIDER`, `MARGIN_DB_PATH`, and `ECHO_*`
do not re-enable the archived API.

## Verification

Run the browser build and full automated suite:

```powershell
npm run build
npm test
npm run validate:stage1
npm run audit:pi
```

Focused coverage includes Gateway trust ownership, HTTP error safety, Workbench
composition, browser state, Run controls, NeedsOwner, Artifacts, Activity
polling, Pi coordination, non-model HTTP restart E2E, legacy gating, and
sanitized Live Pi evidence.

The earlier isolated continuity and Pi checks remain available:

```powershell
npm run spike:pi-continuity
npm run verify:pi-stage-0
```

Test counts are reported from each actual run instead of being maintained as a
static claim.

## Legacy Data Archive

The local legacy dataset (`data/echo.sqlite*` and its full-content JSON export)
was physically deleted on 2026-10-02 by recorded user decision, after the
read-only inventory and a non-overwriting export had been completed. The
read-only inventory and approval-gated export scripts remain for any other
explicit database path:

```powershell
npm run inventory:legacy
npm run export:legacy -- <path-to-another-sqlite> --approve --output data/exports/echo-legacy-copy.json
```

The original database can no longer be re-exported. Its file/schema/export
SHA-256 hashes and the table-by-table disposition remain as permanent audit
evidence in `docs/audit/legacy_retirement_plan.md`; see
`docs/architecture/phase_1_persistent_core.md` for the authoritative Core.

## License

MIT
