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

test("the round-dispatch job only runs for PR-relevant events (no repo-wide no-op runs)", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  // A repo-wide check_run completion or a standalone-issue comment must not
  // spin up a no-op run (cursor): the job if gates on an associated PR.
  assert.match(dispatch, /github\.event\.check_run\.pull_requests\[0\] != null/);
  assert.match(dispatch, /github\.event\.issue\.pull_request != null/);
  assert.match(dispatch, /github\.event\.pull_request\.draft == false/);
});

test("the write-scoped gate runs PR-ref code only for trusted same-repo PRs", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  // The pull_request family is the only path that checks out PR-HEAD code, so it
  // is gated to same-repo (trusted) PRs; fork PRs never execute checked-out code
  // with the write token (issue #1992 security).
  assert.match(dispatch, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
});
test("the round-dispatch workflow imports the tested driver rather than inlining logic", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  assert.match(dispatch, /scripts\/review-round-gate\.mjs/);
  assert.match(dispatch, /runRoundGate/);
});

test("the round gate is non-blocking: the driver never fails a check", () => {
  // Static guard; the behavioral companion (a throwing github client that must
  // not propagate out of runRoundGate) lives in tests/review-round-gate.test.mjs.
  const driver = read("scripts/review-round-gate.mjs");
  assert.doesNotMatch(driver, /setFailed/, "shadow gate must never setFailed");
});

test("the round-dispatch workflow also wakes on check-run completion", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  // A bot completing only a check run must wake the gate (issue #1992 P2), not
  // just push/comment/review events. GitHub Actions has no
  // pull_request_review_thread trigger, so it must NOT be declared.
  assert.match(dispatch, /^\s*check_run:\s*\n\s*types:\s*\[completed\]/m);
  assert.doesNotMatch(dispatch, /^\s*pull_request_review_thread:/m);
});

test("the round-dispatch workflow wakes on top-level PR comments and has Checks read", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  // Top-level bot verdicts (issue_comment) must wake the gate, and
  // checks.listForRef needs the Checks read permission (issue #1992).
  assert.match(dispatch, /^\s*issue_comment:\s*\n\s*types:\s*\[created, edited\]/m);
  assert.match(dispatch, /^\s*checks:\s*read/m);
});

test("the round-dispatch workflow keeps least-privilege token scopes", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  // The gate only writes issue comments/labels and READS PR data, so
  // pull-requests stays read-only to shrink the github-script blast radius
  // (issue #1992 P1 hardening).
  assert.match(dispatch, /^\s*pull-requests:\s*read/m);
  assert.doesNotMatch(dispatch, /^\s*pull-requests:\s*write/m);
});

test("the round-dispatch workflow shadows dispatch by default (enforcement flip is PR3)", () => {
  const dispatch = read(".github/workflows/review-round-dispatch.yml");
  assert.match(dispatch, /REVIEW_ROUND_ENFORCE:\s*'false'/);
});
