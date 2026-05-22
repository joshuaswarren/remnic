import assert from "node:assert/strict";
import test from "node:test";

import { benchmarkRoute, formatRunPrimaryDelta, formatRunPrimaryScore } from "./RunTable";

test("RunTable formats raw-count primary metrics with metric context", () => {
  const run = {
    primaryMetric: "commands_count",
    primaryScore: 1,
    delta: -2,
  };

  assert.equal(formatRunPrimaryScore(run), "1");
  assert.equal(formatRunPrimaryDelta(run), "-2");
});

test("RunTable keeps percentage formatting for normalized primary metrics", () => {
  const run = {
    primaryMetric: "accuracy",
    primaryScore: 0.75,
    delta: 0.1,
  };

  assert.equal(formatRunPrimaryScore(run), "75.0%");
  assert.equal(formatRunPrimaryDelta(run), "+10.0%");
});

test("benchmarkRoute encodes benchmark IDs as a single route segment", () => {
  assert.equal(
    benchmarkRoute("suite/foo?x=1#frag"),
    "/benchmark/suite%2Ffoo%3Fx%3D1%23frag",
  );
});
