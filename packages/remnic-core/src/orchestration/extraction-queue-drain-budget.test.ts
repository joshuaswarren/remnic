import assert from "node:assert/strict";
import test from "node:test";

import { initLogger, resetLogger } from "../logger.js";
import { drainExtractionAndShutdownDependencyPropagation } from "./extraction-shutdown.js";
import { ExtractionQueueCoordinator } from "./extraction-queue-coordinator.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));


test("pauseAndDrain bounds the post-timeout tail and reports not-drained", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const { promise: block, resolve: release } = Promise.withResolvers<void>();
  queue.enqueue(async () => {
    await block;
  }, { key: "slow" });
  const outcome = await Promise.race([
    queue.pauseAndDrain(20, 40),
    sleep(2_000).then(() => "hung" as const),
  ]);
  release();
  assert.notEqual(outcome, "hung", "the post-timeout tail must be bounded, not infinite");
  assert.equal(outcome, false, "a drain abandoned at the tail budget must report not-drained");
});

test("pauseAndDrain returns true when accepted work settles inside the tail budget", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const { promise: block, resolve: release } = Promise.withResolvers<void>();
  queue.enqueue(async () => {
    await block;
  }, { key: "slow" });
  const drained = queue.pauseAndDrain(20, 1_000);
  setTimeout(release, 60);
  assert.equal(await drained, true);
});

test("an abandoned drain logs the outstanding entries and the elapsed time", async () => {
  const warnings: string[] = [];
  initLogger({ info() {}, warn: (m) => warnings.push(String(m)), error() {}, debug() {} });
  let outcome: boolean | "hung";
  try {
    const queue = new ExtractionQueueCoordinator(1);
    const { promise: block } = Promise.withResolvers<void>();
    queue.enqueue(async () => {
      await block;
    }, { key: "slow-extraction-key" });
    outcome = await Promise.race([
      queue.pauseAndDrain(20, 40),
      sleep(500).then(() => "hung" as const),
    ]);
  } finally {
    resetLogger();
  }
  assert.notEqual(outcome, "hung", "drain must not hang to reach the abandonment log");
  const named = warnings.find((w) => w.includes("slow-extraction-key"));
  assert.ok(
    named,
    `expected a warning naming the outstanding entry key; got: ${warnings.join(" | ") || "(none)"}`,
  );
  assert.match(named, /\d+\s?ms|elapsed/i, "the abandonment warning must report elapsed time");
});

test("a false drained flag reaches the shutdown path as a drain error", async () => {
  const err = await drainExtractionAndShutdownDependencyPropagation(
    { pauseAndDrain: async () => false },
    { shutdown: async () => {} },
  );
  assert.ok(err instanceof Error, "not-drained must surface as an error, not silently pass");
  assert.match(String(err), /did not drain/);
});
