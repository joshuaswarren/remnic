/**
 * Daemon weekly compounding run: once per completed ISO week, skip when the
 * report exists, and catch up the missed week after a restart.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { initLogger, resetLogger } from "../logger.js";
import type { NamespaceCatalog } from "../namespaces/catalog.js";
import type { NamespaceSearchRouter } from "../namespaces/search.js";
import { MaintenanceScheduler } from "../orchestration/maintenance.js";
import type { SearchBackend } from "../search/port.js";
import { CompoundingEngine } from "./engine.js";
import { isIsoWeekId, isoWeekId, msUntilNextIsoWeek, previousIsoWeekId } from "./iso-week.js";
import {
  type CompoundingWeeklySchedulerOptions,
  compoundingWeeklyReportPath,
  startCompoundingWeeklyScheduler,
} from "./weekly-scheduler.js";

const QUIET = { info() {}, warn() {}, debug() {} };

function fixedClock(iso: string): () => Date {
  const value = new Date(iso);
  return () => new Date(value.getTime());
}

function fakeTimers() {
  const armed: Array<{ fn: () => void; ms: number; unrefd: boolean }> = [];
  const cleared: unknown[] = [];
  return {
    armed,
    cleared,
    setTimer: (fn: () => void, ms: number) => {
      const handle = {
        fn,
        ms,
        unrefd: false,
        unref() {
          this.unrefd = true;
        },
      };
      armed.push(handle);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      cleared.push(handle);
    },
  };
}

function startFor(memoryDir: string, overrides: Partial<CompoundingWeeklySchedulerOptions> & { now: () => Date }) {
  const timers = fakeTimers();
  const handle = startCompoundingWeeklyScheduler({
    memoryDir,
    synthesizeWeekly: async () => undefined,
    log: QUIET,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { handle, timers };
}

test("iso week ids follow the Thursday rule across the year boundary", () => {
  assert.equal(isoWeekId(new Date("2026-01-01T00:00:00.000Z")), "2026-W01");
  assert.equal(previousIsoWeekId(new Date("2026-01-01T00:00:00.000Z")), "2025-W52");
  assert.equal(isoWeekId(new Date("2026-01-05T00:00:00.000Z")), "2026-W02");
  assert.equal(previousIsoWeekId(new Date("2026-01-05T12:00:00.000Z")), "2026-W01");
  assert.equal(isIsoWeekId("2026-W01"), true);
  assert.equal(isIsoWeekId("2026-W00"), false);
  assert.equal(isIsoWeekId("2026-W54"), false);
  assert.equal(isIsoWeekId("../W01"), false);
  assert.equal(isIsoWeekId("2026-W1"), false);
});

test("next Monday delay is one week when already on the Monday boundary", () => {
  const monday = new Date("2026-03-16T00:00:00.000Z");
  assert.equal(monday.getUTCDay(), 1);
  assert.equal(msUntilNextIsoWeek(monday), 7 * 86_400_000);
  const sundayEvening = new Date("2026-03-15T23:00:00.000Z");
  assert.equal(msUntilNextIsoWeek(sundayEvening), 60 * 60 * 1000);
});

test("startup synthesizes the completed ISO week and arms an unref'd boundary timer", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  const now = fixedClock("2026-03-18T12:00:00.000Z");
  const calls: string[] = [];
  try {
    const { handle, timers } = startFor(memoryDir, {
      now,
      synthesizeWeekly: async (weekId) => {
        calls.push(weekId);
      },
    });
    await handle.whenIdle();
    assert.deepEqual(calls, [previousIsoWeekId(now())]);
    assert.notEqual(calls[0], isoWeekId(now()));
    assert.equal(timers.armed.length, 1);
    assert.equal(timers.armed[0]?.unrefd, true);
    assert.equal(timers.armed[0]?.ms, msUntilNextIsoWeek(now()));
    await handle.stop();
    assert.equal(timers.cleared.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a week whose report already exists is skipped, including after a restart", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  const now = fixedClock("2026-03-18T12:00:00.000Z");
  const weekId = previousIsoWeekId(now());
  const calls: string[] = [];
  const synthesizeWeekly = async (id: string) => {
    calls.push(id);
    const report = compoundingWeeklyReportPath(memoryDir, id);
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, `# ${id}\n`, "utf8");
  };
  try {
    const first = startFor(memoryDir, { now, synthesizeWeekly });
    await first.handle.whenIdle();
    await first.handle.stop();
    assert.deepEqual(calls, [weekId]);

    const restarted = startFor(memoryDir, { now, synthesizeWeekly });
    await restarted.handle.whenIdle();
    await restarted.handle.stop();
    assert.deepEqual(calls, [weekId], "restart must not synthesize a week that already has a report");
    assert.equal(await readFile(compoundingWeeklyReportPath(memoryDir, weekId), "utf8"), `# ${weekId}\n`);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a missed week is caught up once and older gaps are not backfilled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  let now = new Date("2026-04-08T12:00:00.000Z");
  const calls: string[] = [];
  const synthesizeWeekly = async (id: string) => {
    calls.push(id);
    const report = compoundingWeeklyReportPath(memoryDir, id);
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, `# ${id}\n`, "utf8");
  };
  try {
    const first = startFor(memoryDir, { now: () => now, synthesizeWeekly });
    await first.handle.whenIdle();
    await first.handle.stop();

    const completed = previousIsoWeekId(now);
    now = new Date(now.getTime() + 14 * 86_400_000);
    const missed = previousIsoWeekId(new Date(now.getTime() - 7 * 86_400_000));
    const due = previousIsoWeekId(now);
    assert.notEqual(completed, missed);
    assert.notEqual(missed, due);

    const restarted = startFor(memoryDir, { now: () => now, synthesizeWeekly });
    await restarted.handle.whenIdle();
    await restarted.handle.stop();
    assert.deepEqual(calls, [completed, due]);
    assert.equal(calls.includes(missed), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed tick retries on the next boundary and a stopped timer does not run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  const now = fixedClock("2026-03-18T12:00:00.000Z");
  let fail = true;
  const calls: string[] = [];
  try {
    const { handle, timers } = startFor(memoryDir, {
      now,
      synthesizeWeekly: async (weekId) => {
        calls.push(weekId);
        if (fail) throw new Error("synthesis unavailable");
      },
    });
    await handle.whenIdle();
    assert.equal(calls.length, 1);
    fail = false;
    timers.armed[0]?.fn();
    await handle.whenIdle();
    assert.equal(calls.length, 2);
    await handle.stop();
    const afterStop = calls.length;
    timers.armed[0]?.fn();
    await handle.whenIdle();
    assert.equal(calls.length, afterStop);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed week is retried after the ISO boundary, before the newly due week", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  let now = new Date("2026-03-18T12:00:00.000Z");
  let fail = true;
  const calls: string[] = [];
  try {
    const { handle, timers } = startFor(memoryDir, {
      now: () => now,
      synthesizeWeekly: async (weekId) => {
        calls.push(weekId);
        if (fail) throw new Error("synthesis unavailable");
      },
    });
    await handle.whenIdle();
    const failed = previousIsoWeekId(now);
    now = new Date(now.getTime() + 7 * 86_400_000);
    const due = previousIsoWeekId(now);
    assert.notEqual(failed, due);
    fail = false;
    timers.armed.at(-1)?.fn();
    await handle.whenIdle();
    assert.deepEqual(calls, [failed, failed, due]);
    await handle.stop();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a later artifact failure does not leave the weekly report marker", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  const weekId = previousIsoWeekId(new Date("2026-03-18T12:00:00.000Z"));
  try {
    await mkdir(path.join(memoryDir, "compounding", "mistakes.json"), { recursive: true });
    const engine = new CompoundingEngine(parseConfig({ memoryDir, qmdEnabled: false, compoundingEnabled: true }));
    await assert.rejects(() => engine.synthesizeWeekly({ weekId }));
    await assert.rejects(
      () => stat(compoundingWeeklyReportPath(memoryDir, weekId)),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an overlapping tick coalesces into one follow-up run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  try {
    const { handle } = startFor(memoryDir, {
      now: fixedClock("2026-03-18T12:00:00.000Z"),
      synthesizeWeekly: async () => {
        calls += 1;
        if (calls === 1) await gate;
      },
    });
    const extra = handle.tick();
    release?.();
    await extra;
    await handle.whenIdle();
    assert.equal(calls, 2);
    await handle.stop();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

function maintenanceScheduler(
  memoryDir: string,
  flags: { compounding: boolean; weekly: boolean }
): MaintenanceScheduler {
  const config = parseConfig({
    memoryDir,
    qmdEnabled: false,
    compoundingEnabled: flags.compounding,
    compoundingWeeklyCronEnabled: flags.weekly,
    calibrationEnabled: true,
  });
  return new MaintenanceScheduler({
    config,
    getQmd: () => ({ isAvailable: () => false }) as unknown as SearchBackend,
    namespaceSearchRouter: {} as unknown as NamespaceSearchRouter,
    namespaceCatalog: {} as unknown as NamespaceCatalog,
  });
}

test("compoundingWeeklyCronEnabled defaults off and the daemon does not arm the run", async () => {
  assert.equal(parseConfig({}).compoundingWeeklyCronEnabled, false);
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  try {
    for (const flags of [
      { compounding: false, weekly: false },
      { compounding: true, weekly: false },
      { compounding: false, weekly: true },
    ]) {
      const scheduler = maintenanceScheduler(memoryDir, flags);
      try {
        assert.equal(scheduler.armCompoundingWeeklyCron(), false);
      } finally {
        await scheduler.dispose();
      }
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("the daemon arms synthesizeWeekly, including its calibration pass, for the completed week", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-cron-"));
  const weekId = previousIsoWeekId(new Date());
  const original = CompoundingEngine.prototype.synthesizeWeekly;
  const calls: Array<string | undefined> = [];
  const logs: string[] = [];
  CompoundingEngine.prototype.synthesizeWeekly = async function (opts) {
    calls.push(opts?.weekId);
    return original.call(this, opts);
  };
  initLogger(
    {
      info(msg) {
        logs.push(String(msg));
      },
      warn(msg) {
        logs.push(String(msg));
      },
      error(msg) {
        logs.push(String(msg));
      },
      debug(msg) {
        logs.push(String(msg));
      },
    },
    true,
    { timestamps: false }
  );
  const scheduler = maintenanceScheduler(memoryDir, { compounding: true, weekly: true });
  try {
    assert.equal(scheduler.armCompoundingWeeklyCron(), true);
    assert.equal(scheduler.armCompoundingWeeklyCron(), true, "arming twice must not start a second runner");
    await scheduler.dispose();
    assert.deepEqual(calls, [weekId]);
    const report = await readFile(compoundingWeeklyReportPath(memoryDir, weekId), "utf8");
    assert.equal(report.includes(weekId), true);
    assert.equal(
      logs.some((line) => line.includes("weekly synthesis produced")),
      true,
      "synthesizeWeekly must run the calibration pass"
    );
  } finally {
    CompoundingEngine.prototype.synthesizeWeekly = original;
    resetLogger();
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
