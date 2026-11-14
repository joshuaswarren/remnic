import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureProcessor } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import { type AxSnapshot, NativeHelper, type WindowContext } from "./helper.js";
import { CaptureScheduler, type SchedulerClock } from "./scheduler.js";
import { Spool } from "./spool.js";

function makeClock(): SchedulerClock & { nowMs: number; fire(): void } {
  let fn: (() => void) | null = null;
  const clock = {
    nowMs: 0,
    now() {
      return clock.nowMs;
    },
    setInterval(f: () => void) {
      fn = f;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval() {},
    fire() {
      fn?.();
    },
  };
  return clock;
}

function contextOf(snap: AxSnapshot): WindowContext {
  const { tree: _tree, ...context } = snap;
  return context;
}

interface HelperState {
  snap: AxSnapshot;
  ocr: string;
}

class StubHelper extends NativeHelper {
  constructor(private readonly state: HelperState) {
    super("stub");
  }
  override async windowContext(): Promise<WindowContext> {
    return contextOf(this.state.snap);
  }
  override async axSnapshot(): Promise<AxSnapshot> {
    return this.state.snap;
  }
  override async ocrWindow(): Promise<string> {
    return this.state.ocr;
  }
}

function fakeHelper(state: HelperState): NativeHelper {
  return new StubHelper(state);
}

function axWindow(app: string, windowTitle: string, text: string): AxSnapshot {
  return {
    app,
    windowTitle,
    tree: { role: "AXWindow", children: [{ role: "AXStaticText", value: text }] },
  };
}

test("the scheduler's window facts carry the configured node limit, so a legacy helper's fallback tree stays bounded", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 100, idleFallbackSeconds: 1, maxNodes: 77 };
  const spool = new Spool(":memory:");
  const seen: { frontmost?: boolean; maxNodes?: number }[] = [];
  const helper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(opts: { frontmost?: boolean; maxNodes?: number } = {}): Promise<WindowContext> {
      seen.push(opts);
      return contextOf(axWindow("kitty", "shell", "page text"));
    }
    override async ocrWindow(): Promise<string> {
      return "";
    }
  })();
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, new CaptureProcessor(config), spool, config, {}, clock);
  await scheduler.tick();
  await scheduler.tick();
  assert.ok(seen.length >= 2);
  for (const opts of seen) assert.deepEqual(opts, { frontmost: true, maxNodes: 77 });
});

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
  const helper: NativeHelper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(): Promise<WindowContext> {
      throw new Error("helper down");
    }
  })();
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, processor, spool, config, { onError: (e) => errors.push(e) }, clock);

  await scheduler.tick();
  assert.equal(errors.length, 1);
  assert.equal(spool.countSnapshots(), 0);

  spool.close();
});

test("stop() drains an in-flight tick before resolving", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 0, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const processor = new CaptureProcessor(config);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const helper: NativeHelper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(): Promise<WindowContext> {
      await gate;
      return contextOf(axWindow("Safari", "Docs", "text body here"));
    }
    override async axSnapshot(): Promise<AxSnapshot> {
      return axWindow("Safari", "Docs", "text body here");
    }
    override async ocrWindow(): Promise<string> {
      return "";
    }
  })();
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, processor, spool, config, {}, clock);
  scheduler.start();
  clock.fire(); // begins a tick that blocks on the gate

  let stopResolved = false;
  const stopping = scheduler.stop().then(() => {
    stopResolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopResolved, false, "stop() must await the in-flight tick");
  release();
  await stopping;
  assert.equal(stopResolved, true);
  spool.close();
});

test("idle fallback never preempts a change still inside its settle window", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 10000, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const processor = new CaptureProcessor(config);
  const state = { snap: axWindow("Safari", "Docs", "settle text body"), ocr: "" };
  const clock = makeClock();
  const scheduler = new CaptureScheduler(fakeHelper(state), processor, spool, config, {}, clock);
  clock.nowMs = 0;
  await scheduler.tick(); // change → pending
  clock.nowMs = 2000; // idle due (>=1000) but settle not (<10000)
  await scheduler.tick();
  assert.equal(spool.countSnapshots(), 0, "must not idle-capture a still-settling change");
  clock.nowMs = 10001;
  await scheduler.tick();
  assert.equal(spool.countSnapshots(), 1);
  spool.close();
});

test("a deny-listed window is never OCR'd (deny preflight)", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 0, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const processor = new CaptureProcessor(config);
  let ocrCalls = 0;
  const helper: NativeHelper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(): Promise<WindowContext> {
      return contextOf({ app: "1Password 8", windowTitle: "Vault", tree: { role: "AXWindow" } });
    }
    override async axSnapshot(): Promise<AxSnapshot> {
      return { app: "1Password 8", windowTitle: "Vault", tree: { role: "AXWindow" } };
    }
    override async ocrWindow(): Promise<string> {
      ocrCalls += 1;
      return "secret";
    }
  })();
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, processor, spool, config, {}, clock);
  clock.nowMs = 0;
  await scheduler.tick(); // change
  clock.nowMs = 10;
  await scheduler.tick(); // settle(0) → denied, no OCR
  assert.equal(ocrCalls, 0, "must not OCR a deny-listed window");
  assert.equal(spool.countSnapshots(), 0);
  spool.close();
});

function countingHelper(snap: AxSnapshot) {
  let reads = 0;
  const helper: NativeHelper = new (class extends NativeHelper {
    constructor() {
      super("stub");
    }
    override async windowContext(): Promise<WindowContext> {
      return contextOf(snap);
    }
    override async axSnapshot(): Promise<AxSnapshot> {
      reads += 1;
      return snap;
    }
    override async ocrWindow(): Promise<string> {
      return "";
    }
  })();
  return { helper, treeReads: () => reads };
}

test("the tree is read once, when the window has settled, not on every poll", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 100, idleFallbackSeconds: 1000 };
  const spool = new Spool(":memory:");
  const { helper, treeReads } = countingHelper(axWindow("Safari", "Docs", "hello visible page text here"));
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, new CaptureProcessor(config), spool, config, {}, clock);
  for (const at of [0, 20, 60]) {
    clock.nowMs = at;
    await scheduler.tick();
  }
  assert.equal(treeReads(), 0, "change detection must not read window content");
  clock.nowMs = 200;
  await scheduler.tick();
  assert.equal(treeReads(), 1);
  assert.equal(spool.countSnapshots(), 1);
  spool.close();
});

test("the tree of a deny-listed window is never read, on any poll", async () => {
  const config = { ...defaultDaemonConfig(), settleMs: 0, idleFallbackSeconds: 1 };
  const spool = new Spool(":memory:");
  const { helper, treeReads } = countingHelper(axWindow("1Password 8", "Vault", "secret vault contents"));
  const clock = makeClock();
  const scheduler = new CaptureScheduler(helper, new CaptureProcessor(config), spool, config, {}, clock);
  for (const at of [0, 10, 2000, 4000]) {
    clock.nowMs = at;
    await scheduler.tick();
  }
  assert.equal(treeReads(), 0);
  assert.equal(spool.countSnapshots(), 0);
  spool.close();
});
