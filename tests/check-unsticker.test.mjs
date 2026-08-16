import assert from "node:assert/strict";
import test from "node:test";
import { planGuardReruns } from "../scripts/check-unsticker.mjs";

const run = (createdAt, conclusion, status = "completed", id = createdAt) => ({
  id,
  created_at: createdAt,
  status,
  conclusion,
});

test("green guard exits without a rerun or thread lookup", () => {
  const runs = [run("2026-08-16T00:00:00Z", "failure"), run("2026-08-16T00:05:00Z", "success")];
  assert.deepEqual(planGuardReruns(runs, 0), []);
});

test("failed guard with resolved threads reruns failed suites", () => {
  const runs = [
    run("2026-08-16T00:00:00Z", "failure", "completed", 1),
    run("2026-08-16T00:05:00Z", "failure", "completed", 2),
  ];
  assert.deepEqual(
    planGuardReruns(runs, 0).map((candidate) => candidate.id),
    [1, 2]
  );
});

test("failed guard with open threads does not rerun", () => {
  const runs = [run("2026-08-16T00:05:00Z", "failure", "completed", 1)];
  assert.deepEqual(planGuardReruns(runs, 2), []);
});

test("an active latest guard run does not rerun an older failure", () => {
  const runs = [run("2026-08-16T00:00:00Z", "failure"), run("2026-08-16T00:05:00Z", "", "in_progress")];
  assert.deepEqual(planGuardReruns(runs, 0), []);
});
