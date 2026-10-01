# Legacy Echo Data Disposition

Status: Updated 2026-09-26. All tables archived locally; no record migrated or deleted.

## Boundary

`data/terminal-pilot/margin-core.sqlite` is the only Source of Truth for Margin V1 Workstream, Run, Event, Decision, Artifact, Checkpoint, Memory and Action state. `data/echo.sqlite` is a frozen legacy dataset. The old Express routes remain test-covered only as a deprecated compatibility surface and must not receive new V1 behavior.

The default `npm start` entry opens the Margin Board. The old API launcher now exits with an archived-status message and does not open the legacy database for writes. The user decided to archive every legacy table without importing it into Core or deleting the source database. The export and verification are recorded in `legacy_retirement_plan.md`.

## Read-only inventory

Inventory command:

```powershell
npm run inventory:legacy
```

Observed on 2026-08-23 without reading record content into the report:

| Table | Rows | Phase 1 proposal (superseded by the 2026-09-26 archive decision) |
| --- | ---: | --- |
| conversations | 19 | archive |
| summaries | 1 | archive |
| actions | 2 | migrate candidate after review |
| learning_sessions | 1 | migrate candidate after review |
| learning_events | 12 | migrate candidate after review |
| user_profile | 8 | migrate candidate after review |
| knowledge_base | 0 | delete candidate after export |
| operation_proposals | 3 | delete candidate after export |
| operation_events | 5 | delete candidate after export |
| user_states | 6 | delete candidate after export |

The inventory records column metadata, counts, per-table schema hashes, database schema hash and file hash. It never emits conversation/profile values.

Final disposition for all ten rows above: **archive**. `inventory:legacy` now reports that final disposition; the earlier proposals remain in this table as historical context.

## Export and migration policy

- Nothing is auto-imported as Memory, Decision, Workstream or user truth.
- A full-content export requires both `--approve` and a new output path; overwrite is refused.
- The earlier migration and deletion candidates were superseded by the user's archive-only decision.
- Legacy IDs and raw records remain unchanged.

Example explicit export (not run during Phase 1):

```powershell
npm run export:legacy -- data/echo.sqlite --approve --output data/exports/echo-legacy-v1.json
```
