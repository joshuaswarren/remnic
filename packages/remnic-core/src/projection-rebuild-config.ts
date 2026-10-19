/**
 * Scheduled projection-rebuild knobs (issue #2119, heap guard).
 *
 * Extracted from `config.ts` / `types.ts` so those god-file ceilings do not
 * grow. `PluginConfig` extends the interface and `parseConfig` spreads
 * {@link parseProjectionRebuildScheduleConfig}.
 */

import { coerceBooleanLike, coerceNumber } from "./connectors/coerce.js";

/** Knobs for the maintenance-scheduled memory-projection rebuild. */
export interface ProjectionRebuildScheduleConfig {
  /**
   * Enable the maintenance-scheduled rebuild of `state/memory-projection.sqlite`.
   * The projection is otherwise rebuild-only (manual CLI / tests), so it rots as
   * the lifecycle ledger grows and timeline/browse consumers silently regress to
   * full-corpus fallback scans. Default true — mirrors lifecycle-ledger
   * auto-compaction, which is likewise enabled-by-default to keep a state file
   * healthy. Set false to disable (operators can still cron the CLI rebuild).
   */
  projectionRebuildEnabled: boolean;
  /**
   * Minimum interval between scheduled projection rebuilds. A rebuild is skipped
   * when the projection's `rebuiltAt` meta is younger than this, so a burst of
   * maintenance requests cannot fan into back-to-back rebuilds. Floored at 60s.
   * Default 6h (matches memoryLifecycleLedgerCompactMinIntervalMs).
   */
  projectionRebuildIntervalMs: number;
  /**
   * Postpone a scheduled full-corpus projection rebuild when
   * `v8.getHeapStatistics().used_heap_size / heap_size_limit` exceeds this
   * ratio. Finite number in `(0, 1]`. Default `0.6`. `1` disables the guard
   * (usage cannot exceed the limit). A postponed rebuild uses the failure
   * backoff and does not start the multi-GB allocation.
   */
  projectionRebuildHeapUsageLimit: number;
}

/** Integer coercion contract shared with `config.ts` (`parseIntegerAtLeast`). */
type IntegerParser = (value: unknown, fallback: number, min: number, keyName: string) => number;

/** Default heap-usage ratio above which a scheduled full-corpus rebuild waits. */
export const DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT = 0.6;

/**
 * Parse `projectionRebuildHeapUsageLimit`. Absent values take the default.
 * A present value must be a finite number in `(0, 1]` (numeric strings
 * coerced). `0` is rejected: it would postpone every rebuild.
 */
export function parseProjectionRebuildHeapUsageLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced) || coerced <= 0 || coerced > 1) {
    throw new Error(
      `projectionRebuildHeapUsageLimit must be a finite number in (0, 1]; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

/**
 * Parse the scheduled projection-rebuild knobs. Boolean coercion follows
 * gotcha #36 (`"false"` is false). The interval uses the shared integer
 * parser (strings coerced, non-integers and sub-60s values rejected).
 */
export function parseProjectionRebuildScheduleConfig(
  cfg: Record<string, unknown>,
  parseIntegerAtLeast: IntegerParser,
): ProjectionRebuildScheduleConfig {
  return {
    projectionRebuildEnabled: coerceBooleanLike(cfg.projectionRebuildEnabled) ?? true,
    projectionRebuildIntervalMs: parseIntegerAtLeast(
      cfg.projectionRebuildIntervalMs,
      6 * 60 * 60 * 1000,
      60_000,
      "projectionRebuildIntervalMs",
    ),
    projectionRebuildHeapUsageLimit: parseProjectionRebuildHeapUsageLimit(
      cfg.projectionRebuildHeapUsageLimit,
    ),
  };
}
