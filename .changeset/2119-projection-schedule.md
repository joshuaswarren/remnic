---
"@remnic/core": minor
---

Scheduled memory-projection rebuild + loud staleness telemetry (#2119).

The memory projection (`state/memory-projection.sqlite`) was rebuild-only: the
manual CLI and tests were the sole callers of `rebuildMemoryProjection`, so no
runtime path kept it current. It went stale the moment the lifecycle ledger grew
past the last rebuild, and `getMemoryTimeline` (plus browse/current-state)
silently fell back to full-corpus ledger scans — the expensive path a prior
incident traced to daemon CPU saturation.

- The `MaintenanceScheduler` now runs an interval-throttled, single-flighted
  projection rebuild on every maintenance request (alongside lifecycle-ledger
  auto-compaction). It is skipped when the projection's on-disk `rebuiltAt` meta
  is younger than the cadence, so restarts and operator `remnic
  rebuild-memory-projection` crons both suppress a redundant rebuild. A real
  rebuild logs the lag it just cured plus the fresh row counts.
- The timeline-consumer fallback WARN is now loud: it reports how stale the
  projection is (age since `rebuiltAt`, or "never rebuilt"), still rate-limited
  to once per interval per consumer so it never spams.
- New config: `projectionRebuildEnabled` (default `true`) and
  `projectionRebuildIntervalMs` (default 6h, floored at 60s). Set
  `projectionRebuildEnabled: false` to disable and rely on the CLI rebuild.
