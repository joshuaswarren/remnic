import assert from "node:assert/strict";
import test from "node:test";

import { startWearablesAutoSync } from "./auto-sync.js";

function makeDeps(overrides: { failTimes?: number } = {}) {
  const calls: Array<{ days: number }> = [];
  const warnings: string[] = [];
  let remainingFailures = overrides.failTimes ?? 0;
  let nowIso = "2026-06-12T10:00:00.000Z";
  return {
    calls,
    warnings,
    setNow(iso: string) {
      nowIso = iso;
    },
    deps: {
      sync: async (options: { days: number }) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("provider down");
        }
        calls.push(options);
        return [];
      },
      log: {
        info: () => {},
        warn: (message: string) => {
          warnings.push(message);
        },
      },
      now: () => new Date(nowIso),
    },
  };
}

const SETTINGS = {
  intervalMinutes: 15,
  days: 2,
  deepDays: 7,
  timezone: "UTC",
};

test("first tick runs the deep window, same-day ticks run the shallow window", async () => {
  const { calls, deps } = makeDeps();
  const handle = startWearablesAutoSync(SETTINGS, deps);
  try {
    await handle.tick();
    await handle.tick();
    await handle.tick();
    assert.deepEqual(
      calls.map((call) => call.days),
      [7, 2, 2],
      "deep once, then shallow for the rest of the day",
    );
  } finally {
    handle.stop();
  }
});

test("a new local day triggers the deep pass again", async () => {
  const { calls, deps, setNow } = makeDeps();
  const handle = startWearablesAutoSync(SETTINGS, deps);
  try {
    await handle.tick();
    await handle.tick();
    setNow("2026-06-13T00:05:00.000Z");
    await handle.tick();
    await handle.tick();
    assert.deepEqual(
      calls.map((call) => call.days),
      [7, 2, 7, 2],
    );
  } finally {
    handle.stop();
  }
});

test("a failed deep pass retries deep on the next tick, never throws", async () => {
  const { calls, warnings, deps } = makeDeps({ failTimes: 1 });
  const handle = startWearablesAutoSync(SETTINGS, deps);
  try {
    await handle.tick();
    assert.equal(calls.length, 0, "first tick failed");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /retrying on the next tick/);
    await handle.tick();
    assert.deepEqual(
      calls.map((call) => call.days),
      [7],
      "deep window retries — a failure must not consume the daily deep slot",
    );
  } finally {
    handle.stop();
  }
});

test("deepDays 0 disables the deep pass entirely", async () => {
  const { calls, deps } = makeDeps();
  const handle = startWearablesAutoSync({ ...SETTINGS, deepDays: 0 }, deps);
  try {
    await handle.tick();
    await handle.tick();
    assert.deepEqual(
      calls.map((call) => call.days),
      [2, 2],
    );
  } finally {
    handle.stop();
  }
});

test("overlapping ticks are skipped, not stacked", async () => {
  const calls: Array<{ days: number }> = [];
  let release: (() => void) | null = null;
  const handle = startWearablesAutoSync(SETTINGS, {
    sync: async (options) => {
      calls.push(options);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    },
    log: { info: () => {}, warn: () => {} },
    now: () => new Date("2026-06-12T10:00:00.000Z"),
  });
  try {
    const first = handle.tick();
    const second = handle.tick();
    await second;
    assert.equal(calls.length, 1, "second tick is a no-op while the first runs");
    release!();
    await first;
  } finally {
    handle.stop();
  }
});

test("stop() prevents any further ticks", async () => {
  const { calls, deps } = makeDeps();
  const handle = startWearablesAutoSync(SETTINGS, deps);
  await handle.stop();
  await handle.tick();
  assert.equal(calls.length, 0);
});

test("stop() aborts the in-flight sync and awaits its settlement", async () => {
  const warnings: string[] = [];
  let sawSignal: AbortSignal | undefined;
  let syncSettled = false;
  const handle = startWearablesAutoSync(SETTINGS, {
    sync: async (options) => {
      sawSignal = options.signal;
      // Hang until the shutdown abort arrives, like a slow provider.
      await new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }).finally(() => {
        syncSettled = true;
      });
    },
    log: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    now: () => new Date("2026-06-12T10:00:00.000Z"),
  });
  const inFlight = handle.tick();
  assert.ok(sawSignal instanceof AbortSignal, "sync receives the abort signal");
  await handle.stop();
  assert.equal(syncSettled, true, "stop() resolves only after the tick settled");
  assert.equal(
    warnings.length,
    0,
    "an abort raised by shutdown is intentional, never warned",
  );
  await inFlight;
});
