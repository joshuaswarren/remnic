import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingsBuildScheduler } from "./build-scheduler.js";

/** A build fn recording the days it was asked to build. */
function recorder(): { build: (date: string) => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  return { calls, build: async (date: string) => { calls.push(date); } };
}

test("coalesces a burst of requests for one day into a single build", async () => {
  const rec = recorder();
  const scheduler = new MeetingsBuildScheduler({ debounceMs: 10_000, build: rec.build });
  scheduler.requestBuild("2026-03-10");
  scheduler.requestBuild("2026-03-10");
  scheduler.requestBuild("2026-03-10");
  await scheduler.flush();
  assert.deepEqual(rec.calls, ["2026-03-10"], "the re-armed timer fires exactly once");
});

test("distinct days each build once", async () => {
  const rec = recorder();
  const scheduler = new MeetingsBuildScheduler({ debounceMs: 10_000, build: rec.build });
  scheduler.requestBuild("2026-03-10");
  scheduler.requestBuild("2026-03-11");
  await scheduler.flush();
  assert.deepEqual([...rec.calls].sort(), ["2026-03-10", "2026-03-11"]);
});

test("a build failure is isolated and routed to onError, never rejecting flush", async () => {
  const errors: Array<[string, string]> = [];
  const scheduler = new MeetingsBuildScheduler({
    debounceMs: 10_000,
    build: async (date) => {
      throw new Error(`boom ${date}`);
    },
    onError: (date, err) => errors.push([date, err instanceof Error ? err.message : String(err)]),
  });
  scheduler.requestBuild("2026-03-10");
  await scheduler.flush(); // must resolve despite the throw
  assert.deepEqual(errors, [["2026-03-10", "boom 2026-03-10"]]);
});

test("dispose cancels armed timers so no build runs, and later requests are no-ops", async () => {
  const rec = recorder();
  const scheduler = new MeetingsBuildScheduler({ debounceMs: 10_000, build: rec.build });
  scheduler.requestBuild("2026-03-10");
  scheduler.dispose();
  await scheduler.flush();
  assert.deepEqual(rec.calls, [], "a disposed scheduler builds nothing");
  scheduler.requestBuild("2026-03-11");
  await scheduler.flush();
  assert.deepEqual(rec.calls, [], "requestBuild after dispose is a no-op");
});
