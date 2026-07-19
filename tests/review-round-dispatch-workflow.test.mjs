import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

// Non-goal (issue #1992): the transactional-round work must NOT change the
// review-thread-guard's missing concurrency group. check-unsticker reruns EVERY
// failed guard suite in one sweep and a concurrency group would cancel
// intermediate reruns (documented codex P1). These tests fail if a later change
// regresses that invariant or the sweeper's guard-rerun path.

test("review-thread-guard has no concurrency group (check-unsticker depends on it)", () => {
  const guard = read(".github/workflows/review-thread-guard.yml");
  assert.doesNotMatch(guard, /^\s*concurrency:/m, "guard must not declare a concurrency group");
  assert.match(guard, /Intentionally NO concurrency group/);
});

test("check-unsticker still reruns failed review-thread-guard suites", () => {
  const unsticker = read(".github/workflows/check-unsticker.yml");
  assert.match(unsticker, /runsFor\('review-thread-guard\.yml'/);
  assert.match(unsticker, /reRunWorkflow/);
  assert.match(unsticker, /conclusion === 'failure'/);
});

test("the round-dispatch workflow uses its own concurrency namespace and never force-cancels", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  // Its own per-PR group (separate from the guard's namespace) coalesces and
  // never force-cancels, so it cannot cancel guard reruns.
  assert.match(dispatch, /group:\s*review-round-dispatch-/);
  assert.match(dispatch, /cancel-in-progress:\s*false/);
});
test("the round-dispatch workflow imports the tested driver rather than inlining logic", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  assert.match(dispatch, /scripts\/review-round-gate\.mjs/);
  assert.match(dispatch, /runRoundGate/);
});

test("the round gate is non-blocking: the driver never fails a check", () => {
  const driver = read("scripts/review-round-gate.mjs");
  assert.doesNotMatch(driver, /setFailed/, "shadow gate must never setFailed");
});

test("the round-dispatch workflow shadows dispatch by default (enforcement flip is PR3)", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  assert.match(dispatch, /REVIEW_ROUND_ENFORCE:\s*'false'/);
});
