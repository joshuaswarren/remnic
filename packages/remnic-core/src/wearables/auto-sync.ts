/**
 * Wearables auto-sync — in-process periodic transcript refresh.
 *
 * Every tick re-syncs a short rolling window ending today for ALL
 * enabled sources, so the current day's transcript keeps growing while
 * the wearable records and provider-side revisions of recent days flow
 * in without operator action. Once per local day the window deepens to
 * `autoSyncDeepDays` to pick up late uploads and provider reprocessing
 * further back (phones syncing hours later, re-diarized transcripts).
 *
 * Day fetches are unconditional within the window — existing day files
 * are always re-fetched and re-composed; the content-hash skip in the
 * pipeline keeps unchanged days write-free, so a tick on a quiet day
 * is read-only. The timer is unref'd: it never keeps a one-shot CLI
 * process alive, and long-lived hosts stop it via the returned handle.
 */

import { describeErrorForOperator } from "./errors.js";
import { dateInTimezone, defaultTimezone } from "./pipeline.js";

export interface WearablesAutoSyncSettings {
  /** Minutes between ticks. */
  intervalMinutes: number;
  /** Rolling window (days ending today) refreshed on a normal tick. */
  days: number;
  /**
   * Window for the once-per-local-day deep pass. 0 disables the deep
   * pass; otherwise must be >= `days` (validated at config parse).
   */
  deepDays: number;
  /** IANA timezone used to detect the local-day rollover. */
  timezone?: string;
}

export interface WearablesAutoSyncDeps {
  /** Run a sync across all enabled sources (WearablesService.sync). */
  sync(options: { days: number; signal?: AbortSignal }): Promise<unknown>;
  log: { info(message: string): void; warn(message: string): void };
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface WearablesAutoSyncHandle {
  /** Run one scheduler tick now (first-run hook and test seam). */
  tick(): Promise<void>;
  /**
   * Stop the scheduler: clears the timer, aborts the in-flight sync's
   * provider fetches via AbortSignal, and resolves once the in-flight
   * tick has fully settled — after `await stop()` nothing is writing
   * or reindexing anymore. The handle is single-use; a restarted host
   * starts a fresh one.
   */
  stop(): Promise<void>;
}

/**
 * Start the periodic refresh. The first tick fires after one full
 * interval rather than at start — gateways on low-power hardware can
 * restart-loop during setup (issue #462), and an immediate fetch on
 * every restart would hammer provider APIs. Operators who want an
 * instant refresh run `wearables sync` (or call `tick()`).
 */
export function startWearablesAutoSync(
  settings: WearablesAutoSyncSettings,
  deps: WearablesAutoSyncDeps,
): WearablesAutoSyncHandle {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let lastDeepDate: string | null = null;
  // Aborting cancels the in-flight sync's provider fetches promptly on
  // shutdown — without it, a slow tick would keep writing/reindexing
  // after orchestrator.destroy() while a restarted host starts a
  // second scheduler (Kilo review on PR #1464).
  const abortController = new AbortController();

  const tick = async (): Promise<void> => {
    // Overlap guard: a slow provider or large deep window must never
    // stack a second sync on top of a running one. The skipped call
    // resolves immediately — it must NOT await the running tick, or a
    // caller holding both promises could deadlock itself.
    if (inFlight || stopped) return;
    const run = (async () => {
      try {
        const now = deps.now ? deps.now() : new Date();
        const today = dateInTimezone(now, settings.timezone ?? defaultTimezone());
        const deep = settings.deepDays > 0 && lastDeepDate !== today;
        const days = deep ? settings.deepDays : settings.days;
        await deps.sync({ days, signal: abortController.signal });
        // Mark the deep pass done only AFTER it succeeded — a failed
        // deep pass retries on the next tick instead of silently
        // waiting for tomorrow (CLAUDE.md rule 25's "confirm before
        // consuming the one-shot" shape).
        if (deep) lastDeepDate = today;
        deps.log.info(
          `wearables auto-sync: refreshed ${days}-day window${deep ? " (daily deep pass)" : ""}`,
        );
      } catch (err) {
        // An abort raised by stop() is intentional shutdown, not a
        // failure — warning about it would be noise in every clean
        // shutdown log.
        if (!stopped) {
          deps.log.warn(
            `wearables auto-sync failed: ${describeErrorForOperator(err)} — retrying on the next tick`,
          );
        }
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    await run;
  };

  const timer = setInterval(() => {
    void tick();
  }, settings.intervalMinutes * 60_000);
  timer.unref?.();

  return {
    tick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      abortController.abort();
      // tick() never rejects (all paths caught), so this only waits.
      if (inFlight) await inFlight;
    },
  };
}
