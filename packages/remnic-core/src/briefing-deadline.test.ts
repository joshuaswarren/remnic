/**
 * Issue #3139 — the briefing's default deadline.
 *
 * The budget is a server-side limit, not a client cancellation: exhausting it
 * must surface as an explicit TimeoutError, never as an empty result.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIEFING_DEADLINE_MS,
  BriefingTimeoutError,
  withBriefingDeadline,
} from "./briefing-deadline.js";

test("withBriefingDeadline rejects with a TimeoutError when the default budget is exhausted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });

  const pending = withBriefingDeadline(
    () => Promise.withResolvers<never>().promise,
  );

  t.mock.timers.tick(BRIEFING_DEADLINE_MS);

  await assert.rejects(pending, (err) => {
    assert.ok(
      err instanceof BriefingTimeoutError,
      "budget exhaustion must surface as a timeout",
    );
    assert.equal(err.name, "TimeoutError");
    assert.equal(err.deadlineMs, BRIEFING_DEADLINE_MS);
    return true;
  });
});

test("withBriefingDeadline clears its timer once the run settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let observed: AbortSignal | undefined;

  const result = await withBriefingDeadline(async (signal) => {
    observed = signal;
    return "briefing";
  });

  assert.equal(result, "briefing");
  t.mock.timers.tick(BRIEFING_DEADLINE_MS);
  assert.equal(
    observed?.aborted,
    false,
    "the budget timer must be cleared when the run settles, not left to fire afterwards",
  );
});

test("withBriefingDeadline preserves work failures and clears their timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const failure = new Error("synthetic work failure");
  const signals: AbortSignal[] = [];

  const pending = withBriefingDeadline(async (signal) => {
    signals.push(signal);
    throw failure;
  });

  await assert.rejects(pending, (err) => err === failure);
  assert.equal(signals.length, 1);
  t.mock.timers.tick(BRIEFING_DEADLINE_MS);
  assert.equal(signals[0].aborted, false);
});

test("withBriefingDeadline normalizes arbitrary caller cancellation to AbortError", async () => {
  const controller = new AbortController();
  const pending = withBriefingDeadline(
    () => Promise.withResolvers<never>().promise,
    controller.signal,
  );
  controller.abort(new Error("synthetic caller cancellation"));

  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AbortError");
    return true;
  });
});
