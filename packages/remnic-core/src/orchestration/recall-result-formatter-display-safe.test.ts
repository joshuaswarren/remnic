import test from "node:test";
import assert from "node:assert/strict";
import { displaySafeRecallSnapshot } from "./recall-result-formatter.js";

test("displaySafeRecallSnapshot relativizes included-memory and tier-anchor paths without mutating input (#2077)", () => {
  const memoryDir = "/srv/memory";
  const flatAbs = `${memoryDir}/facts/2026-07-19/b.md`;
  const nsResultAbs = `${memoryDir}/namespaces/tok-team/facts/2026-07-19/r.md`;
  // An anchor that is NOT among the included memories — no authoritative owner.
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
    // Anchor coincides with a namespaced included memory → reuses its authoritative namespace.
    { path: "team-alpha/facts/2026-07-19/r.md", lineRange: [1, 2] },
    // Anchor not among the included memories → truthful storage-relative segment, never a decode.
    { path: "namespaces/ns-616c706861/facts/2026-07-19/a.md" },
    // Anchor coincides with a default-namespace included memory → memoryDir-relative.
    { path: "facts/2026-07-19/b.md" },
  ]);

  // The input snapshot must not be mutated — the live cache keeps absolute paths.
  assert.equal(snapshot.tierExplain.sourceAnchors[0].path, nsResultAbs);
  assert.equal(snapshot.includedMemories[1].path, nsResultAbs);
});
