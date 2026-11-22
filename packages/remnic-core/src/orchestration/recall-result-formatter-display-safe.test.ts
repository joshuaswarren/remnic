import test from "node:test";
import assert from "node:assert/strict";
import { displaySafeRecallSnapshot } from "./recall-result-formatter.js";

test("displaySafeRecallSnapshot relativizes included-memory and tier-anchor paths without mutating input (#2077)", () => {
  const memoryDir = "/srv/memory";
  const flatAbs = `${memoryDir}/facts/2026-07-19/b.md`;
  const nsResultAbs = `${memoryDir}/namespaces/tok-team/facts/2026-07-19/r.md`;
  const unmatchedAnchorAbs = `${memoryDir}/namespaces/ns-616c706861/facts/2026-07-19/a.md`;
  const snapshot = {
    includedMemories: [
      { id: "mem-b", path: flatAbs },
      { id: "mem-r", path: nsResultAbs, namespace: "team-alpha" },
    ],
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

  assert.deepEqual(safe.includedMemories, [
    { id: "mem-b", path: "facts/2026-07-19/b.md" },
    { id: "mem-r", path: "team-alpha/facts/2026-07-19/r.md", namespace: "team-alpha" },
  ]);
  assert.deepEqual(safe.tierExplain.sourceAnchors, [
    { path: "team-alpha/facts/2026-07-19/r.md", lineRange: [1, 2] },
    { path: "namespaces/ns-616c706861/facts/2026-07-19/a.md" },
    { path: "facts/2026-07-19/b.md" },
  ]);

  assert.equal(snapshot.tierExplain.sourceAnchors[0].path, nsResultAbs);
  assert.equal(snapshot.includedMemories[1].path, nsResultAbs);
});
