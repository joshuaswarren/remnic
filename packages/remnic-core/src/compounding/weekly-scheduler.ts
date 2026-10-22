/**
 * In-process weekly compounding run for the standalone daemon.
 *
 * OpenClaw delegate mode registers only memory_search and memory_get, so a
 * gateway cron can no longer call `compounding_weekly_synthesize`. When both
 * compounding flags are on, the standalone daemon arms this runner after
 * orchestrator init. Embedded OpenClaw init does not.
 *
 * Each tick synthesizes the ISO week that most recently ended (previous week,
 * not the in-progress one) by calling `synthesizeWeekly`, which includes
 * calibration when that gate is on. The weekly markdown report is the durable
 * marker: a week whose report already exists is skipped, so a restart does not
 * write it twice. A daemon that was down at the Monday boundary still writes
 * that missed week on the next start. Older gaps are left alone — one missed
 * week, not a history backfill.
 *
 * The timer is unref'd. Startup fires one tick immediately; later ticks land
 * on the next Monday 00:00 UTC. A failed tick remembers that week and retries
 * it before the newly due week, including after the boundary. That memory is
 * process-local: a restart still keys off the report file.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";

import { resolveConsolidationCapabilities } from "../capabilities.js";
import { log as defaultLog } from "../logger.js";
import type { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { CompoundingEngine } from "./engine.js";
import { isIsoWeekId, msUntilNextIsoWeek, previousIsoWeekId } from "./iso-week.js";

export interface CompoundingWeeklyLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

type TimerHandle = { unref?: () => void };

export interface CompoundingWeeklySchedulerOptions {
  memoryDir: string;
  /** Full `synthesizeWeekly` path, including its calibration pass. */
  synthesizeWeekly: (weekId: string) => Promise<unknown>;
  now?: () => Date;
  reportExists?: (weekId: string) => Promise<boolean>;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  log?: CompoundingWeeklyLog;
}

export type CompoundingWeeklyTick =
  | { status: "synthesized" | "skipped" | "failed"; weekId: string }
  | { status: "stopped" | "coalesced"; weekId: null };

export interface CompoundingWeeklySchedulerHandle {
  /** Run one check now (startup catch-up and tests). */
  tick(): Promise<CompoundingWeeklyTick>;
  /** Resolve when no tick is in flight, including a coalesced follow-up. */
  whenIdle(): Promise<void>;
  /** Prevent later ticks and wait for the one already running. */
  stop(): Promise<void>;
}

export function compoundingWeeklyReportPath(memoryDir: string, weekId: string): string {
  if (!isIsoWeekId(weekId)) {
    throw new Error("compounding weekly cron: week id must be YYYY-Www");
  }
  return path.join(memoryDir, "compounding", "weekly", `${weekId}.md`);
}

async function defaultReportExists(memoryDir: string, weekId: string): Promise<boolean> {
  try {
    await lstat(compoundingWeeklyReportPath(memoryDir, weekId));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function startCompoundingWeeklyScheduler(
  options: CompoundingWeeklySchedulerOptions
): CompoundingWeeklySchedulerHandle {
  const now = options.now ?? (() => new Date());
  const logger = options.log ?? defaultLog;
  const reportExists = options.reportExists ?? ((weekId) => defaultReportExists(options.memoryDir, weekId));
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  let stopped = false;
  let pending = false;
  let inFlight: Promise<CompoundingWeeklyTick> | null = null;
  let timer: TimerHandle | null = null;
  let retryWeekId: string | null = null;

  const runWeek = async (weekId: string): Promise<CompoundingWeeklyTick> => {
    try {
      if (await reportExists(weekId)) {
        if (retryWeekId === weekId) retryWeekId = null;
        logger.debug(`compounding weekly cron: ${weekId} report exists, skipping`);
        return { status: "skipped", weekId };
      }
      await options.synthesizeWeekly(weekId);
      if (retryWeekId === weekId) retryWeekId = null;
      logger.info(`compounding weekly cron: synthesized ${weekId}`);
      return { status: "synthesized", weekId };
    } catch (error) {
      retryWeekId = weekId;
      const name = error instanceof Error ? error.name : "Error";
      logger.warn(`compounding weekly cron: ${weekId} failed (${name}) — retrying on the next tick`);
      return { status: "failed", weekId };
    }
  };

  const arm = (): void => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const delay = msUntilNextIsoWeek(now());
    timer = setTimer(() => {
      timer = null;
      if (stopped) return;
      arm();
      void request();
    }, delay);
    timer.unref?.();
  };

  const doTick = async (): Promise<CompoundingWeeklyTick> => {
    const due = previousIsoWeekId(now());
    const weekId = retryWeekId ?? due;
    const first = await runWeek(weekId);
    if (first.status === "failed" || weekId === due) return first;
    return runWeek(due);
  };

  const request = (): Promise<CompoundingWeeklyTick> => {
    if (stopped) return Promise.resolve({ status: "stopped", weekId: null });
    if (inFlight) {
      pending = true;
      return inFlight.then(() => ({ status: "coalesced" as const, weekId: null }));
    }
    const run = doTick().finally(() => {
      inFlight = null;
      if (!stopped && pending) {
        pending = false;
        void request();
      }
    });
    inFlight = run;
    return run;
  };

  arm();
  void request();

  return {
    tick: () => request(),
    async whenIdle() {
      while (inFlight) await inFlight;
    },
    async stop() {
      stopped = true;
      pending = false;
      if (timer) clearTimer(timer);
      timer = null;
      while (inFlight) await inFlight;
    },
  };
}

/**
 * Arm the daemon weekly run when both compounding flags are on.
 * Returns null when the run stays off or arming fails. The returned handle's
 * first tick is already in flight and includes calibration via synthesizeWeekly.
 */
export function createCompoundingWeeklyCron(deps: {
  config: PluginConfig;
  getStorage?: () => StorageManager | undefined;
}): CompoundingWeeklySchedulerHandle | null {
  const caps = resolveConsolidationCapabilities(deps.config);
  if (!caps.compounding || !caps.compoundingWeeklyCron) return null;
  try {
    const engine = new CompoundingEngine(deps.config, deps.getStorage?.());
    const handle = startCompoundingWeeklyScheduler({
      memoryDir: deps.config.memoryDir,
      synthesizeWeekly: (weekId) => engine.synthesizeWeekly({ weekId }),
    });
    defaultLog.info("compounding weekly cron armed");
    return handle;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    defaultLog.warn(`compounding weekly cron failed to arm (${name}) — non-fatal`);
    return null;
  }
}
