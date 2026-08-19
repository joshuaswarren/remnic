import assert from "node:assert/strict";
import test from "node:test";

import { DEEP_RECALL_FRONTIER_CAP, rankDeepRecallFrontier } from "./recall-deep-frontier.js";

test("empty input returns empty", () => {
  assert.deepEqual(rankDeepRecallFrontier([]), []);
});

test("blank nodeIds and counts below 1 are dropped", () => {
  const result = rankDeepRecallFrontier([
    { nodeId: "", sharedAnchorCount: 3 },
    { nodeId: "   ", sharedAnchorCount: 3 },
    { nodeId: "a", sharedAnchorCount: 0 },
    { nodeId: "b", sharedAnchorCount: -2 },
    { nodeId: "c", sharedAnchorCount: 1 },
  ]);
  assert.deepEqual(result, [{ nodeId: "c", sharedAnchorCount: 1 }]);
});

test("NaN and infinite counts are dropped", () => {
  const result = rankDeepRecallFrontier([
    { nodeId: "a", sharedAnchorCount: Number.NaN },
    { nodeId: "b", sharedAnchorCount: Number.POSITIVE_INFINITY },
    { nodeId: "c", sharedAnchorCount: 2 },
  ]);
  assert.deepEqual(result, [{ nodeId: "c", sharedAnchorCount: 2 }]);
});

test("dedup by nodeId keeps the higher count, first on tie", () => {
  const result = rankDeepRecallFrontier([
    { nodeId: "a", sharedAnchorCount: 2 },
    { nodeId: "a", sharedAnchorCount: 5 },
    { nodeId: "b", sharedAnchorCount: 4 },
    { nodeId: "b", sharedAnchorCount: 4 },
  ]);
  assert.deepEqual(result, [
    { nodeId: "a", sharedAnchorCount: 5 },
    { nodeId: "b", sharedAnchorCount: 4 },
  ]);
});

test("sorts by count desc then nodeId asc", () => {
  const result = rankDeepRecallFrontier([
    { nodeId: "c", sharedAnchorCount: 3 },
    { nodeId: "a", sharedAnchorCount: 3 },
    { nodeId: "b", sharedAnchorCount: 9 },
    { nodeId: "d", sharedAnchorCount: 1 },
  ]);
  assert.deepEqual(
    result.map((candidate) => candidate.nodeId),
    ["b", "a", "c", "d"],
  );
});

test("caps at 20 keeping the top 20 of 21", () => {
  const candidates = Array.from({ length: 21 }, (_, i) => ({
    nodeId: `n${String(i).padStart(2, "0")}`,
    sharedAnchorCount: i + 1,
  }));
  const result = rankDeepRecallFrontier(candidates);
  assert.equal(result.length, DEEP_RECALL_FRONTIER_CAP);
  assert.equal(result[0]?.nodeId, "n20");
  assert.equal(result.at(-1)?.nodeId, "n01");
  assert.ok(!result.some((candidate) => candidate.nodeId === "n00"));
});

test("does not mutate the input array or its objects", () => {
  const input = [
    { nodeId: " b ", sharedAnchorCount: 2 },
    { nodeId: "a", sharedAnchorCount: 1 },
  ];
  const snapshot = structuredClone(input);
  rankDeepRecallFrontier(input);
  assert.deepEqual(input, snapshot);
});

test("two calls on the same input are deep-equal", () => {
  const input = [
    { nodeId: "a", sharedAnchorCount: 2 },
    { nodeId: "b", sharedAnchorCount: 2 },
    { nodeId: "a", sharedAnchorCount: 7 },
  ];
  assert.deepEqual(rankDeepRecallFrontier(input), rankDeepRecallFrontier(input));
});
