import assert from "node:assert/strict";
import test from "node:test";

import { RemnicRequestTimeoutError } from "./client.js";
import { RecallTimeoutBreaker, isRecallTimeoutError } from "./recall-timeout-breaker.js";

test("isRecallTimeoutError accepts only typed client timeout errors", () => {
  assert.ok(isRecallTimeoutError(new RemnicRequestTimeoutError(30)));
  assert.ok(!isRecallTimeoutError(new Error("Remnic request timed out after 30ms")));
  assert.ok(!isRecallTimeoutError(new Error("Remnic request exceeded the 30ms budget before retry 1")));
  assert.ok(!isRecallTimeoutError(new Error("The socket connection was closed unexpectedly.")));
  assert.ok(!isRecallTimeoutError(new Error("Internal Server Error")));
});

test("rejects invalid threshold and window values", () => {
  assert.throws(() => new RecallTimeoutBreaker({ threshold: 0, window: 10 }), /positive integers/);
  assert.throws(() => new RecallTimeoutBreaker({ threshold: 2.5, window: 10 }), /positive integers/);
  assert.throws(() => new RecallTimeoutBreaker({ threshold: 11, window: 10 }), /threshold <= window/);
});

test("6 timeouts in a window of 10 do not trip the breaker", () => {
  const breaker = new RecallTimeoutBreaker({ threshold: 7, window: 10 });
  for (let i = 0; i < 6; i++) {
    assert.equal(breaker.record("timeout"), false, `timeout ${i + 1} should not trip`);
  }
  assert.equal(breaker.isTripped(), false);
  assert.equal(breaker.timeoutCount(), 6);
});

test("7 timeouts in a window of 10 trip the breaker", () => {
  const breaker = new RecallTimeoutBreaker({ threshold: 7, window: 10 });
  for (let i = 0; i < 6; i++) {
    breaker.record("timeout");
  }
  assert.equal(breaker.record("timeout"), true, "7th timeout should trip");
  assert.equal(breaker.isTripped(), true);
  assert.equal(breaker.timeoutCount(), 7);
});

test("sliding window ages out older timeouts", () => {
  const breaker = new RecallTimeoutBreaker({ threshold: 3, window: 4 });
  // Two timeouts followed by two successes: window is [T, T, S, S].
  breaker.record("timeout");
  breaker.record("timeout");
  breaker.record("success");
  breaker.record("success");
  // Two more timeouts replace the original two timeouts as the successes age them out.
  breaker.record("timeout"); // [T, S, S, T]
  breaker.record("timeout"); // [S, S, T, T]
  assert.equal(breaker.timeoutCount(), 2, "older timeouts aged out of the window");
  assert.equal(breaker.isTripped(), false);
  // The next timeout finally reaches the threshold.
  breaker.record("timeout"); // [S, T, T, T]
  assert.equal(breaker.isTripped(), true, "new timeouts refill the window");
});

test("permanent trip survives later successes", () => {
  const breaker = new RecallTimeoutBreaker({ threshold: 7, window: 10 });
  for (let i = 0; i < 7; i++) {
    breaker.record("timeout");
  }
  assert.equal(breaker.isTripped(), true);
  for (let i = 0; i < 20; i++) {
    assert.equal(breaker.record("success"), false, "post-trip records are ignored");
  }
  assert.equal(breaker.isTripped(), true);
  assert.equal(breaker.timeoutCount(), 7);
});

test("non-timeout failures age the window without counting toward the threshold", () => {
  const breaker = new RecallTimeoutBreaker({ threshold: 7, window: 10 });
  for (let i = 0; i < 6; i++) {
    breaker.record("timeout");
  }
  breaker.record("failure");
  assert.equal(breaker.timeoutCount(), 6);
  assert.equal(breaker.isTripped(), false);
  breaker.record("timeout");
  assert.equal(breaker.isTripped(), true);
});

test("trip aborts in-flight recall signals and never clears them", () => {
  const breaker = new RecallTimeoutBreaker({ threshold: 2, window: 2 });
  let aborted = false;
  breaker.signal.addEventListener("abort", () => {
    aborted = true;
  });
  breaker.record("timeout");
  assert.equal(aborted, false);
  breaker.record("timeout");
  assert.equal(aborted, true, "trip aborts active recall requests");
  assert.equal(breaker.signal.aborted, true);
  breaker.record("success");
  assert.equal(breaker.signal.aborted, true, "later results cannot re-enable recall");
});
