---
"@remnic/core": minor
"@remnic/cli": minor
---

Procedure library health maintenance (issue #2370): a shadow-first job that
consumes existing telemetry — Memory Worth `mw_success`/`mw_fail`, access
timestamps, causal trajectories — and proposes merge / repair-flag / retire
transitions for ACTIVE procedure memories, so a procedure store that only
ever grew can now be curated.

- New `runProcedureLibraryMaintenance` in `@remnic/core`. Merge clusters
  near-identical active procedures (normalized trigger phrase + ordered step
  signature), keeps the most-recently-updated member as canonical (stable id
  tiebreak), supersedes the rest, and stamps the canonical with the existing
  pattern-reinforcement frontmatter contract so `patterns explain` keeps
  working. Repair flags stale-tool procedures via
  `structuredAttributes.needsRepair` and never rewrites a body. Retire demotes
  failure-dominant or idle procedures to `archived` — never deletes.
  User-edited procedures are exempt from merge and retirement; they are
  flagged for review instead.
- Shadow-first: the default run writes nothing at all. Applying requires
  `apply: true` AND `procedural.maintenance.enabled: true`.
- Surfaces: MCP `remnic.procedure_library_maintenance` (alias
  `engram.procedure_library_maintenance`) and CLI `remnic procedural maintain
  [--apply] [--format json|text]`. `remnic procedural stats` now reports
  `lastMaintenanceAt` and `needsRepairFlags`.
- Procedures are now eligible for `memory_outcome`, and injected procedures
  flow into the same per-recall bookkeeping as other memories
  (`LastRecallSnapshot.memoryIds`, access tracking), so success/failure
  judgments reach their counters.
- New config under the existing block: `procedural.maintenance.{enabled,
  retireIdleDays, retireMinOutcomes, retireFailRatio, mergeEnabled}`.
  Numeric keys reject invalid values instead of silently defaulting;
  `retireIdleDays: 0` disables idle-based retirement.

Part of #2370.
