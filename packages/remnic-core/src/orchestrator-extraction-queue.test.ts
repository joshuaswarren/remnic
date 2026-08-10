import assert from "node:assert/strict";
import test from "node:test";

import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
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


test("stopAccepting rejects new producers until resume", async () => {
  const coordinator = createCoordinator();
  coordinator.stopAccepting();
  assert.equal(coordinator.enqueue(async () => {}), false);
  coordinator.resumeAccepting();
  assert.equal(coordinator.enqueue(async () => {}), true);
  assert.equal(await coordinator.pauseAndDrain(), true);
});
