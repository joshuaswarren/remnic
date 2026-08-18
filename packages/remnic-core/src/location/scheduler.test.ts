/**
 * Location auto-sync scheduler regression (issue #2047): the maintenance
 * scheduler arms this only when enabled; here we pin the timer contract —
 * ticks run the shared sync runner, overlap is skipped not queued, and stop
 * cancels + drains.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseLocationConfig } from "./config.js";
import { startLocationAutoSync } from "./scheduler.js";
import type { LocationSyncRuns } from "./surfaces.js";

function fakeTimer() {
  const armed: Array<{ fn: () => void; unrefd: boolean }> = [];
  const cleared: unknown[] = [];
  return {
    armed,
    cleared,
    setInterval: (fn: () => void, _ms: number) => {
      const handle = { fn, unrefd: false, unref() { this.unrefd = true; } };
      armed.push(handle);
      return handle;
    },
    clearInterval: (handle: unknown) => cleared.push(handle),
  };
}

const CONFIG = parseLocationConfig({ enabled: true, sources: [{ id: "reitti" }] });
const RUNS: LocationSyncRuns = [{ date: "2026-08-16", results: [] }];

test("start arms one unref'd periodic timer whose tick runs the shared sync", async () => {
  const timer = fakeTimer();
  const syncs: Array<{ config: unknown; memoryDir: string }> = [];
  const infos: string[] = [];
  const handle = startLocationAutoSync(
    { config: CONFIG, memoryDir: "/tmp/unused-location", setInterval: timer.setInterval, clearInterval: timer.clearInterval },
    {
      sync: async (deps) => {
        syncs.push(deps);
        return RUNS;
      },
      log: { info: (m) => infos.push(m), warn: (m) => infos.push(m) },
    },
  );
  assert.equal(timer.armed.length, 1);
  assert.equal(timer.armed[0]?.unrefd, true, "one-shot CLI hosts must exit naturally");

  timer.armed[0]?.fn();
  { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0]?.memoryDir, "/tmp/unused-location");
  assert.equal(syncs[0]?.config, CONFIG);

  // First-run hook: tick() invokes the runner directly.
  await handle.tick();
  assert.equal(syncs.length, 2);

  await handle.stop();
  assert.equal(timer.cleared.length, 1);
});

test("an overlapping tick is skipped, not queued; failures warn and retry next tick", async () => {
  const timer = fakeTimer();
  let calls = 0;
  let failFirst = true;
  const warns: string[] = [];
  const handle = startLocationAutoSync(
    { config: CONFIG, memoryDir: "/tmp/unused", setInterval: timer.setInterval, clearInterval: timer.clearInterval },
    {
      sync: async () => {
        calls += 1;
        if (failFirst) {
          failFirst = false;
          throw new Error("ReittiApiError");
        }
        return RUNS;
      },
      log: { info: () => {}, warn: (m) => warns.push(m) },
    },
  );
  timer.armed[0]?.fn(); // failing tick
  timer.armed[0]?.fn(); // second tick while the first is still in flight
  { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
  assert.equal(calls, 1, "in-flight tick swallows the overlap");
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /location auto-sync failed: Error/);

  timer.armed[0]?.fn(); // recovers on the next tick
  { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
  assert.equal(calls, 2);

  await handle.stop();
});

test("a provider failure surfaces as a warn (per-source failed status), not a throw", async () => {
  const timer = fakeTimer();
  const warns: string[] = [];
  const handle = startLocationAutoSync(
    { config: CONFIG, memoryDir: "/tmp/unused", setInterval: timer.setInterval, clearInterval: timer.clearInterval },
    {
      sync: async () => [
        { date: "2026-08-16", results: [{ sourceId: "reitti", status: "failed", fetched: 0, dayWritten: false, stateSaved: false }] },
      ],
      log: { info: () => {}, warn: (m) => warns.push(m) },
    },
  );
  timer.armed[0]?.fn();
  { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
  assert.deepEqual(warns, ["location auto-sync: one or more sources failed — retrying on the next tick"]);
  await handle.stop();
});
