# Margin

Margin is a memory-driven personal AI companion built around Workstreams, Runs,
durable state, and safe continuation. Its visual and product language is paper,
ink, margin notes, and returning to the live line of unfinished work.

## Current Status: Phase 2B Web Workbench

The default local surface is a desktop-first React Workbench backed by the
persistent Margin Core. It supports:

- creating, selecting, and refreshing Workstreams;
- creating and controlling Runs;
- resolving NeedsOwner items;
- viewing Artifact metadata and cursor-derived Activity;
- a minimal Pi-backed interaction while a Run is running;
- browser and server restart without browser-owned domain state.

The authoritative V1 database for both Web and Terminal surfaces is
`data/terminal-pilot/margin-core.sqlite`. The Web adapter reaches it only
through the trusted Application Gateway (`execute`, `query`, and `events`). It
does not import the legacy application, routes, or legacy memory store, and it
does not create a second SQLite database or browser shadow state.

The frozen legacy `data/echo.sqlite` database is not migrated, merged, or
double-written by the Workbench.

## Quick Start

Install dependencies and copy the environment template:

```powershell
npm install
Copy-Item .env.example .env
```

Build the browser application, then start the production Workbench:

```powershell
npm run build
npm start
```

`npm start` only serves an already-built `web/dist`; it never runs a hidden
build. Production startup fails with `web_assets_missing` and tells you to run
the build when the assets are absent. The default address is
`http://127.0.0.1:3000`.

For development, run the HTTP adapter with Vite middleware:

```powershell
npm run dev
```

`run-margin-local.cmd` starts the same Web Workbench with the pinned local Node
22 runtime.

## Pi Web Interaction

The Web Workbench uses the same safe Pi provider defaults as the Terminal
pilot:

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
Workbench remains available and interactions return the stable
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

The old Express product API and its data are archived. The launcher is retained
for a clear migration message and exits without starting a server:

```powershell
npm run legacy:api
```

`run-echo-local.cmd` reports the same archived status. The historical API
source remains in the repository for review; the frozen `data/echo.sqlite`
database is not opened for writes by either launcher.

## Web Transport

The isolated Web host exposes:

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

## Environment

Core Web settings:

```dotenv
PORT=3000
NODE_ENV=development
MARGIN_WEB_HOST=127.0.0.1
MARGIN_CORE_DB_PATH=./data/terminal-pilot/margin-core.sqlite
MARGIN_LOG_LEVEL=info
```

The default bind address is loopback. Remote exposure, authentication, and
multi-user authorization are outside this phase.

Settings such as `MARGIN_LLM_PROVIDER` and `MARGIN_DB_PATH` belong only to the
explicit deprecated API. `ECHO_LOG_LEVEL`, `ECHO_LLM_PROVIDER`, and
`ECHO_DB_PATH` remain temporary compatibility inputs for that legacy surface.

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

The old database is preserved unchanged. A read-only inventory and explicit,
non-overwriting export remain available:

```powershell
npm run inventory:legacy
npm run export:legacy -- data/echo.sqlite --approve --output data/exports/echo-legacy-copy.json
```

The original `data/echo.sqlite` and the earlier full JSON export are retained
locally. See `docs/audit/legacy_retirement_plan.md` for hashes and disposition,
and `docs/architecture/phase_1_persistent_core.md` for the authoritative Core.

## License

MIT
