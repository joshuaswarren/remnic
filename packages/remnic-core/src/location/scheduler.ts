/**
 * Location auto-sync — in-process periodic day sync (issue #2047).
 *
 * Arms one repeating timer that runs the SAME shared surface runner
 * (`runLocationSync`) as the CLI/MCP/HTTP surfaces over the configured
 * `location.syncDays` window ending yesterday, so late provider uploads are
 * picked up on the next tick. Master default-off: the caller (maintenance
 * scheduler registration) arms this only when `location.enabled` is true and
 * at least one source is enabled; a forced manual sync never bypasses those
 * gates — they live inside the pipeline itself.
 *
 * The timer is unref'd so one-shot CLI processes exit naturally; ticks are
 * serialized (an overlapping tick is skipped, not queued). ponytail: fixed
 * default cadence (daily) with no per-install override — add a
 * location.syncIntervalHours config field if installs need it.
 */

import { log } from "../logger.js";
import { runLocationSync, type LocationSyncRuns } from "./surfaces.js";
import type { LocationConfig } from "./types.js";

export const LOCATION_SYNC_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LocationAutoSyncSettings {
  config: LocationConfig;
  memoryDir: string;
  /** Tick cadence in ms; defaults to LOCATION_SYNC_DEFAULT_INTERVAL_MS. */
  intervalMs?: number;
  /** Clock/timer seam for tests. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

export interface LocationAutoSyncDeps {
  /** Run a sync (defaults to the shared surface runner). */
  sync?: (deps: { config: LocationConfig; memoryDir: string }) => Promise<LocationSyncRuns>;
  log?: { info(message: string): void; warn(message: string): void };
}

export interface LocationAutoSyncHandle {
  /** Run one tick now (first-run hook and test seam). */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export function startLocationAutoSync(
  settings: LocationAutoSyncSettings,
  deps: LocationAutoSyncDeps = {},
): LocationAutoSyncHandle {
  const logger = deps.log ?? log;
  const intervalMs = settings.intervalMs ?? LOCATION_SYNC_DEFAULT_INTERVAL_MS;
  const setIntervalImpl = settings.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalImpl = settings.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  const sync =
    deps.sync ??
    ((deps: { config: LocationConfig; memoryDir: string }) =>
      runLocationSync({ config: deps.config, memoryDir: deps.memoryDir }));
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const timer = setIntervalImpl(() => {
    if (inFlight !== null || stopped) return;
    inFlight = (async () => {
      try {
        const runs = await sync({ config: settings.config, memoryDir: settings.memoryDir });
        const failed = runs.some((run) => run.results.some((result) => result.status === "failed"));
        if (failed) {
          logger.warn("location auto-sync: one or more sources failed — retrying on the next tick");
        } else {
          logger.info(
            `location auto-sync: refreshed ${settings.config.syncDays}-day window across ${settings.config.sources.length} source(s)`,
          );
        }
      } catch (err) {
        // An abort raised by stop() is intentional shutdown, not a failure.
        if (err instanceof Error && err.name === "AbortError") return;
        logger.warn(
          `location auto-sync failed: ${err instanceof Error ? err.name : "unknown error"} — retrying on the next tick`,
        );
      } finally {
        inFlight = null;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return {
    async tick() {
      const runs = await sync({ config: settings.config, memoryDir: settings.memoryDir });
      logger.info(
        `location auto-sync tick: ${runs.length} day(s) across ${settings.config.sources.length} source(s)`,
      );
    },
    async stop() {
      stopped = true;
      clearIntervalImpl(timer);
      await inFlight;
    },
  };
}
