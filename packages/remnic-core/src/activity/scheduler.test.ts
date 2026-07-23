import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTIVITY_SYNC_DEFAULT_INTERVAL_MS, ActivitySyncScheduler } from "./scheduler.js";
import { runActivitySyncOnce, type ActivitySyncRunSummary } from "./runner.js";
import { ActivityStore } from "./store.js";
import { activityCursorKey } from "./pipeline.js";
import { defaultActivityConfig } from "./config.js";
import type { ActivityConfig, ActivitySnapshot, ActivitySourceClient } from "./types.js";

/** A hand-driven timer: records armed callbacks + intervals, fires on demand. */
function fakeTimer(): {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: unknown) => void;
  armed: Array<{ fn: () => void; ms: number }>;
  cleared: number;
} {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  let cleared = 0;
  return {
    armed,
    get cleared() {
      return cleared;
    },
    setTimer(fn, ms) {
      armed.push({ fn, ms });
      return armed.length;
    },
    clearTimer() {
      cleared += 1;
    },
  };
}

/** Drain the microtask queue so a fired tick's async invoke chain settles. */
function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

const SUMMARY: ActivitySyncRunSummary = {
  ranAt: "2026-07-22T18:00:00.000Z",
  enabled: true,
  ranCount: 1,
  errorCount: 0,
  reindexErrorCount: 0,
  totalInserted: 0,
  results: [],
};

function enabledConfig(): ActivityConfig {
  return {
    ...defaultActivityConfig(),
    enabled: true,
    timezone: "UTC",
    syncDays: 1,
    autoSyncIntervalMinutes: 15,
    sources: [{ machineLabel: "workstation-a", baseUrl: "http://127.0.0.1:8760" }],
  };
}

function disabledConfig(): ActivityConfig {
  return {
    ...defaultActivityConfig(),
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    autoSyncIntervalMinutes: 15,
    sources: [{ machineLabel: "workstation-a", baseUrl: "http://127.0.0.1:8760" }],
  };
}

test("default-off: start registers no timer and never invokes", async () => {
  const timer = fakeTimer();
  let calls = 0;
  const scheduler = new ActivitySyncScheduler({
    config: disabledConfig(),
    memoryDir: "/tmp/unused-activity-scheduler",
    invoke: async () => {
      calls += 1;
      return SUMMARY;
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  const registration = scheduler.start();

  assert.equal(registration.registered, false);
  assert.equal(registration.intervalMs, ACTIVITY_SYNC_DEFAULT_INTERVAL_MS);
  assert.equal(timer.armed.length, 0, "no timer armed while disabled");
  await flush();
  assert.equal(calls, 0, "disabled scheduler never invokes the runner");
});

test("enabled: registers a periodic timer that invokes the runner on cadence", async () => {
  const timer = fakeTimer();
  const summaries: ActivitySyncRunSummary[] = [];
  let calls = 0;
  const scheduler = new ActivitySyncScheduler({
    config: enabledConfig(),
    memoryDir: "/tmp/unused-activity-scheduler",
    invoke: async () => {
      calls += 1;
      return SUMMARY;
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onRun: (summary) => summaries.push(summary),
  });

  const registration = scheduler.start();
  assert.equal(registration.registered, true);
  assert.equal(registration.intervalMs, ACTIVITY_SYNC_DEFAULT_INTERVAL_MS);
  assert.equal(timer.armed.length, 1, "exactly one periodic timer armed");
  assert.equal(timer.armed[0].ms, ACTIVITY_SYNC_DEFAULT_INTERVAL_MS);

  // Each cadence tick invokes one durable sync pass.
  for (let i = 0; i < 3; i++) {
    timer.armed[0].fn();
    await flush();
  }
  assert.equal(calls, 3, "three ticks -> three sync invocations");
  assert.equal(summaries.length, 3, "each run's summary is surfaced");
});

test("cadence override is honored; default applies when omitted", () => {
  const timer = fakeTimer();
  new ActivitySyncScheduler({
    config: enabledConfig(),
    memoryDir: "/tmp/unused",
    intervalMs: 1_000,
    invoke: async () => SUMMARY,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  }).start();
  assert.equal(timer.armed[0].ms, 1_000, "explicit cadence used");

  // Issue #1899 contracts activity.autoSyncIntervalMinutes default 15, i.e. a
  // 15-minute effective cadence — not connectors' 5-minute poll.
  assert.equal(ACTIVITY_SYNC_DEFAULT_INTERVAL_MS, 15 * 60_000, "default cadence is 15 minutes (#1899)");
  const defaulted = fakeTimer();
  new ActivitySyncScheduler({
    config: enabledConfig(),
    memoryDir: "/tmp/unused",
    invoke: async () => SUMMARY,
    setTimer: defaulted.setTimer,
    clearTimer: defaulted.clearTimer,
  }).start();
  assert.equal(defaulted.armed[0].ms, 900_000, "omitted cadence uses the 15-minute default");
});

test("stop cancels the timer so no later tick invokes", async () => {
  const timer = fakeTimer();
  let calls = 0;
  const scheduler = new ActivitySyncScheduler({
    config: enabledConfig(),
    memoryDir: "/tmp/unused-activity-scheduler",
    invoke: async () => {
      calls += 1;
      return SUMMARY;
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  scheduler.start();
  timer.armed[0].fn();
  await flush();
  assert.equal(calls, 1);

  await scheduler.stop();
  assert.equal(timer.cleared, 1, "stop cancels the underlying timer");

  // A stray callback firing after stop must not invoke (latched-stop guard).
  timer.armed[0].fn();
  await flush();
  assert.equal(calls, 1, "no invocation after stop");

  // Restart after stop is a no-op: a stopped scheduler stays stopped.
  const restart = scheduler.start();
  assert.equal(restart.registered, false);
  assert.equal(timer.armed.length, 1, "no new timer armed after stop");
});

test("overlapping ticks do not stack: a slow sync blocks the next tick", async () => {
  const timer = fakeTimer();
  let calls = 0;
  let releaseFirst: () => void = () => {};
  const scheduler = new ActivitySyncScheduler({
    config: enabledConfig(),
    memoryDir: "/tmp/unused-activity-scheduler",
    invoke: () => {
      calls += 1;
      const { promise, resolve } = Promise.withResolvers<ActivitySyncRunSummary>();
      releaseFirst = () => resolve(SUMMARY);
      return promise;
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  scheduler.start();
  timer.armed[0].fn(); // starts a sync that stays in-flight
  await flush();
  timer.armed[0].fn(); // second tick while the first is unresolved
  await flush();
  assert.equal(calls, 1, "the in-flight guard drops the overlapping tick");

  releaseFirst();
  await flush();
  // Once the first settles, a later tick runs again.
  timer.armed[0].fn();
  await flush();
  assert.equal(calls, 2, "a tick after the sync settles invokes again");
});

test("parser -> scheduler -> durable sync: a tick performs a real durable sync", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-scheduler-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const snapshot: ActivitySnapshot = {
      machine: "wire-label",
      capturedAtUtc: "2026-07-22T14:00:00.000Z",
      app: "Browser",
      windowTitle: "Example",
      text: "synthetic snapshot",
      textSource: "ax",
      contentHash: "hash-1",
    };
    const client: ActivitySourceClient = {
      machineLabel: "workstation-a",
      async verify() {
        return { ok: true };
      },
      async fetchSnapshots() {
        return { snapshots: [snapshot], nextCursor: null };
      },
    };

    const timer = fakeTimer();
    const scheduler = new ActivitySyncScheduler({
      config: enabledConfig(),
      memoryDir,
      // Real durable runner, fixture daemon + shared store — the scheduler
      // drives the same code path the default invoke uses.
      invoke: (signal) =>
        runActivitySyncOnce({
          config: enabledConfig(),
          memoryDir,
          store,
          now: new Date("2026-07-22T18:00:00.000Z"),
          signal,
          createSourceClient: () => client,
        }),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    scheduler.start();
    timer.armed[0].fn();
    await flush();

    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), null, "cursor advanced by the durable sync");
    const rows = store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z");
    assert.equal(rows.length, 1, "the tick persisted the snapshot durably");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("stop aborts an in-flight tick and drains before resolving", async () => {
  const timer = fakeTimer();
  let observedSignal: AbortSignal | undefined;
  let unwound = false;
  const scheduler = new ActivitySyncScheduler({
    config: enabledConfig(),
    memoryDir: "/tmp/unused-activity-scheduler",
    invoke: (signal) =>
      new Promise<ActivitySyncRunSummary>((_resolve, reject) => {
        observedSignal = signal;
        signal?.addEventListener("abort", () => {
          unwound = true;
          reject(new Error("aborted"));
        });
      }),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onError: () => {}, // swallow the abort rejection so the drain resolves
  });

  scheduler.start();
  timer.armed[0].fn(); // launch a sync that stays in-flight until aborted
  await flush();
  assert.ok(observedSignal, "tick threads an abort signal into invoke");
  assert.equal(observedSignal?.aborted, false, "not aborted while running");

  await scheduler.stop();
  assert.equal(observedSignal?.aborted, true, "stop aborts the in-flight tick");
  assert.equal(unwound, true, "stop waited for the aborted sync to unwind");
});
