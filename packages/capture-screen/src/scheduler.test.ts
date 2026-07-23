import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import type { AxSnapshot, NativeHelper } from "./helper.js";
import { CaptureScheduler, type SchedulerClock } from "./scheduler.js";
import { Spool } from "./spool.js";

function makeClock(): SchedulerClock & { nowMs: number } {
  const clock = {
    nowMs: 0,
    now() {
      return clock.nowMs;
    },
    setInterval() {
      return 0 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval() {},
  };
  return clock;
}

function fakeHelper(state: { snap: AxSnapshot; ocr: string }): NativeHelper {
  return {
    axSnapshot: async () => state.snap,
    ocrWindow: async () => state.ocr,
  } as unknown as NativeHelper;
}

function axWindow(app: string, windowTitle: string, text: string): AxSnapshot {
  return {
    app,
    windowTitle,
    tree: { role: "AXWindow", children: [{ role: "AXStaticText", value: text }] },
  };
}

test("scheduler stores on change+settle, dedups idle re-samples, captures new windows", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 100, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const processor = new CaptureProcessor(config);
  const state = { snap: axWindow("Safari", "Docs", "hello visible page text here"), ocr: "" };
  const clock = makeClock();
  const scheduler = new CaptureScheduler(fakeHelper(state), processor, spool, config, {}, clock);

  // A foreground change opens a settle window — nothing stored yet.
  clock.nowMs = 0;
  await scheduler.tick();
  assert.equal(spool.countSnapshots(), 0);
  clock.nowMs = 50; // still within settleMs
  await scheduler.tick();
  assert.equal(spool.countSnapshots(), 0);
  // Settled → the snapshot is stored.
  clock.nowMs = 200;
  await scheduler.tick();
  assert.equal(spool.countSnapshots(), 1);

  // Idle re-sample of the identical window dedups (no new row).
  clock.nowMs = 200 + 1000 + 5; // past idleFallbackSeconds
  await scheduler.tick();
  assert.equal(spool.countSnapshots(), 1);

  // A new (non-terminal) window → change → settle → a second row.
  state.snap = axWindow("Notes", "Meeting", "totally different meeting notes body");
  clock.nowMs += 10;
  await scheduler.tick(); // change
  clock.nowMs += 200;
  await scheduler.tick(); // settle → store
  assert.equal(spool.countSnapshots(), 2);

  spool.close();
});

test("scheduler never stores a deny-listed window", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 0, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const processor = new CaptureProcessor(config);
  // 1Password is a built-in deny default (see denylist.ts).
  const state = { snap: axWindow("1Password 8", "Vault", "secret vault contents"), ocr: "" };
  const clock = makeClock();
  const scheduler = new CaptureScheduler(fakeHelper(state), processor, spool, config, {}, clock);

  clock.nowMs = 0;
  await scheduler.tick(); // change
  clock.nowMs = 10;
  await scheduler.tick(); // settle(0) → processed → denied, not stored
  assert.equal(spool.countSnapshots(), 0);

  spool.close();
});

test("scheduler surfaces helper errors via onError and keeps running", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 0, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const processor = new CaptureProcessor(config);
  const errors: unknown[] = [];
  const helper = { axSnapshot: async () => { throw new Error("helper down"); } } as unknown as NativeHelper;
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, processor, spool, config, { onError: (e) => errors.push(e) }, clock);

  await scheduler.tick();
  assert.equal(errors.length, 1);
  assert.equal(spool.countSnapshots(), 0);

  spool.close();
});
