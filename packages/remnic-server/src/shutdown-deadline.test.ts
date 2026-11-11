// Deadline behavioral tests for the teardown chain: a wedged orchestrator
// destroy must not hold the stop chain past the injected deadline. When the
// deadline passes, a warn marker names the phase (durations only), and the
// finish callback still runs. Uses the REAL exported shutdownBacklogDrain —
// the same chain index.ts stop wires — with controlled wedged callbacks,
// because a real orchestrator cannot be made to wedge deterministically.
import assert from "node:assert/strict";
import test from "node:test";

import { initLogger } from "@remnic/core";
import type { LoggerBackend } from "@remnic/core/logger";

import { ORCHESTRATOR_DESTROY_DEADLINE_MS, shutdownBacklogDrain } from "./backlog-drain-lifecycle.js";

/** Captured log lines with the logger's "remnic: " prefix stripped. */
interface CapturedLog {
  lines: string[];
}

function installRecordingLogger(): CapturedLog {
  const lines: string[] = [];
  const body = (msg: string) => msg.replace(/^remnic: /, "");
  const backend: LoggerBackend = {
    info: (msg) => lines.push(body(msg)),
    warn: (msg) => lines.push(body(msg)),
    error: (msg) => lines.push(body(msg)),
  };
  initLogger(backend, false, { timestamps: false });
  return { lines };
}

function quietLogger(): void {
  initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false);
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label}: test deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test("a wedged orchestrator destroy cannot hold the stop chain past the injected deadline", async () => {
  const { lines } = installRecordingLogger();
  // Never settles until the test unsticks it in finally: a drain wedged
  // beyond any abort handling. Settling it at teardown keeps the runner's
  // loop drain clean; the deadline path already swallowed its rejection.
  const { promise: wedged, reject: unstick } = Promise.withResolvers<void>();
  try {
    let finishRan = false;
    const startedAtMs = Date.now();
    const wedgedDestroy = (): Promise<void> => wedged;

    await withTestDeadline(
      shutdownBacklogDrain(undefined, wedgedDestroy, () => {
        finishRan = true;
      }, 100),
      5_000,
      "stop chain with wedged destroy",
    );

    assert.ok(Date.now() - startedAtMs < 4_000, "the deadline, not the wedged drain, bounds the wait");
    assert.equal(finishRan, true, "finish must run after the deadline");
    const timeoutLines = lines.filter((line) => line.startsWith("shutdown-phase-timeout phase="));
    assert.equal(timeoutLines.length, 1);
    assert.match(
      timeoutLines[0] ?? "",
      /^shutdown-phase-timeout phase=orchestrator-drain-flush-dispose durationMs=\d+$/,
      "the timeout marker names the phase with a duration only",
    );
  } finally {
    unstick(new Error("wedged destroy unstuck at test teardown"));
    quietLogger();
  }
});

test("the default destroy deadline is the 60s production backstop", () => {
  assert.equal(ORCHESTRATOR_DESTROY_DEADLINE_MS, 60_000);
});

test("a destroy that rejects before the deadline propagates its error and still runs finish", async () => {
  const { lines } = installRecordingLogger();
  const { promise: earlyFailure, reject: failNow } = Promise.withResolvers<void>();
  try {
    let finishRan = false;
    const failingDestroy = (): Promise<void> => earlyFailure;

    const pending = shutdownBacklogDrain(undefined, failingDestroy, () => {
      finishRan = true;
    }, 60_000);
    const settled = assert.rejects(
      withTestDeadline(pending, 5_000, "in-time destroy rejection"),
      /persist failed during shutdown/,
    );
    // Reject well before the 60s deadline: the error must surface as the
    // chain's own rejection, not be swallowed by the deadline machinery.
    failNow(new Error("buffer persist failed during shutdown"));
    await settled;
    assert.equal(finishRan, true, "finish must still run after an in-time failure");
    assert.ok(
      lines.some((line) => line.startsWith("shutdown-phase-failure phase=orchestrator-drain-flush-dispose")),
      "the phase failure marker must be emitted for an in-time rejection",
    );
  } finally {
    failNow(new Error("buffer persist failed during shutdown"));
    quietLogger();
  }
});

test("a destroy that rejects after the deadline passed does not crash the stop chain", async () => {
  quietLogger();
  let finishRan = false;
  const lateRejectingDestroy = (): Promise<void> =>
    new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("late destroy failure")), 250);
      timer.unref?.();
    });

  // Resolves (the deadline fired long before); the losing promise's late
  // rejection must be swallowed, not surface as an unhandled rejection.
  await withTestDeadline(
    shutdownBacklogDrain(undefined, lateRejectingDestroy, () => {
      finishRan = true;
    }, 50),
    5_000,
    "stop chain with late-rejecting destroy",
  );
  assert.equal(finishRan, true);
  // Give the late rejection a chance to surface before the test ends.
  await new Promise((resolve) => setTimeout(resolve, 400));
});
