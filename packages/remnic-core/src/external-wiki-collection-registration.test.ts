import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExternalWikiCollectionRefreshTarget,
  ExternalWikiCollectionRegistrar,
} from "./external-wiki-collection-registration.js";
import type { ExternalWikiCollectionRoot } from "./external-wiki-collection.js";

interface TimerFixture {
  schedule(callback: () => void, intervalMs: number): object;
  cancel(handle: object): void;
  callbacks: Array<() => void>;
  intervals: number[];
  cancelled: object[];
}

function makeTimerFixture(): TimerFixture {
  const callbacks: Array<() => void> = [];
  const intervals: number[] = [];
  const cancelled: object[] = [];
  return {
    schedule(callback, intervalMs) {
      callbacks.push(callback);
      intervals.push(intervalMs);
      return { callback };
    },
    cancel(handle) {
      cancelled.push(handle);
    },
    callbacks,
    intervals,
    cancelled,
  };
}

const roots: ExternalWikiCollectionRoot[] = [
  {
    id: "reading",
    rootDir: "/tmp/wiki",
    enabled: true,
    pagesDir: "wiki",
    indexInQmd: true,
  },
];

test("registrar refreshes at startup and on its documented maintenance interval", async () => {
  const timers = makeTimerFixture();
  const calls: ExternalWikiCollectionRoot[][] = [];
  const target: ExternalWikiCollectionRefreshTarget = {
    refresh: async (configuredRoots) => {
      calls.push([...configuredRoots]);
      return [];
    },
  };
  const registrar = new ExternalWikiCollectionRegistrar({
    target,
    getRoots: () => roots,
    intervalMs: 15 * 60_000,
    timers,
  });

  await registrar.register();
  timers.callbacks[0]?.();
  await registrar.waitForIdle();

  assert.equal(calls.length, 2);
  assert.deepEqual(timers.intervals, [15 * 60_000]);
  await registrar.dispose();
  assert.equal(timers.cancelled.length, 1);
});

test("registrar single-flights overlapping maintenance ticks", async () => {
  const timers = makeTimerFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let callCount = 0;
  const target: ExternalWikiCollectionRefreshTarget = {
    refresh: async () => {
      callCount += 1;
      if (callCount > 1) await blocked;
      return [];
    },
  };
  const registrar = new ExternalWikiCollectionRegistrar({
    target,
    getRoots: () => roots,
    intervalMs: 1000,
    timers,
  });
  await registrar.register();

  timers.callbacks[0]?.();
  timers.callbacks[0]?.();
  await Promise.resolve();
  assert.equal(callCount, 2);

  release();
  await registrar.waitForIdle();
  await registrar.dispose();
});

test("a failed maintenance tick clears singleflight state for the next tick", async () => {
  const timers = makeTimerFixture();
  let callCount = 0;
  const target: ExternalWikiCollectionRefreshTarget = {
    refresh: async () => {
      callCount += 1;
      if (callCount === 2) throw new Error("backend unavailable");
      return [];
    },
  };
  const registrar = new ExternalWikiCollectionRegistrar({
    target,
    getRoots: () => roots,
    intervalMs: 1000,
    timers,
  });
  await registrar.register();

  timers.callbacks[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  timers.callbacks[0]?.();
  await registrar.waitForIdle();

  assert.equal(callCount, 3);
  await registrar.dispose();
});

test("dispose aborts and drains an in-flight refresh", async () => {
  const timers = makeTimerFixture();
  let observedSignal: AbortSignal | undefined;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let callCount = 0;
  const target: ExternalWikiCollectionRefreshTarget = {
    refresh: async (_configuredRoots, execution) => {
      callCount += 1;
      observedSignal = execution?.signal;
      if (callCount > 1) await blocked;
      return [];
    },
  };
  const registrar = new ExternalWikiCollectionRegistrar({
    target,
    getRoots: () => roots,
    intervalMs: 1000,
    timers,
  });
  await registrar.register();
  timers.callbacks[0]?.();
  await Promise.resolve();

  const disposing = registrar.dispose();
  assert.equal(observedSignal?.aborted, true);
  release();
  await disposing;

  assert.equal(timers.cancelled.length, 1);
});
