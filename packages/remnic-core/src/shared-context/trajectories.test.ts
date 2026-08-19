import assert from "node:assert/strict";
import { test } from "node:test";

import { publishTrajectory } from "./trajectories.js";

test("publishTrajectory defaults to review and lands pending_review", () => {
  const result = publishTrajectory({
    trajectoryId: "traj-1",
    summary: "ran the check",
  });
  assert.deepEqual(result, {
    ok: true,
    status: "pending_review",
    trajectoryId: "traj-1",
    summary: "ran the check",
  });
});

test("publishTrajectory review mode lands pending_review", () => {
  const result = publishTrajectory({
    mode: "review",
    trajectoryId: "traj-1",
    summary: "ran the check",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "pending_review");
});

test("publishTrajectory auto mode lands active", () => {
  const result = publishTrajectory({
    mode: "auto",
    trajectoryId: "traj-1",
    summary: "ran the check",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "active");
});

test("publishTrajectory off mode returns disabled", () => {
  assert.deepEqual(
    publishTrajectory({
      mode: "off",
      trajectoryId: "traj-1",
      summary: "ran the check",
    }),
    { ok: false, error: "disabled" },
  );
});

test("publishTrajectory rejects an unknown mode", () => {
  assert.deepEqual(
    publishTrajectory({
      mode: "publish",
      trajectoryId: "traj-1",
      summary: "ran the check",
    }),
    { ok: false, error: "unknown_mode" },
  );
});

test("publishTrajectory keeps the summary string and strips tool output", () => {
  const dirty = {
    mode: "auto",
    trajectoryId: "traj-1",
    summary: "ran the check",
    toolOutput: "stdout: secret fixture dump",
  };
  const result = publishTrajectory(dirty);
  assert.deepEqual(result, {
    ok: true,
    status: "active",
    trajectoryId: "traj-1",
    summary: "ran the check",
  });
  assert.equal(JSON.stringify(result).includes("stdout"), false);
  assert.equal("toolOutput" in result, false);
});
