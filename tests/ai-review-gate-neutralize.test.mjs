import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newerRunExists,
  supersededGateRuns,
} from "../scripts/ai-review-gate-neutralize.mjs";

const success = {
  id: 2,
  conclusion: "success",
  status: "completed",
  run_started_at: "2026-08-17T19:20:00Z",
};

test("clears an older same-head failure after a newer success", () => {
  const olderFail = {
    id: 1,
    conclusion: "failure",
    status: "completed",
    run_started_at: "2026-08-17T19:10:00Z",
  };
  const cleared = supersededGateRuns(success, [olderFail, success]);
  assert.deepEqual(cleared.map((run) => run.id), [1]);
});

test("clears an older cancelled suite after a newer success", () => {
  const olderCancel = {
    id: 1,
    conclusion: "cancelled",
    status: "completed",
    run_started_at: "2026-08-17T19:10:00Z",
  };
  const cleared = supersededGateRuns(success, [olderCancel, success]);
  assert.deepEqual(cleared.map((run) => run.id), [1]);
});

test("does not clear a newer failure", () => {
  const newerFail = {
    id: 3,
    conclusion: "failure",
    status: "completed",
    run_started_at: "2026-08-17T19:30:00Z",
  };
  assert.equal(newerRunExists(success, [success, newerFail]), true);
  assert.deepEqual(supersededGateRuns(success, [success, newerFail]), []);
});
