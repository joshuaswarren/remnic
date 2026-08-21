import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseConfig } from "../config.js";
import { listVersions, type VersionTrigger } from "../page-versioning.js";
import { applySemanticMergeAtPersist } from "../orchestration/semantic-merge-persist.js";
import type { ExtractionPersistDeps } from "../orchestration/extraction-persist-deps.js";
import type { StorageManager } from "../index.js";
import type {
  MemoryFile,
  MemoryFrontmatter,
  MemoryStatus,
  PluginConfig,
  ProvenanceSource,
} from "../types.js";
import {
  DEFAULT_SEMANTIC_MERGE_CANDIDATES,
  DEFAULT_SEMANTIC_MERGE_MIN,
  decideSemanticMerge,
  parseSemanticMergeConfig,
  type MergeCandidate,
  type MergeJudgeRawVerdict,
} from "./merge.js";
import type { SemanticDedupHit } from "./semantic.js";

// The merge snapshot trigger must stay a literal union: a widened
// `VersionTrigger` (e.g. annotated `readonly string[]`) would let an unknown
// trigger compile and then fail `readManifest` at runtime.
// @ts-expect-error "not-a-trigger" is not a VersionTrigger
const rejectedTrigger: VersionTrigger = "not-a-trigger";
void rejectedTrigger;

// ── Fixtures (synthetic; no real paths, hosts, or memory content) ─────────────

const INCOMING = "Deploys of the billing service run on Tuesdays at 09:00 UTC.";
const EXISTING = "Billing service deploys happen on Tuesdays.";
const MERGED = "Billing service deploys run on Tuesdays at 09:00 UTC.";

const MERGE_CONFIG = {
  enabled: true,
  minSimilarity: 0.8,
  maxCandidates: 3,
  categories: ["fact", "preference"],
  shadowMode: false,
} as const;

function hits(...scores: Array<[string, number]>): SemanticDedupHit[] {
  return scores.map(([id, score]) => ({ id, score }));
}

function candidateResolver(
  overrides: { category?: string; status?: string; content?: string } = {},
) {
  return async (memoryId: string) => ({
    content: overrides.content ?? `${EXISTING} (${memoryId})`,
    category: overrides.category ?? "fact",
    status: overrides.status ?? "active",
  });
}

const mergeJudge = async (input: {
  candidates: readonly MergeCandidate[];
}): Promise<MergeJudgeRawVerdict> => ({
  decision: "merge",
  targetId: input.candidates[0]?.memoryId ?? null,
  mergedContent: MERGED,
  reason: "same deploy cadence",
});

// ── Decision: band, gates, and backend-failure taxonomy ──────────────────────

test("decideSemanticMerge: only the [minSimilarity, dedupThreshold) band merges", async () => {
  for (const [score, expected] of [
    [0.79, "create"],
    [0.8, "merge"],
    [0.91, "merge"],
    [0.92, "create"],
    [0.99, "create"],
  ] as Array<[number, string]>) {
    const decision = await decideSemanticMerge({
      content: INCOMING,
      category: "fact",
      config: MERGE_CONFIG,
      dedupThreshold: 0.92,
      lookup: async () => hits(["mem-1", score]),
      resolveCandidate: candidateResolver(),
      judge: mergeJudge,
    });
    assert.equal(decision.action, expected, `score ${score}`);
  }
});

test("decideSemanticMerge: maxCandidates=0 short-circuits before any lookup", async () => {
  let lookups = 0;
  const decision = await decideSemanticMerge({
    content: INCOMING,
    category: "fact",
    config: { ...MERGE_CONFIG, maxCandidates: 0 },
    dedupThreshold: 0.92,
    lookup: async () => {
      lookups++;
      return hits(["mem-1", 0.85]);
    },
    resolveCandidate: candidateResolver(),
    judge: mergeJudge,
  });
  assert.equal(lookups, 0, "0 must disable merging without touching the backend");
  assert.deepEqual(decision, { action: "create", reason: "disabled" });
});

test("decideSemanticMerge: a lookup failure is backend_unavailable, not no_candidates", async () => {
  const decision = await decideSemanticMerge({
    content: INCOMING,
    category: "fact",
    config: MERGE_CONFIG,
    dedupThreshold: 0.92,
    lookup: async () => {
      throw new Error("embedding backend down");
    },
    resolveCandidate: candidateResolver(),
    judge: mergeJudge,
  });
  assert.deepEqual(decision, { action: "create", reason: "backend_unavailable" });
});

test("decideSemanticMerge: every non-active status is ineligible", async () => {
  const inactive: MemoryStatus[] = [
    "pending_review",
    "rejected",
    "quarantined",
    "superseded",
    "archived",
    "forgotten",
  ];
  for (const status of inactive) {
    const decision = await decideSemanticMerge({
      content: INCOMING,
      category: "fact",
      config: MERGE_CONFIG,
      dedupThreshold: 0.92,
      lookup: async () => hits(["mem-1", 0.85]),
      resolveCandidate: candidateResolver({ status }),
      judge: mergeJudge,
    });
    assert.deepEqual(decision, { action: "create", reason: "no_candidates" }, status);
  }
});

test("decideSemanticMerge: category gate and cross-category candidates create", async () => {
  const offCategory = await decideSemanticMerge({
    content: INCOMING,
    category: "moment",
    config: MERGE_CONFIG,
    dedupThreshold: 0.92,
    lookup: async () => hits(["mem-1", 0.85]),
    resolveCandidate: candidateResolver(),
    judge: mergeJudge,
  });
  assert.deepEqual(offCategory, { action: "create", reason: "disabled" });

  const mismatched = await decideSemanticMerge({
    content: INCOMING,
    category: "fact",
    config: MERGE_CONFIG,
    dedupThreshold: 0.92,
    lookup: async () => hits(["mem-1", 0.85]),
    resolveCandidate: candidateResolver({ category: "preference" }),
    judge: mergeJudge,
  });
  assert.deepEqual(mismatched, { action: "create", reason: "no_candidates" });
});

test("decideSemanticMerge: fabricated ids, bad content, and refusals all create", async () => {
  const base = {
    content: INCOMING,
    category: "fact",
    config: MERGE_CONFIG,
    dedupThreshold: 0.92,
    lookup: async () => hits(["mem-1", 0.85]),
    resolveCandidate: candidateResolver(),
  };
  const cases: Array<[MergeJudgeRawVerdict, string]> = [
    [{ decision: "merge", targetId: "mem-not-a-candidate", mergedContent: MERGED, reason: "x" }, "judge_invalid"],
    [{ decision: "merge", targetId: "mem-1", mergedContent: "   ", reason: "x" }, "judge_invalid"],
    [{ decision: "merge", targetId: "mem-1", mergedContent: "z".repeat(100_000), reason: "x" }, "judge_invalid"],
    [{ decision: "contradicts", reason: "state changed" }, "judge_contradicts"],
    [{ decision: "create", reason: "different concept" }, "judge_create"],
  ];
  for (const [verdict, reason] of cases) {
    const decision = await decideSemanticMerge({ ...base, judge: async () => verdict });
    assert.deepEqual(decision, { action: "create", reason }, reason);
  }
  const thrown = await decideSemanticMerge({
    ...base,
    judge: async () => {
      throw new Error("timeout");
    },
  });
  assert.deepEqual(thrown, { action: "create", reason: "judge_error" });
});

test("decideSemanticMerge: highest-similarity candidate wins with a stable tiebreak", async () => {
  const seen: string[] = [];
  const decision = await decideSemanticMerge({
    content: INCOMING,
    category: "fact",
    config: MERGE_CONFIG,
    dedupThreshold: 0.92,
    lookup: async () => hits(["mem-b", 0.84], ["mem-c", 0.9], ["mem-a", 0.9]),
    resolveCandidate: candidateResolver(),
    judge: async (input) => {
      seen.push(...input.candidates.map((c) => c.memoryId));
      return { decision: "merge", targetId: input.candidates[0].memoryId, mergedContent: MERGED, reason: "x" };
    },
  });
  assert.deepEqual(seen, ["mem-a", "mem-c", "mem-b"]);
  assert.equal(decision.action === "merge" && decision.targetId, "mem-a");
});

// ── Config parsing ───────────────────────────────────────────────────────────

test("parseSemanticMergeConfig: defaults are off with a valid band", () => {
  const { semanticMerge } = parseConfig({});
  assert.equal(semanticMerge.enabled, false);
  assert.equal(semanticMerge.minSimilarity, DEFAULT_SEMANTIC_MERGE_MIN);
  assert.equal(semanticMerge.maxCandidates, DEFAULT_SEMANTIC_MERGE_CANDIDATES);
  assert.equal(semanticMerge.shadowMode, false);
  assert.deepEqual(semanticMerge.categories, [
    "fact",
    "preference",
    "decision",
    "relationship",
    "skill",
  ]);
});

test("parseSemanticMergeConfig: CLI strings coerce, and 0 stays 0", () => {
  const { semanticMerge } = parseSemanticMergeConfig({
    semanticMerge: { enabled: "false", shadowMode: "true", maxCandidates: "0" },
  });
  assert.equal(semanticMerge.enabled, false);
  assert.equal(semanticMerge.shadowMode, true);
  assert.equal(semanticMerge.maxCandidates, 0);
  const enabled = parseSemanticMergeConfig({ semanticMerge: { enabled: "1" } });
  assert.equal(enabled.semanticMerge.enabled, true);
});

test("parseSemanticMergeConfig: an empty or inverted band is rejected", () => {
  assert.throws(
    () => parseSemanticMergeConfig({ semanticMerge: { minSimilarity: 0.92 } }),
    /strictly below semanticDedupThreshold/,
  );
  assert.throws(
    () => parseSemanticMergeConfig({ semanticMerge: { minSimilarity: 0.95 }, semanticDedupThreshold: 0.9 }),
    /strictly below semanticDedupThreshold/,
  );
  assert.throws(
    () => parseSemanticMergeConfig({ semanticMerge: { enabled: "sometimes" } }),
    /semanticMerge.enabled must be a boolean/,
  );
  assert.throws(
    () => parseSemanticMergeConfig({ semanticMerge: { maxCandidates: -1 } }),
    /maxCandidates must be a finite number/,
  );
});

// ── Persistence ──────────────────────────────────────────────────────────────

interface MergeHarness {
  deps: ExtractionPersistDeps;
  storage: StorageManager;
  target: MemoryFile;
  calls: {
    contentUpdates: Array<{ id: string; content: string }>;
    frontmatterPatches: Array<{ id: string; patch: Partial<MemoryFrontmatter> }>;
    hashRemovals: string[];
    hashAdds: string[];
    reindexed: string[];
    lookupStorages: string[];
  };
}

const INCOMING_SOURCE: ProvenanceSource = {
  sessionKey: "project/example/2026-08-21T00:00:00.000Z",
  observedAt: "2026-08-21T00:00:00.000Z",
  quote: "deploys run at 09:00 UTC",
};

async function harness(
  overrides: {
    config?: Partial<Record<string, unknown>>;
    targetStatus?: MemoryStatus;
    lookupHits?: SemanticDedupHit[];
    verdict?: MergeJudgeRawVerdict;
  } = {},
): Promise<MergeHarness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-merge-"));
  const factsDir = path.join(dir, "facts", "2026-08-20");
  await mkdir(factsDir, { recursive: true });
  const targetPath = path.join(factsDir, "fact-target.md");
  const frontmatter = {
    id: "fact-target",
    category: "fact",
    ...(overrides.targetStatus ? { status: overrides.targetStatus } : {}),
    sources: [
      {
        sessionKey: "project/example/2026-08-20T00:00:00.000Z",
        observedAt: "2026-08-20T00:00:00.000Z",
        quote: "deploys happen on Tuesdays",
      },
    ],
  } as unknown as MemoryFrontmatter;
  await writeFile(targetPath, `---\nid: fact-target\ncategory: fact\n---\n\n${EXISTING}\n`, "utf8");
  const target: MemoryFile = { path: targetPath, frontmatter, content: EXISTING };

  const calls: MergeHarness["calls"] = {
    contentUpdates: [],
    frontmatterPatches: [],
    hashRemovals: [],
    hashAdds: [],
    reindexed: [],
    lookupStorages: [],
  };
  const storage = {
    dir,
    getMemoryByIdIncludingArchived: async (id: string) => (id === target.frontmatter.id ? target : null),
    updateMemory: async (id: string, content: string) => {
      calls.contentUpdates.push({ id, content });
      await writeFile(targetPath, `---\nid: fact-target\ncategory: fact\n---\n\n${content}\n`, "utf8");
      return true;
    },
    updateMemoryFrontmatter: async (id: string, patch: Partial<MemoryFrontmatter>) => {
      calls.frontmatterPatches.push({ id, patch });
      return true;
    },
    removeFactContentHashesForMemories: async (memories: MemoryFile[]) => {
      calls.hashRemovals.push(...memories.map((m) => m.content));
    },
    restoreFactHashAfterApproval: async (id: string) => {
      calls.hashAdds.push(id);
    },
  } as unknown as StorageManager;

  const config = parseConfig({
    memoryDir: dir,
    versioningEnabled: true,
    semanticMerge: { enabled: true, ...(overrides.config ?? {}) },
  }) as PluginConfig;

  const deps = {
    config,
    getLocalLlm: () => null,
    semanticDedupLookup: async (_content: string, _limit: number, targetStorage: StorageManager) => {
      calls.lookupStorages.push(targetStorage.dir);
      return overrides.lookupHits ?? hits(["fact-target", 0.85]);
    },
    indexPersistedMemory: async (_storage: StorageManager, memoryId: string) => {
      calls.reindexed.push(memoryId);
    },
  } as unknown as ExtractionPersistDeps;

  return { deps, storage, target, calls };
}

const acceptingJudge = async (input: {
  candidates: readonly MergeCandidate[];
}): Promise<MergeJudgeRawVerdict> => ({
  decision: "merge",
  targetId: input.candidates[0]?.memoryId ?? null,
  mergedContent: MERGED,
  reason: "same underlying deploy cadence",
});

test("applySemanticMergeAtPersist: merges in place with snapshot, provenance, hash resync, and reindex", async () => {
  const h = await harness();
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    sources: [INCOMING_SOURCE],
    judgeCall: (options) => acceptingJudge(options),
  });

  assert.deepEqual(outcome, { action: "merged", targetId: "fact-target" });
  // Same id, same file path — an update, never a new fragment.
  assert.deepEqual(h.calls.contentUpdates, [{ id: "fact-target", content: MERGED }]);
  assert.equal(await readFile(h.target.path, "utf8").then((t) => t.includes(MERGED)), true);

  // Rollback data exists under the dedicated trigger.
  const history = await listVersions(h.target.path, { enabled: true, maxVersionsPerPage: 20, sidecarDir: ".versions" }, h.storage.dir);
  assert.equal(history.versions.length, 1);
  assert.equal(history.versions[0].trigger, "semantic-merge");

  // Provenance is appended, never replaced, and the merge is stamped.
  assert.equal(h.calls.frontmatterPatches.length, 1);
  const patch = h.calls.frontmatterPatches[0].patch;
  assert.equal(patch.derived_via, "merge");
  assert.equal(patch.reinforcement_count, 1);
  assert.equal(patch.sources?.length, 2);
  assert.equal(patch.sources?.[1].quote, INCOMING_SOURCE.quote);

  // Hash index: the pre-merge form is removed, the target re-registered.
  assert.deepEqual(h.calls.hashRemovals, [EXISTING]);
  assert.deepEqual(h.calls.hashAdds, ["fact-target"]);
  assert.deepEqual(h.calls.reindexed, ["fact-target"]);
  // Candidates come from the write's own namespace-scoped storage.
  assert.deepEqual(h.calls.lookupStorages, [h.storage.dir]);
});

test("applySemanticMergeAtPersist: shadow mode decides but never mutates", async () => {
  const h = await harness({ config: { shadowMode: true } });
  const before = await readFile(h.target.path, "utf8");
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    sources: [INCOMING_SOURCE],
    judgeCall: (options) => acceptingJudge(options),
  });
  assert.deepEqual(outcome, { action: "created", reason: "shadow_would_merge" });
  assert.equal(await readFile(h.target.path, "utf8"), before);
  assert.deepEqual(h.calls.contentUpdates, []);
  assert.deepEqual(h.calls.frontmatterPatches, []);
  const history = await listVersions(h.target.path, { enabled: true, maxVersionsPerPage: 20, sidecarDir: ".versions" }, h.storage.dir);
  assert.deepEqual(history.versions, []);
});

test("applySemanticMergeAtPersist: disabled config runs no lookup and no judge", async () => {
  const h = await harness({ config: { enabled: false } });
  let judged = 0;
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    judgeCall: async (options) => {
      judged++;
      return acceptingJudge(options);
    },
  });
  assert.deepEqual(outcome, { action: "created", reason: "disabled" });
  assert.deepEqual(h.calls.lookupStorages, []);
  assert.equal(judged, 0);
});

test("applySemanticMergeAtPersist: an inactive target and a caller skip both create", async () => {
  const inactive = await harness({ targetStatus: "superseded" });
  const inactiveOutcome = await applySemanticMergeAtPersist(inactive.deps, {
    storage: inactive.storage,
    content: INCOMING,
    category: "fact",
    judgeCall: (options) => acceptingJudge(options),
  });
  assert.equal(inactiveOutcome.action, "created");
  assert.deepEqual(inactive.calls.contentUpdates, []);

  const skipped = await harness();
  const skippedOutcome = await applySemanticMergeAtPersist(skipped.deps, {
    storage: skipped.storage,
    content: INCOMING,
    category: "fact",
    skip: true,
    judgeCall: (options) => acceptingJudge(options),
  });
  assert.deepEqual(skippedOutcome, { action: "created", reason: "disabled" });
  assert.deepEqual(skipped.calls.lookupStorages, []);
});

test("applySemanticMergeAtPersist: versioning off refuses to merge (no rollback data)", async () => {
  const h = await harness();
  const noVersioning = {
    ...h.deps,
    config: { ...h.deps.config, versioningEnabled: false },
  } as unknown as ExtractionPersistDeps;
  const outcome = await applySemanticMergeAtPersist(noVersioning, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    judgeCall: (options) => acceptingJudge(options),
  });
  assert.deepEqual(outcome, { action: "created", reason: "snapshot_unavailable" });
  assert.deepEqual(h.calls.contentUpdates, []);
});
