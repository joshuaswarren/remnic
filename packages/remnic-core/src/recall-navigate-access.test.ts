import assert from "node:assert/strict";
import test from "node:test";

import { runRecallNavigateAccess } from "./recall-navigate-access.js";
import type { RecallNavNode } from "./recall-navigate.js";

function node(extra: Partial<RecallNavNode> = {}): RecallNavNode {
  return {
    id: "m1",
    disclosure: "chunk",
    ...extra,
  };
}

test("expand re-renders the next disclosure for the given nodeId", () => {
  const result = runRecallNavigateAccess({
    action: "expand",
    nodeId: "m1",
    budget: 10,
    node: node({ payloads: { section: "full section body" } }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.result, {
    status: "ok",
    node: { id: "m1", disclosure: "section", text: "full section body" },
  });
});

test("traverse returns typed neighbors for the given nodeId", () => {
  const result = runRecallNavigateAccess({
    action: "traverse",
    nodeId: "m1",
    budget: 10,
    linkType: "contradicts",
    node: node({
      links: [
        { targetId: "z-mem", linkType: "contradicts" },
        { targetId: "a-mem", linkType: "contradicts" },
        { targetId: "skip-me", linkType: "supports" },
      ],
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.result.status, "ok");
  if (result.result.status !== "ok") return;
  assert.ok("neighbors" in result.result);
  assert.deepEqual(
    result.result.neighbors.map((row) => row.id),
    ["a-mem", "z-mem"],
  );
});

test("budget 0 is exhausted before any expand or traverse", () => {
  const result = runRecallNavigateAccess({
    action: "expand",
    nodeId: "m1",
    budget: 0,
    node: node({ payloads: { section: "full section body" } }),
  });
  assert.deepEqual(result, { ok: false, error: "budget_exhausted" });
});

test("unknown action is rejected", () => {
  const result = runRecallNavigateAccess({
    action: "zoom",
    nodeId: "m1",
    budget: 10,
    node: node(),
  });
  assert.deepEqual(result, { ok: false, error: "unknown_action" });
});
