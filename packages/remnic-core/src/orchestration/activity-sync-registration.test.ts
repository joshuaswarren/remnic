import assert from "node:assert/strict";
import test from "node:test";

import type { ActivitySyncRunSummary } from "../activity/runner.js";
import type { ActivitySyncSchedulerOptions } from "../activity/scheduler.js";
import {
  ActivitySyncRegistrar,
  type ActivitySyncRegistrarDeps,
  type ActivitySyncSchedulerLike,
} from "./activity-sync-registration.js";

class FakeScheduler implements ActivitySyncSchedulerLike {
  starts = 0;
  stops = 0;
  readonly options: ActivitySyncSchedulerOptions;
  constructor(options: ActivitySyncSchedulerOptions) {
    this.options = options;
  }
  start(): unknown {
    this.starts += 1;
    return { registered: true, intervalMs: this.options.intervalMs ?? 0 };
  }
  async stop(): Promise<void> {
    this.stops += 1;
  }
}

function makeDeps(overrides: Partial<ActivitySyncRegistrarDeps> = {}): {
  deps: ActivitySyncRegistrarDeps;
  created: FakeScheduler[];
  state: { retries: number };
} {
  const created: FakeScheduler[] = [];
  const state = { retries: 0 };
  const deps: ActivitySyncRegistrarDeps = {
    config: { enabled: true, timezone: "UTC", syncDays: 1, autoSyncIntervalMinutes: 15, sources: [] },
    memoryDir: "/tmp/remnic-activity-registrar",
    qmdCollection: "openclaw-engram",
    secureStoreEnabled: false,
    getQmd: () => ({ update: async () => undefined }),
    requestReindexRetry: () => {
      state.retries += 1;
    },
    createScheduler: (options) => {
      const s = new FakeScheduler(options);
      created.push(s);
      return s;
    },
    ...overrides,
  };
  return { deps, created, state };
}

test("register arms a scheduler on a live signal", async () => {
  const { deps, created } = makeDeps();
  const registrar = new ActivitySyncRegistrar(deps);
  await registrar.register(new AbortController().signal);
  assert.equal(created.length, 1, "exactly one scheduler is constructed");
  assert.equal(created[0]?.starts, 1, "the scheduler is started");
  assert.ok(registrar.armed, "the registrar reports armed");
});

test("register on an aborted signal never arms and stops any prior scheduler", async () => {
  const { deps, created } = makeDeps();
  const registrar = new ActivitySyncRegistrar(deps);
  await registrar.register(new AbortController().signal);
  const prior = created[0];
  const aborted = AbortSignal.abort();
  await registrar.register(aborted);
  assert.equal(created.length, 1, "no replacement scheduler is constructed while aborted");
  assert.equal(prior?.stops, 1, "the prior scheduler is stopped before bailing");
  assert.equal(registrar.armed, false, "the registrar is disarmed after an aborted re-init");
});

test("register re-arms by stopping the prior scheduler first", async () => {
  const { deps, created } = makeDeps();
  const registrar = new ActivitySyncRegistrar(deps);
  await registrar.register(new AbortController().signal);
  await registrar.register(new AbortController().signal);
  assert.equal(created.length, 2, "a fresh scheduler is armed on re-register");
  assert.equal(created[0]?.stops, 1, "the prior scheduler is drained");
  assert.equal(created[1]?.starts, 1, "the replacement scheduler is started");
  assert.ok(registrar.armed);
});

test("register refuses to arm under a secure store", async () => {
  const { deps, created } = makeDeps({ secureStoreEnabled: true });
  const registrar = new ActivitySyncRegistrar(deps);
  await registrar.register(new AbortController().signal);
  assert.equal(created.length, 0, "no scheduler is armed when at-rest encryption is on");
  assert.equal(registrar.armed, false);
});

test("dispose latches teardown and drains the scheduler", async () => {
  const { deps, created } = makeDeps();
  const registrar = new ActivitySyncRegistrar(deps);
  await registrar.register(new AbortController().signal);
  await registrar.dispose();
  assert.equal(created[0]?.stops, 1, "dispose drains the armed scheduler");
  assert.equal(registrar.armed, false, "the registrar is disarmed after dispose");
});

test("a reindex failure queues a retry, but never after teardown", async () => {
  const box = makeDeps();
  const registrar = new ActivitySyncRegistrar(box.deps);
  await registrar.register(new AbortController().signal);
  const onRun = box.created[0]?.options.onRun as (s: ActivitySyncRunSummary) => void;
  const failed = { machine: "m", ran: true, fetched: 0, inserted: 0, duplicates: 0, reindexErrorCount: 2 } as unknown as ActivitySyncRunSummary;
  onRun(failed);
  assert.equal(box.state.retries, 1, "a failed reindex queues one maintenance retry");
  await registrar.dispose();
  onRun(failed);
  assert.equal(box.state.retries, 1, "a draining tick's onRun does not re-arm maintenance after teardown");
});

test("abort landing during construction stops the freshly-started scheduler", async () => {
  const controller = new AbortController();
  const created: FakeScheduler[] = [];
  const { deps } = makeDeps({
    createScheduler: (options) => {
      // Simulate the abort arriving in the window between the guard and start().
      controller.abort();
      const s = new FakeScheduler(options);
      created.push(s);
      return s;
    },
  });
  const registrar = new ActivitySyncRegistrar(deps);
  await registrar.register(controller.signal);
  assert.equal(created.length, 1, "the scheduler is constructed before the abort is observed");
  assert.equal(created[0]?.starts, 1, "it is started");
  assert.equal(created[0]?.stops, 1, "then immediately stopped once the abort is seen");
  assert.equal(registrar.armed, false, "the registrar does not retain an aborted scheduler");
});
