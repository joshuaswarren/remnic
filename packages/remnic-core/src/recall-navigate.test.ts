import assert from "node:assert/strict";
import test from "node:test";

import {
  expandRecallNode,
  traverseRecallLink,
  type RecallNavNode,
} from "./recall-navigate.js";

function node(extra: Partial<RecallNavNode> = {}): RecallNavNode {
  return {
    id: "m1",
    disclosure: "chunk",
    ...extra,
  };
}

test("expandRecallNode budget 0 is a no-op unavailable", () => {
  const source = node({
    payloads: { section: "full section body" },
  });
  const result = expandRecallNode(source, { budget: 0 });
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") {
    assert.equal(result.reason, "budget_off");
  }
  assert.equal("node" in result, false);
  assert.equal(source.disclosure, "chunk");
});

test("traverseRecallLink budget 0 is a no-op unavailable", () => {
  const result = traverseRecallLink(
    node({
      links: [{ targetId: "m2", linkType: "supports" }],
    }),
    "supports",
    { budget: 0 },
  );
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") {
    assert.equal(result.reason, "budget_off");
  }
  assert.equal("neighbors" in result, false);
});

test("unknown linkType throws", () => {
  assert.throws(
    () => traverseRecallLink(node({ links: [] }), "related", { budget: 10 }),
    /unknown recall nav linkType/,
  );
});

test("traverseRecallLink returns neighbors in deterministic targetId order", () => {
  const result = traverseRecallLink(
    node({
      links: [
        { targetId: "z-mem", linkType: "contradicts" },
        { targetId: "a-mem", linkType: "contradicts" },
        { targetId: "m-mem", linkType: "contradicts" },
        { targetId: "skip-me", linkType: "supports" },
      ],
    }),
    "contradicts",
    { budget: 100 },
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.neighbors.map((row) => row.id),
    ["a-mem", "m-mem", "z-mem"],
  );
});

test("no matching links is empty, not unavailable", () => {
  const result = traverseRecallLink(
    node({
      links: [{ targetId: "x", linkType: "supports" }],
    }),
    "contradicts",
    { budget: 10 },
  );
  assert.equal(result.status, "empty");
  assert.equal("neighbors" in result, false);
});
