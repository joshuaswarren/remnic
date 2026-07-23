/**
 * Scheduled rebuild of the root memory projection (issue #2119).
 *
 * The projection (`state/memory-projection.sqlite`) is otherwise rebuild-only
 * (manual CLI / tests), so it goes stale as the lifecycle ledger grows and
 * timeline/browse consumers silently fall back to full-corpus scans. The
 * MaintenanceScheduler fires this alongside ledger compaction on every
 * maintenance request — interval-throttled, single-flighted, never awaited,
 * never throws.
 *
 * `projectionRebuildEnabled` gates it (via the lifecycle capabilities
 * resolver, default true); `projectionRebuildIntervalMs` is the cadence.
 *
 * Skipped when the projection was rebuilt within the interval. The freshness
 * check reads the on-disk `rebuiltAt` meta (not just an in-process timestamp)
 * so a daemon restart or an operator's cron `remnic rebuild-memory-projection`
 * both suppress a redundant rebuild. On a real rebuild it logs the lag it just
 * cured (age of the projection before the rebuild) plus the fresh row counts,
 * so operators can see the projection was drifting. Failures are non-fatal
 * and leave the throttle un-advanced to retry.
 *
 * Scope: the root memoryDir projection — the one `getMemoryTimeline` /
 * browse / current-state serve from `baseDir`. Per-namespace projections are
 * not yet scheduled here (they are still served by their own rebuild paths);
 * the fallback WARN surfaces staleness for any namespace that lags.
 */
import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import { resolveMemoryLifecycleCapabilities } from "../capabilities.js";
import {
  rebuildMemoryProjection,
  type RebuildMemoryProjectionOptions,
} from "../maintenance/rebuild-memory-projection.js";
import { readProjectionRebuiltAt } from "../maintenance/projection-support.js";

type InjectedStorage = NonNullable<RebuildMemoryProjectionOptions["storage"]>;

export interface ProjectionRebuildScheduleState {
  inFlight: boolean;
  lastRebuildAtMs: number;
}

export function createProjectionRebuildScheduleState(): ProjectionRebuildScheduleState {
  return { inFlight: false, lastRebuildAtMs: 0 };
}

export async function maybeRebuildMemoryProjectionScheduled(opts: {
  config: PluginConfig;
  /** The daemon's live root storage, when available (secure-store unlock). */
  getStorage?: () => InjectedStorage | undefined;
  state: ProjectionRebuildScheduleState;
}): Promise<void> {
  const { config, state } = opts;
  if (!resolveMemoryLifecycleCapabilities(config).projectionRebuild) return;
  if (state.inFlight) return;
  const intervalMs = config.projectionRebuildIntervalMs;
  const now = Date.now();
  if (now - state.lastRebuildAtMs < intervalMs) return;

  const rootStorage = opts.getStorage?.();
  const memoryDir = rootStorage ? rootStorage.dir : config.memoryDir;

  // On-disk freshness check: survives restarts and cross-process CLI rebuilds.
  const rebuiltAt = readProjectionRebuiltAt(memoryDir);
  const rebuiltAtMs = rebuiltAt ? Date.parse(rebuiltAt) : Number.NaN;
  if (Number.isFinite(rebuiltAtMs) && now - rebuiltAtMs < intervalMs) {
    // Fresh already — adopt its timestamp so the next pass short-circuits on
    // the cheap in-process guard without re-opening the projection each time.
    state.lastRebuildAtMs = rebuiltAtMs;
    return;
  }

  state.inFlight = true;
  try {
    const result = await rebuildMemoryProjection({
      memoryDir,
      // Reuse the daemon's live storage so secure-store deployments rebuild
      // through the unlocked instance instead of a fresh locked one.
      ...(rootStorage ? { storage: rootStorage } : {}),
      defaultNamespace: config.defaultNamespace,
      dryRun: false,
      now: new Date(now),
    });
    state.lastRebuildAtMs = Date.now();
    const lag = Number.isFinite(rebuiltAtMs)
      ? `${Math.max(0, Math.round((now - rebuiltAtMs) / 60_000))}m stale`
      : "never previously built";
    log.info(
      `memory projection rebuilt (scheduled) for ${memoryDir}: was ${lag}; `
      + `${result.currentRows} current, ${result.timelineRows} timeline, `
      + `${result.entityMentionRows} entity-mention rows`,
    );
  } catch (err) {
    // Non-fatal: leave the throttle un-advanced so the next maintenance pass
    // retries rather than declaring a stale projection cured.
    log.warn(`memory projection scheduled rebuild failed (non-fatal) for ${memoryDir}: ${err}`);
  } finally {
    state.inFlight = false;
  }
}
