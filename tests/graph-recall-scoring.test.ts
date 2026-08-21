import test from "node:test";
import assert from "node:assert/strict";
import { blendGraphExpandedRecallScore, filterRecallCandidates } from "../src/orchestrator.ts";

test("blendGraphExpandedRecallScore is monotonic for higher graph activation scores", () => {
  const low = blendGraphExpandedRecallScore({
    graphActivationScore: 0.1,
    seedRecallScore: 0.6,
    activationWeight: 0.7,
    blendMin: 0.05,
    blendMax: 0.95,
  });
  const mid = blendGraphExpandedRecallScore({
    graphActivationScore: 0.8,
    seedRecallScore: 0.6,
    activationWeight: 0.7,
    blendMin: 0.05,
    blendMax: 0.95,
  });
  const high = blendGraphExpandedRecallScore({
    graphActivationScore: 5,
    seedRecallScore: 0.6,
    activationWeight: 0.7,
    blendMin: 0.05,
    blendMax: 0.95,
  });

  assert.equal(low < mid, true);
  assert.equal(mid < high, true);
});

test("blendGraphExpandedRecallScore clamps to configured bounds", () => {
  const clamped = blendGraphExpandedRecallScore({
    graphActivationScore: 10,
    seedRecallScore: 1,
    activationWeight: 1,
    blendMin: 0.2,
    blendMax: 0.4,
  });
  assert.equal(clamped, 0.4);

  const swappedBounds = blendGraphExpandedRecallScore({
    graphActivationScore: 0,
    seedRecallScore: 0,
    activationWeight: 1,
    blendMin: 0.9,
    blendMax: 0.2,
  });
  assert.equal(swappedBounds, 0.2);
});

test("filterRecallCandidates applies artifact/path filtering before cap", () => {
  const candidates = [
    { docid: "1", path: "/mem/artifacts/a.md", snippet: "a", score: 0.99 },
    { docid: "2", path: "/mem/facts/a.md", snippet: "b", score: 0.90 },
    { docid: "3", path: "/mem/facts/b.md", snippet: "c", score: 0.80 },
    { docid: "4", path: "/mem/facts/c.md", snippet: "d", score: 0.70 },
  ];

  const filtered = filterRecallCandidates(candidates as any, {
    namespacesEnabled: true,
    recallNamespaces: ["default"],
    resolveNamespace: () => "default",
    limit: 2,
  });

  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered.map((item) => item.path),
    ["/mem/facts/a.md", "/mem/facts/b.md"],
  );
});
