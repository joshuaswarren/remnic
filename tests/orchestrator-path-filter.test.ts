import test from "node:test";
import assert from "node:assert/strict";
import {
  computeQmdHybridFetchLimit,
  filterRecallCandidates,
  isArtifactMemoryPath,
  lifecycleRecallScoreAdjustment,
  mergeArtifactRecallCandidates,
  shouldFilterLifecycleRecallCandidate,
} from "../src/orchestrator.ts";
import {
  isActivityDigestPath,
  isGenericRecallExcludedPath,
} from "../packages/remnic-core/src/orchestration/orchestrator-helpers.ts";

test("isArtifactMemoryPath matches artifact directory paths", () => {
  assert.equal(isArtifactMemoryPath("/tmp/memory/artifacts/2026-02-21/a.md"), true);
  assert.equal(isArtifactMemoryPath("C:\\memory\\artifacts\\2026-02-21\\a.md"), true);
});

test("isArtifactMemoryPath does not match non-artifact paths", () => {
  assert.equal(isArtifactMemoryPath("/tmp/memory/facts/2026-02-21/a.md"), false);
  assert.equal(isArtifactMemoryPath("/tmp/memory/my-artifacts-note.md"), false);
});

test("isActivityDigestPath matches only the digest file shape", () => {
  assert.equal(isActivityDigestPath("/tmp/memory/activity/2026-07-22.md"), true);
  assert.equal(isActivityDigestPath("C:\\memory\\activity\\2026-07-22.md"), true);
  // A memoryDir that merely contains an `activity` segment must NOT be excluded,
  // or recall would be disabled for every ordinary memory under it.
  assert.equal(isActivityDigestPath("/data/activity/remnic/facts/2026-07-22/a.md"), false);
  assert.equal(isActivityDigestPath("/tmp/memory/activity/notes.md"), false);
  assert.equal(isActivityDigestPath("/tmp/memory/my-activity-note.md"), false);
});

test("isGenericRecallExcludedPath covers artifacts and activity digests only", () => {
  assert.equal(isGenericRecallExcludedPath("/tmp/memory/artifacts/2026-02-21/a.md"), true);
  assert.equal(isGenericRecallExcludedPath("/tmp/memory/activity/2026-07-22.md"), true);
  assert.equal(isGenericRecallExcludedPath("/data/activity/remnic/facts/a.md"), false);
  assert.equal(isGenericRecallExcludedPath("/tmp/memory/facts/a.md"), false);
});

test("filterRecallCandidates applies namespace/artifact filters before final cap", () => {
  const candidates = [
    { path: "/tmp/memory/artifacts/2026-02-21/a.md", score: 0.99 },
    { path: "/tmp/memory/ns-other/facts/1.md", score: 0.98 },
    { path: "/tmp/memory/ns-main/facts/2.md", score: 0.97 },
    { path: "/tmp/memory/ns-main/facts/3.md", score: 0.96 },
  ];

  const filtered = filterRecallCandidates(candidates, {
    namespacesEnabled: true,
    recallNamespaces: ["ns-main"],
    resolveNamespace: (p) => (p.includes("/ns-main/") ? "ns-main" : "ns-other"),
    limit: 1,
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.path, "/tmp/memory/ns-main/facts/2.md");
});

test("computeQmdHybridFetchLimit overscans only when artifacts are enabled", () => {
  assert.equal(computeQmdHybridFetchLimit(8, false, 5), 8);
  assert.equal(computeQmdHybridFetchLimit(8, true, 5), 48);
  assert.equal(computeQmdHybridFetchLimit(0, true, 5), 0);
});

test("artifact filtering is applied before QMD cap", () => {
  const qmdCandidates = [
    { path: "/tmp/memory/artifacts/2026-02-21/a.md", score: 1.0 },
    { path: "/tmp/memory/artifacts/2026-02-21/b.md", score: 0.99 },
    { path: "/tmp/memory/facts/3.md", score: 0.98 },
    { path: "/tmp/memory/facts/4.md", score: 0.97 },
  ];

  const filtered = filterRecallCandidates(qmdCandidates, {
    namespacesEnabled: false,
    recallNamespaces: [],
    resolveNamespace: () => "",
    limit: 2,
  });

  assert.deepEqual(
    filtered.map((r) => r.path),
    ["/tmp/memory/facts/3.md", "/tmp/memory/facts/4.md"],
  );
});

test("mergeArtifactRecallCandidates round-robins namespace lists", () => {
  const mk = (id: string, content: string) => ({
    path: `/tmp/memory/artifacts/${id}.md`,
    content,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-21T00:00:00.000Z",
      updated: "2026-02-21T00:00:00.000Z",
      source: "artifact",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
  });

  const merged = mergeArtifactRecallCandidates(
    [
      [mk("ns1-a", "a1"), mk("ns1-b", "b1")],
      [mk("ns2-a", "a2"), mk("ns2-b", "b2")],
    ],
    4,
  );

  assert.deepEqual(
    merged.map((m) => m.frontmatter.id),
    ["ns1-a", "ns2-a", "ns1-b", "ns2-b"],
  );
});

test("mergeArtifactRecallCandidates continues past duplicate-only offsets", () => {
  const mk = (id: string, content: string) => ({
    path: `/tmp/memory/artifacts/${id}.md`,
    content,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-21T00:00:00.000Z",
      updated: "2026-02-21T00:00:00.000Z",
      source: "artifact",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
  });

  const x = mk("x", "same");
  const y = mk("y", "y");
  const z = mk("z", "z");

  const merged = mergeArtifactRecallCandidates(
    [
      [x],
      [y, x, z],
    ],
    3,
  );

  assert.deepEqual(
    merged.map((m) => m.frontmatter.id),
    ["x", "y", "z"],
  );
});

function baseFrontmatter() {
  return {
    id: "fact-lifecycle-recall",
    category: "fact" as const,
    created: "2026-02-21T00:00:00.000Z",
    updated: "2026-02-21T00:00:00.000Z",
    source: "extraction",
    confidence: 0.8,
    confidenceTier: "implied" as const,
    tags: [],
    status: "active" as const,
  };
}

test("lifecycleRecallScoreAdjustment fail-opens for legacy memories", () => {
  const adjustment = lifecycleRecallScoreAdjustment(baseFrontmatter(), {
    lifecyclePolicyEnabled: true,
  });
  assert.equal(adjustment, 0);
});

test("lifecycleRecallScoreAdjustment applies active/validated boosts and disputed penalty", () => {
  const activeBoost = lifecycleRecallScoreAdjustment(
    {
      ...baseFrontmatter(),
      lifecycleState: "active",
      verificationState: "user_confirmed",
    },
    { lifecyclePolicyEnabled: true },
  );
  const validatedBoost = lifecycleRecallScoreAdjustment(
    {
      ...baseFrontmatter(),
      lifecycleState: "validated",
      verificationState: "system_inferred",
    },
    { lifecyclePolicyEnabled: true },
  );
  const disputedPenalty = lifecycleRecallScoreAdjustment(
    {
      ...baseFrontmatter(),
      lifecycleState: "validated",
      verificationState: "disputed",
    },
    { lifecyclePolicyEnabled: true },
  );

  assert.equal(activeBoost > validatedBoost, true);
  assert.equal(disputedPenalty < 0, true);
});

test("shouldFilterLifecycleRecallCandidate only filters stale/archived when explicitly enabled", () => {
  const stale = {
    ...baseFrontmatter(),
    lifecycleState: "stale" as const,
  };
  const archived = {
    ...baseFrontmatter(),
    lifecycleState: "archived" as const,
    status: "archived" as const,
  };

  assert.equal(
    shouldFilterLifecycleRecallCandidate(stale, {
      lifecyclePolicyEnabled: true,
      lifecycleFilterStaleEnabled: true,
    }),
    true,
  );
  assert.equal(
    shouldFilterLifecycleRecallCandidate(archived, {
      lifecyclePolicyEnabled: true,
      lifecycleFilterStaleEnabled: true,
    }),
    true,
  );
  assert.equal(
    shouldFilterLifecycleRecallCandidate(stale, {
      lifecyclePolicyEnabled: true,
      lifecycleFilterStaleEnabled: false,
    }),
    false,
  );
  assert.equal(
    shouldFilterLifecycleRecallCandidate(baseFrontmatter(), {
      lifecyclePolicyEnabled: true,
      lifecycleFilterStaleEnabled: true,
    }),
    false,
  );
});
