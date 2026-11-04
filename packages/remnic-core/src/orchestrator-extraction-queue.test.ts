import assert from "node:assert/strict";
import test from "node:test";

import { ExtractionQueueCoordinator, type ExtractionPreemptHandle, type ExtractionQueueTask } from "./orchestration/extraction-queue-coordinator.js";
import { initLogger, type LoggerBackend } from "./logger.js";
import { abortError } from "./abort-error.js";

interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  err?: unknown;
}

function installCapturingLogger(): { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const backend: LoggerBackend = {
    info(message) {
      entries.push({ level: "info", message });
    },
    warn(message) {
      entries.push({ level: "warn", message });
    },
    error(message, err) {
      entries.push({ level: "error", message, err });
    },
    debug(message) {
      entries.push({ level: "debug", message });
    },
  };
  initLogger(backend, true);
  return { entries };
}

function createCoordinator(): ExtractionQueueCoordinator {
  return new ExtractionQueueCoordinator();
}

// ── Issue #549 ─────────────────────────────────────────────────────────────

test("processQueue logs an AbortError task at debug, not error (#549)", async () => {
  // Regression for issue #549: session transitions fire the abort
  // signal, and queued extraction tasks that pick it up throw via
  // `throwIfRecallAborted` (an Error with `name === "AbortError"`).
  // That is intentional deduplication, not a failure.  The queue
  // processor must log it at debug.
  const { entries } = installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.pushRaw(async () => {
    throw abortError("extraction aborted (before_extract)");
  });
  await coordinator.processQueue();

  const errorEntries = entries.filter((e) => e.level === "error");
  const debugEntries = entries.filter(
    (e) => e.level === "debug" && e.message.includes("aborted"),
  );
  assert.equal(
    errorEntries.length,
    0,
    `expected no error logs for abort; got ${errorEntries.map((e) => e.message).join(", ")}`,
  );
  assert.ok(
    debugEntries.some((e) =>
      e.message.includes("background extraction task aborted"),
    ),
    "expected a debug log describing the session-transition abort",
  );
});

test("processQueue still logs real task failures at error", async () => {
  // Guard the other half: non-abort errors (network, parse, I/O) must
  // continue to log at error level.
  const { entries } = installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.pushRaw(async () => {
    throw new Error("upstream LLM 500");
  });
  await coordinator.processQueue();

  const errorEntries = entries.filter((e) => e.level === "error");
  assert.equal(errorEntries.length, 1);
  assert.ok(
    errorEntries[0]?.message.includes("background extraction task failed"),
    `expected failed-task message; got ${errorEntries[0]?.message}`,
  );
});

test("processQueue handles a mixed run — abort goes to debug, failure to error", async () => {
  const { entries } = installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.pushRaw(async () => {
    throw abortError("extraction aborted (before_clear_buffer)");
  });
  coordinator.pushRaw(async () => {
    throw new Error("I/O failure");
  });
  await coordinator.processQueue();

  const errorCount = entries.filter((e) => e.level === "error").length;
  const abortDebugCount = entries.filter(
    (e) =>
      e.level === "debug" &&
      e.message.includes("background extraction task aborted"),
  ).length;
  assert.equal(errorCount, 1, "one real failure should log at error");
  assert.equal(
    abortDebugCount,
    1,
    "one abort should log at debug",
  );
});

test("processQueue clears queueProcessing on exit regardless of task outcomes", async () => {
  installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.setProcessingForTest(true);
  coordinator.pushRaw(async () => {
    throw abortError("extraction aborted");
  });
  await coordinator.processQueue();
  assert.equal(coordinator.isProcessing, false);
});

// ── Outer processQueue().catch() branch (Codex follow-up on #549) ──────────

test("logExtractionQueueFailure(processor) classifies AbortError as debug (#549)", async () => {
  // Covers the outer `processQueue().catch(...)` path in
  // `enqueue`.  A processor-level AbortError can
  // bubble from e.g. a processQueue rewrite that awaits an external
  // signal, so the handler must fail open to debug — otherwise a
  // session-transition-triggered processor abort would get logged
  // at error next to the successful extraction it just produced.
  const { entries } = installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.logExtractionQueueFailure(
    abortError("queue processor aborted"),
    "processor",
  );
  const errorEntries = entries.filter((e) => e.level === "error");
  const debugEntries = entries.filter(
    (e) =>
      e.level === "debug" &&
      e.message.includes("background extraction queue processor aborted"),
  );
  assert.equal(errorEntries.length, 0);
  assert.equal(debugEntries.length, 1);
});

test("logExtractionQueueFailure(processor) preserves error-level for real failures", async () => {
  const { entries } = installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.logExtractionQueueFailure(
    new Error("unexpected processor crash"),
    "processor",
  );
  const errorEntries = entries.filter((e) => e.level === "error");
  assert.equal(errorEntries.length, 1);
  assert.ok(
    errorEntries[0]?.message.includes(
      "background extraction queue processor failed",
    ),
  );
});

test("logExtractionQueueFailure names the right layer (task vs processor)", async () => {
  // Regression guard that keeps the two log messages distinct — a
  // single shared message would lose the operator context that
  // tells them whether a specific extraction aborted or the queue
  // processor itself did.
  const { entries } = installCapturingLogger();
  const coordinator = createCoordinator();
  coordinator.logExtractionQueueFailure(abortError("a"), "task");
  coordinator.logExtractionQueueFailure(abortError("b"), "processor");
  const debugMessages = entries
    .filter((e) => e.level === "debug")
    .map((e) => e.message);
  assert.ok(
    debugMessages.some((m) => m.includes("background extraction task aborted")),
  );
  assert.ok(
    debugMessages.some((m) =>
      m.includes("background extraction queue processor aborted"),
    ),
  );
});


test("pauseAndDrain waits for accepted work after its observation timeout", async () => {
  const coordinator = createCoordinator();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const waitForIdle = coordinator.waitForIdle.bind(coordinator);
  let waitCalls = 0;
  let drainSettled = false;
  coordinator.waitForIdle = async (timeoutMs?: number): Promise<boolean> => {
    waitCalls += 1;
    if (waitCalls === 1) return false;
    return waitForIdle(timeoutMs);
  };
  coordinator.enqueue(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const drain = coordinator.pauseAndDrain().then((result) => {
    drainSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(drainSettled, false);
  release.resolve();
  assert.equal(await drain, true);
  assert.equal(waitCalls, 2);
  assert.equal(coordinator.isProcessing, false);
});

test("stopAccepting rejects new producers until resume", async () => {
  const coordinator = createCoordinator();
  coordinator.stopAccepting();
  assert.equal(coordinator.enqueue(async () => {}), false);
  coordinator.resumeAccepting();
  assert.equal(coordinator.enqueue(async () => {}), true);
  assert.equal(await coordinator.pauseAndDrain(), true);
});

test("a front enqueue aborts the running automatic task and runs before queued work", async () => {
  const coordinator = createCoordinator();
  const order: string[] = [];
  const started = Promise.withResolvers<void>();
  coordinator.enqueue(async (preempt) => {
    const controller = new AbortController();
    preempt?.arm(() => controller.abort());
    started.resolve();
    try {
      const { promise, reject } = Promise.withResolvers<void>();
      controller.signal.addEventListener("abort", () => reject(abortError("preempted")), { once: true });
      await promise;
      order.push("automatic-finished");
    } finally {
      preempt?.disarm();
    }
  });
  await started.promise;
  coordinator.enqueue(async () => {
    order.push("queued");
  });
  coordinator.enqueue(async () => {
    order.push("flush");
  }, { front: true });
  await coordinator.waitForIdle();
  assert.deepEqual(order, ["flush", "queued"]);
});

test("a front enqueue does not abort a task that did not register as preemptable", async () => {
  const coordinator = createCoordinator();
  const order: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  coordinator.enqueue(async () => {
    started.resolve();
    await release.promise;
    order.push("protected");
  });
  await started.promise;
  coordinator.enqueue(async () => {
    order.push("flush");
  }, { front: true });
  release.resolve();
  await coordinator.waitForIdle();
  assert.deepEqual(order, ["protected", "flush"]);
});


// ── Bounded-parallel queue (extractionQueueConcurrency) ─────────────────────

function createParallelCoordinator(limit: number): ExtractionQueueCoordinator {
  return new ExtractionQueueCoordinator(limit);
}

/** A parked queue task with deterministic start/abort/release signals. */
function makeParkedTask(preemptable: boolean) {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let outcome: "parked" | "finished" | "aborted" = "parked";
  const task: ExtractionQueueTask = async (preempt?: ExtractionPreemptHandle) => {
    const controller = new AbortController();
    if (preemptable) {
      preempt?.arm(() => controller.abort(abortError("preempted")));
      controller.signal.addEventListener("abort", () => {
        outcome = "aborted";
        release.resolve();
      }, { once: true });
    }
    started.resolve();
    await release.promise;
    if (outcome === "parked") outcome = "finished";
    preempt?.disarm();
  };
  return {
    task,
    startedPromise: started.promise,
    release: () => release.resolve(),
    get outcome() {
      return outcome;
    },
  };
}

test("independent keys run concurrently up to the configured limit", async () => {
  const coordinator = createParallelCoordinator(2);
  const first = makeParkedTask(false);
  const second = makeParkedTask(false);
  const third = makeParkedTask(false);
  coordinator.enqueue(first.task, { key: "session-a" });
  coordinator.enqueue(second.task, { key: "session-b" });
  coordinator.enqueue(third.task, { key: "session-c" });
  await first.startedPromise;
  await second.startedPromise;
  assert.equal(third.outcome, "parked", "the third task waits: both slots are taken");
  first.release();
  await third.startedPromise;
  second.release();
  third.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
  assert.equal(first.outcome, "finished");
  assert.equal(second.outcome, "finished");
  assert.equal(third.outcome, "finished");
  assert.equal(coordinator.isProcessing, false);
});

test("tasks sharing a buffer key never run concurrently even with free capacity", async () => {
  const coordinator = createParallelCoordinator(2);
  const busy = makeParkedTask(false);
  const queuedSameKey = makeParkedTask(false);
  const otherKey = makeParkedTask(false);
  coordinator.enqueue(busy.task, { key: "s1" });
  await busy.startedPromise;
  coordinator.enqueue(queuedSameKey.task, { key: "s1" });
  coordinator.enqueue(otherKey.task, { key: "s2" });
  await otherKey.startedPromise;
  assert.equal(queuedSameKey.outcome, "parked", "the busy session's next task waits for its own key");
  busy.release();
  await queuedSameKey.startedPromise;
  queuedSameKey.release();
  otherKey.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
  assert.equal(queuedSameKey.outcome, "finished");
  assert.equal(otherKey.outcome, "finished");
});

test("the default limit stays serial", async () => {
  const coordinator = createCoordinator();
  assert.equal(coordinator.maxConcurrency, 1);
  const first = makeParkedTask(false);
  const second = makeParkedTask(false);
  coordinator.enqueue(first.task, { key: "s1" });
  coordinator.enqueue(second.task, { key: "s2" });
  await first.startedPromise;
  assert.equal(second.outcome, "parked", "limit 1 never runs a second task concurrently");
  first.release();
  await second.startedPromise;
  second.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
  assert.equal(second.outcome, "finished");
});

test("a failing task does not stall the queue", async () => {
  const { entries } = installCapturingLogger();
  const coordinator = createParallelCoordinator(2);
  const parked = makeParkedTask(false);
  coordinator.enqueue(async () => {
    throw new Error("extraction exploded");
  }, { key: "s1" });
  coordinator.enqueue(parked.task, { key: "s2" });
  await parked.startedPromise;
  parked.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
  assert.equal(parked.outcome, "finished");
  assert.ok(entries.some((entry) => entry.level === "error" && /background extraction task failed/.test(entry.message)));
});

test("a front enqueue aborts exactly one armed running task when two run", async () => {
  const coordinator = createParallelCoordinator(2);
  const first = makeParkedTask(true);
  const second = makeParkedTask(true);
  let flushRan = false;
  coordinator.enqueue(first.task, { key: "s1" });
  coordinator.enqueue(second.task, { key: "s2" });
  await first.startedPromise;
  await second.startedPromise;
  coordinator.enqueue(async () => {
    flushRan = true;
  }, { front: true });
  assert.equal(second.outcome, "aborted", "the most recently armed task is the one preempted");
  assert.equal(first.outcome, "parked", "the unrelated running extraction is not cancelled");
  first.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
  assert.equal(flushRan, true);
  assert.equal(first.outcome, "finished");
});

test("a front enqueue prefers the requested key's own running task", async () => {
  const coordinator = createParallelCoordinator(2);
  const other = makeParkedTask(true);
  const mine = makeParkedTask(true);
  let flushRan = false;
  coordinator.enqueue(other.task, { key: "s-other" });
  coordinator.enqueue(mine.task, { key: "s-mine" });
  await other.startedPromise;
  await mine.startedPromise;
  coordinator.enqueue(async () => {
    flushRan = true;
  }, { front: true, key: "s-mine" });
  assert.equal(mine.outcome, "aborted", "the flush preempts its own session's running extraction");
  assert.equal(other.outcome, "parked", "the unrelated running extraction keeps going");
  other.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
  assert.equal(flushRan, true);
  assert.equal(other.outcome, "finished");
});

test("pauseAndDrain waits for concurrent accepted work and rejects new producers", async () => {
  const coordinator = createParallelCoordinator(2);
  const first = makeParkedTask(false);
  const second = makeParkedTask(false);
  coordinator.enqueue(first.task, { key: "s1" });
  coordinator.enqueue(second.task, { key: "s2" });
  await first.startedPromise;
  await second.startedPromise;
  const drain = coordinator.pauseAndDrain(5_000);
  assert.equal(coordinator.enqueue(async () => {}, { key: "s3" }), false);
  first.release();
  second.release();
  assert.equal(await drain, true);
  assert.equal(first.outcome, "finished");
  assert.equal(second.outcome, "finished");
  assert.equal(coordinator.isProcessing, false);
});
