import test from "node:test";
import assert from "node:assert/strict";
import { displaySafeRecallSnapshot } from "./recall-result-formatter.js";
import { namespaceIdentityToken } from "../namespaces/identity.js";
import type { PluginConfig } from "../types.js";

test("displaySafeRecallSnapshot relativizes result, budget, and tier-anchor paths without mutating input (#2077)", () => {
  const memoryDir = "/srv/memory";
  // A namespace stored under its encoded identity token…
  const encodedToken = namespaceIdentityToken("team-alpha");
  const encodedAnchorAbs = `${memoryDir}/namespaces/${encodedToken}/facts/2026-07-19/a.md`;
  // …and a namespace whose LITERAL name is itself token-shaped and is preserved
  // raw on disk (ns-616c706861 would otherwise decode to "alpha").
  const rawTokenNs = "ns-616c706861";
  const rawAnchorAbs = `${memoryDir}/namespaces/${rawTokenNs}/facts/2026-07-19/c.md`;
  const flatAbs = `${memoryDir}/facts/2026-07-19/b.md`;

  const config = {
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "team-alpha", readPrincipals: ["*"], writePrincipals: ["*"] },
      { name: rawTokenNs, readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
  } as unknown as PluginConfig;

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
        { path: encodedAnchorAbs, lineRange: [1, 2] as [number, number] },
        { path: rawAnchorAbs },
        { path: flatAbs },
      ],
    },
  };

  const safe = displaySafeRecallSnapshot(snapshot, config);

  assert.deepEqual(safe.resultPaths, ["facts/2026-07-19/b.md"]);
  assert.deepEqual(safe.budgetsApplied.includedMemoryPaths, ["facts/2026-07-19/b.md"]);
  assert.deepEqual(safe.tierExplain.sourceAnchors, [
    // An encoded token resolves back to the real namespace name.
    { path: "team-alpha/facts/2026-07-19/a.md", lineRange: [1, 2] },
    // A token-shaped LITERAL namespace name is preserved, never decoded to "alpha".
    { path: "ns-616c706861/facts/2026-07-19/c.md" },
    // A flat default-namespace anchor stays memoryDir-relative.
    { path: "facts/2026-07-19/b.md" },
  ]);

  // The input snapshot must not be mutated — the live cache keeps absolute paths.
  assert.equal(snapshot.tierExplain.sourceAnchors[0].path, encodedAnchorAbs);
  assert.equal(snapshot.resultPaths[0], flatAbs);
});
