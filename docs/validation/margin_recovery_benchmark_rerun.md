# Margin Recovery Benchmark — Final Rerun

## Result

**PARTIAL — the current task runtime cannot expose provider input-token counts or enforce the required per-run filesystem isolation, so no 24-run result can honestly be called protocol-valid.**

No Margin product code was modified. All recovery attempts from the earlier rerun are excluded as invalid history; this report reports no resulting performance number.

## Frozen inputs

- Ground truth: [recovery-benchmark-ground-truth.json](<repo>\docs\validation\recovery-benchmark-ground-truth.json)
- SHA-256 verified unchanged: `8BFA7E421299E5432C55E6DD4A2FF71C1D6B44B940C356F0A453A3F5C5FBF8FB`
- Case-specific handoff manifest: [manifest.json](<repo>\docs\validation\recovery-handoffs\manifest.json)
- Case artifacts: `case-01.md` through `case-12.md`, each generated from the current Margin Handoff Core and annotated with its case ID, source session ID, and workspace/repository.
- Identity verification: 12/12 case → session ID → Handoff header and SHA-256 mappings verified before the execution decision.
- Balanced order is frozen in [margin_recovery_benchmark_rerun.json](<repo>\docs\validation\margin_recovery_benchmark_rerun.json): 6 A→B and 6 B→A.

The workspace `.margin/HANDOFF.md` was never replaced during this final rerun preparation and remains at SHA-256 `C9593EF490E462A9D8EDC998D1EAA7F26AFBBC4F36F0EB0AEBFAA952A22B4826`.

## Blocking conditions

The available independent-task APIs permit creating and observing tasks, but do not return the provider-reported input-token count required by the protocol. Estimating it would violate the stated measurement rule.

They also cannot impose a per-task filesystem allowlist. A task given this repository could read the frozen ground truth or another case's Handoff; prompt instructions alone cannot prove the required prohibition. Therefore a launched task could not be certified as a valid clean run.

## Resume-safe metrics

| Metric | Result |
| --- | --- |
| Valid clean runs | `0 / 24` |
| Correct B-Handoff usage | N/A — no B run launched |
| Paired median recovery time | N/A |
| Paired median provider input tokens | N/A — unavailable, not estimated |
| Paired median tool/search cost | N/A |
| Accuracy | N/A — blind scoring not started |
| Unsupported claim rate | N/A — blind scoring not started |

Integrity status: frozen ground truth unchanged; 12 frozen Handoff artifacts present and mapped; 6/6 balanced ordering preserved; no case deleted; original workspace HANDOFF preserved. The unresolved requirements are 24/24 valid clean runs, valid B-case isolation, provider input-token records, and post-run blind scoring.
