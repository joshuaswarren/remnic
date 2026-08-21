import test from "node:test";
import assert from "node:assert/strict";
import { computeArtifactCandidateFetchLimit, computeArtifactRecallLimit } from "../src/orchestrator.ts";

test("artifact recall limit is capped in minimal mode", () => {
  assert.equal(computeArtifactRecallLimit("minimal", 1, 5), 1);
  assert.equal(computeArtifactRecallLimit("minimal", 0, 5), 0);
  assert.equal(computeArtifactRecallLimit("minimal", 3, 2), 2);
});

test("artifact recall limit is unchanged outside minimal mode", () => {
  assert.equal(computeArtifactRecallLimit("full", 1, 5), 5);
  assert.equal(computeArtifactRecallLimit("graph_mode", 2, 4), 4);
  assert.equal(computeArtifactRecallLimit("no_recall", 0, 5), 0);
  assert.equal(computeArtifactRecallLimit("full", 0, 5), 0);
  assert.equal(computeArtifactRecallLimit("graph_mode", 0, 4), 0);
});

test("artifact candidate fetch limit uses bounded headroom", () => {
  assert.equal(computeArtifactCandidateFetchLimit(0), 0);
  assert.equal(computeArtifactCandidateFetchLimit(1), 9);
  assert.equal(computeArtifactCandidateFetchLimit(5), 25);
  assert.equal(computeArtifactCandidateFetchLimit(100), 200);
});
