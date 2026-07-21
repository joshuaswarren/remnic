import test from "node:test";
import assert from "node:assert/strict";
import { displaySafeRecallSnapshot } from "./recall-result-formatter.js";

test("displaySafeRecallSnapshot relativizes result, budget, and tier-anchor paths without mutating input (#2077)", () => {
  const memoryDir = "/srv/memory";
  const flatAbs = `${memoryDir}/facts/2026-07-19/b.md`;
  const nsResultAbs = `${memoryDir}/namespaces/tok-team/facts/2026-07-19/r.md`;
  // An anchor that is NOT among the returned results — no authoritative owner.
  const unmatchedAnchorAbs = `${memoryDir}/namespaces/ns-616c706861/facts/2026-07-19/a.md`;
  const snapshot = {
    resultPaths: [flatAbs, nsResultAbs],
    resultNamespaces: [undefined, "team-alpha"],
    budgetsApplied: {
      includedMemoryPaths: [flatAbs, nsResultAbs],
      includedMemoryNamespaces: [undefined, "team-alpha"],
    },
    tierExplain: {
      tier: "direct-answer",
      tierReason: "single high-confidence hit",
      filteredBy: [],
      candidatesConsidered: 2,
      latencyMs: 1,
      sourceAnchors: [
        { path: nsResultAbs, lineRange: [1, 2] as [number, number] },
        { path: unmatchedAnchorAbs },
        { path: flatAbs },
      ],
    },
  };

  const safe = displaySafeRecallSnapshot(snapshot, memoryDir);

  assert.deepEqual(safe.resultPaths, ["facts/2026-07-19/b.md", "team-alpha/facts/2026-07-19/r.md"]);
  assert.deepEqual(safe.budgetsApplied.includedMemoryPaths, [
    "facts/2026-07-19/b.md",
    "team-alpha/facts/2026-07-19/r.md",
  ]);
  assert.deepEqual(safe.tierExplain.sourceAnchors, [
    // Anchor coincides with a namespaced result → reuses its authoritative namespace.
    { path: "team-alpha/facts/2026-07-19/r.md", lineRange: [1, 2] },
    // Anchor not among the results → truthful storage-relative segment, never a decode.
    { path: "namespaces/ns-616c706861/facts/2026-07-19/a.md" },
    // Anchor coincides with a default-namespace result → memoryDir-relative.
    { path: "facts/2026-07-19/b.md" },
  ]);

  // The input snapshot must not be mutated — the live cache keeps absolute paths.
  assert.equal(snapshot.tierExplain.sourceAnchors[0].path, nsResultAbs);
  assert.equal(snapshot.resultPaths[1], nsResultAbs);
});
