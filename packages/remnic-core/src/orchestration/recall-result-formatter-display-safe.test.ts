import test from "node:test";
import assert from "node:assert/strict";
import { displaySafeRecallSnapshot } from "./recall-result-formatter.js";

test("displaySafeRecallSnapshot relativizes result, budget, and tier-anchor paths without mutating input (#2077)", () => {
  const memoryDir = "/srv/memory";
  const nsAnchorAbs = `${memoryDir}/namespaces/ns-616c706861/facts/2026-07-19/a.md`;
  const flatAbs = `${memoryDir}/facts/2026-07-19/b.md`;
  const snapshot = {
    resultPaths: [flatAbs],
    resultNamespaces: [undefined],
    budgetsApplied: {
      includedMemoryPaths: [flatAbs],
      includedMemoryNamespaces: [undefined],
    },
    tierExplain: {
      tier: "direct-answer",
      tierReason: "single high-confidence hit",
      filteredBy: [],
      candidatesConsidered: 1,
      latencyMs: 1,
      sourceAnchors: [
        { path: nsAnchorAbs, lineRange: [1, 2] as [number, number] },
        { path: flatAbs },
      ],
    },
  };

  const safe = displaySafeRecallSnapshot(snapshot, memoryDir);

  assert.deepEqual(safe.resultPaths, ["facts/2026-07-19/b.md"]);
  assert.deepEqual(safe.budgetsApplied.includedMemoryPaths, ["facts/2026-07-19/b.md"]);
  // Anchors are rendered memoryDir-relative — no absolute operator path, and the
  // TRUE on-disk storage segment (never a decoded guess that could mislabel a
  // token-shaped or catalog-owned namespace whose owner the anchor does not carry).
  assert.deepEqual(safe.tierExplain.sourceAnchors, [
    { path: "namespaces/ns-616c706861/facts/2026-07-19/a.md", lineRange: [1, 2] },
    { path: "facts/2026-07-19/b.md" },
  ]);

  // The input snapshot must not be mutated — the live cache keeps absolute paths.
  assert.equal(snapshot.tierExplain.sourceAnchors[0].path, nsAnchorAbs);
  assert.equal(snapshot.resultPaths[0], flatAbs);
});
