import test from "node:test";
import assert from "node:assert/strict";
import { throwIfAborted } from "./abort-error.js";
import {
  createBoundedCoreSectionRunner,
  createRecallSectionMetricRecorder,
  resolveRecallCoreSectionDeadlineMs,
  runRecallSectionWithinDeadline,
  yieldToEventLoop,
  type RecallSectionMetric,
} from "./recall-qos.js";

test("recall section metric recorder stores timing strings and logs core success at info level", () => {
  const timings: Record<string, string> = {};
  const calls: Array<{ level: "info" | "debug"; message: string; payload: unknown[] }> = [];
  const recorder = createRecallSectionMetricRecorder({
    timings,
    logger: {
      info: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "info", message, payload });
      },
      debug: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "debug", message, payload });
      },
    },
  });

  const metric: RecallSectionMetric = {
    section: "profile",
    priority: "core",
    durationMs: 12,
    deadlineMs: 75_000,
    source: "fresh",
    success: true,
  };

  recorder(metric);

  assert.equal(timings.profile, "12ms");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.level, "info");
  assert.equal(calls[0]?.message, "recall section metric");
  assert.deepEqual(calls[0]?.payload[0], {
    section: "profile",
    priority: "core",
    durationMs: 12,
    deadlineMs: 75_000,
    source: "fresh",
    success: true,
  });
});

test("recall section metric recorder respects timing overrides and logs enrichment skips at debug level", () => {
  const timings: Record<string, string> = {};
  const calls: Array<{ level: "info" | "debug"; message: string; payload: unknown[] }> = [];
  const recorder = createRecallSectionMetricRecorder({
    timings,
    logger: {
      info: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "info", message, payload });
      },
      debug: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "debug", message, payload });
      },
    },
  });

  recorder({
    section: "qmd",
    priority: "enrichment",
    durationMs: 0,
    deadlineMs: 25_000,
    source: "skip",
    success: true,
    timing: "skip(limit=0)",
  });

  assert.equal(timings.qmd, "skip(limit=0)");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.level, "debug");
  assert.equal(calls[0]?.message, "recall section metric");
  assert.deepEqual(calls[0]?.payload[0], {
    section: "qmd",
    priority: "enrichment",
    durationMs: 0,
    deadlineMs: 25_000,
    source: "skip",
    success: true,
  });
});

test("timed-out section metric reports the breach instead of a plain duration", () => {
  const timings: Record<string, string> = {};
  const calls: Array<{ level: "info" | "debug"; payload: unknown[] }> = [];
  const recorder = createRecallSectionMetricRecorder({
    timings,
    logger: {
      info: (_message: string, ...payload: unknown[]) => calls.push({ level: "info", payload }),
      debug: (_message: string, ...payload: unknown[]) => calls.push({ level: "debug", payload }),
    },
  });

  recorder({
    section: "entityRetrieval",
    priority: "core",
    durationMs: 75_004,
    deadlineMs: 75_000,
    source: "timeout",
    success: false,
  });

  assert.equal(timings.entityRetrieval, "timeout(75004ms)");
  // A breach is not a success, so it must not be logged as one.
  assert.equal(calls[0]?.level, "debug");
});

test("recall section deadline degrades to the fallback and cancels the section", async () => {
  let observedSignal: AbortSignal | undefined;
  let cancelledDuringWork = false;

  // A real timer is the subject here, not a guessed wait: the section below
  // never settles on its own, so the deadline always wins regardless of load.
  const outcome = await runRecallSectionWithinDeadline({
    deadlineMs: 15,
    fallback: "degraded",
    run: async (sectionSignal) => {
      observedSignal = sectionSignal;
      const cancelled = Promise.withResolvers<void>();
      sectionSignal.addEventListener("abort", () => {
        cancelledDuringWork = true;
        cancelled.resolve();
      });
      await cancelled.promise;
      return "late value";
    },
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.value, "degraded");
  assert.equal(observedSignal?.aborted, true);
  assert.equal(cancelledDuringWork, true);
});

test("recall section deadline returns the real value when the section finishes in time", async () => {
  const outcome = await runRecallSectionWithinDeadline({
    deadlineMs: 5_000,
    fallback: null as string | null,
    run: async (sectionSignal) => {
      assert.equal(sectionSignal.aborted, false);
      return "section body";
    },
  });

  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.value, "section body");
});

test("a zero deadline disables the bound rather than failing every section", async () => {
  const released = Promise.withResolvers<void>();
  const pending = runRecallSectionWithinDeadline({
    deadlineMs: 0,
    fallback: "degraded",
    run: async () => {
      await released.promise;
      return "unbounded value";
    },
  });

  // Two full event-loop turns: any 0ms timer would already have fired, so a
  // still-pending section proves the bound was disabled rather than instant.
  for (let turn = 0; turn < 2; turn += 1) {
    const turned = Promise.withResolvers<void>();
    setImmediate(turned.resolve);
    await turned.promise;
  }
  released.resolve();

  const outcome = await pending;
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.value, "unbounded value");
});

test("a caller abort propagates into the section signal", async () => {
  const caller = new AbortController();
  let cancelledDuringWork = false;

  const pending = runRecallSectionWithinDeadline({
    deadlineMs: 5_000,
    fallback: "degraded",
    parentSignal: caller.signal,
    run: async (sectionSignal) => {
      const cancelled = Promise.withResolvers<void>();
      sectionSignal.addEventListener("abort", () => {
        cancelledDuringWork = true;
        cancelled.resolve();
      });
      await cancelled.promise;
      return "cancelled";
    },
  });

  caller.abort();
  const outcome = await pending;

  assert.equal(cancelledDuringWork, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.value, "cancelled");
});

test("an already-aborted caller signal cancels the section before it does work", async () => {
  const caller = new AbortController();
  caller.abort();

  const outcome = await runRecallSectionWithinDeadline({
    deadlineMs: 5_000,
    fallback: "degraded",
    parentSignal: caller.signal,
    run: async (sectionSignal) => {
      assert.equal(sectionSignal.aborted, true);
      return "observed";
    },
  });

  assert.equal(outcome.value, "observed");
});

test("a section rejection surfaces to the caller instead of being swallowed", async () => {
  await assert.rejects(
    runRecallSectionWithinDeadline({
      deadlineMs: 5_000,
      fallback: "degraded",
      run: async () => {
        throw new Error("section exploded");
      },
    }),
    /section exploded/,
  );
});

test("the default core section budget is capped below the request ceiling", () => {
  // Both settings default to 75s. Taken at face value the section deadline could
  // never fire first, so degradation would be unreachable on default config.
  assert.equal(
    resolveRecallCoreSectionDeadlineMs({
      configuredCoreDeadlineMs: 75_000,
      outerTimeoutMs: 75_000,
    }),
    60_000,
  );
});

test("an explicitly lowered core section budget is honored exactly", () => {
  assert.equal(
    resolveRecallCoreSectionDeadlineMs({
      configuredCoreDeadlineMs: 5_000,
      outerTimeoutMs: 75_000,
    }),
    5_000,
  );
});

test("a zero budget on either side keeps the configured value", () => {
  assert.equal(
    resolveRecallCoreSectionDeadlineMs({ configuredCoreDeadlineMs: 0, outerTimeoutMs: 75_000 }),
    0,
  );
  // No request ceiling means nothing to reserve headroom against.
  assert.equal(
    resolveRecallCoreSectionDeadlineMs({ configuredCoreDeadlineMs: 75_000, outerTimeoutMs: 0 }),
    75_000,
  );
});

test("a bounded core section degrades on cancellation rather than rejecting", async () => {
  // The phase this section belongs to is awaited through a race the caller's
  // abort also wins, so a rejection here would be an unhandled rejection.
  const metrics: RecallSectionMetric[] = [];
  const caller = new AbortController();
  const runSection = createBoundedCoreSectionRunner({
    deadlineMs: 5_000,
    parentSignal: caller.signal,
    record: (metric) => metrics.push(metric),
    logger: { warn: () => {} },
  });

  caller.abort();
  const value = await runSection("artifacts", [] as string[], async (sectionSignal) => {
    throwIfAborted(sectionSignal, "artifact search aborted");
    return ["should not be reached"];
  });

  assert.deepEqual(value, []);
  assert.equal(metrics[0]?.section, "artifacts");
  assert.equal(metrics[0]?.success, false);
  assert.match(metrics[0]?.timing ?? "", /^cancelled\(\d+ms\)$/);
});

test("a bounded core section still surfaces a non-abort failure", async () => {
  const runSection = createBoundedCoreSectionRunner({
    deadlineMs: 5_000,
    record: () => {},
    logger: { warn: () => {} },
  });

  await assert.rejects(
    runSection("artifacts", [] as string[], async () => {
      throw new Error("artifact tier unreadable");
    }),
    /artifact tier unreadable/,
  );
});

test("yieldToEventLoop lets a pending timer run", async () => {
  // The guarantee corpus scans depend on: without a yield the timer that carries
  // a section deadline cannot fire while the scan holds the loop.
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 0);

  await yieldToEventLoop();
  await yieldToEventLoop();
  clearTimeout(timer);

  assert.equal(timerFired, true);
});
