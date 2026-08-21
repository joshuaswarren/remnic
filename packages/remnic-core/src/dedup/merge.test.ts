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
import { invalidationCommitFingerprint } from "../storage/deletion-revision-store.js";

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
  /** Simulate another writer committing a new body to the target. */
  setTargetContent: (content: string) => Promise<void>;
  calls: {
    contentUpdates: Array<{ id: string; content: string; actor?: string }>;
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
    /** Simulate a concurrent writer landing between the CAS read and write. */
    mutateOnWrite?: string;
    /**
     * Simulate a concurrent writer replacing the target between the content
     * commit and the provenance patch — the window the id-keyed patch left
     * open.
     */
    mutateAtPatch?: string;
    /** Force the frontmatter patch to fail after the content update commits. */
    frontmatterFails?: boolean;
    /** Force the automatic rollback of that committed content to fail. */
    rollbackFails?: boolean;
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
  // Live state: the CAS compares against what is on disk NOW, so a stub that
  // returned the original snapshot forever could never fail a compare.
  let state: MemoryFile = { ...target };

  const calls: MergeHarness["calls"] = {
    contentUpdates: [],
    frontmatterPatches: [],
    hashRemovals: [],
    hashAdds: [],
    reindexed: [],
    lookupStorages: [],
  };
  const commit = async (content: string): Promise<void> => {
    state = { ...state, content };
    await writeFile(targetPath, `---\nid: fact-target\ncategory: fact\n---\n\n${content}\n`, "utf8");
  };
  // Live state: reads come off the file, so a stub can neither invent a
  // restore that never touched storage nor compare a snapshot against itself.
  const read = async (): Promise<MemoryFile> => {
    const raw = await readFile(targetPath, "utf8");
    const body = raw.slice(raw.indexOf("---", 3) + 4).trim();
    return { path: targetPath, frontmatter: state.frontmatter, content: body };
  };
  const unchanged = async (expected: MemoryFile): Promise<boolean> => {
    const current = await read();
    // The production compare, not a content-only approximation (checklist #21).
    return invalidationCommitFingerprint(current) === invalidationCommitFingerprint(expected);
  };
  const storage = {
    dir,
    getMemoryByIdIncludingArchived: async (id: string) =>
      id === state.frontmatter.id ? await read() : null,
    readMemoryByPath: async (p: string) => (p === targetPath ? await read() : null),
    // The id-keyed APIs: they re-read and overwrite/stamp whatever is there
    // now. Present so that a revert to either unsafe call fails on the
    // assertions below rather than on a missing stub method.
    updateMemory: async (id: string, content: string, options?: { actor?: string }) => {
      if (id !== state.frontmatter.id) return false;
      if (overrides.mutateOnWrite !== undefined && options?.actor === "semantic-merge") {
        await commit(overrides.mutateOnWrite);
      }
      calls.contentUpdates.push({ id, content, actor: options?.actor });
      await commit(content);
      return true;
    },
    updateMemoryFrontmatter: async (id: string, patch: Partial<MemoryFrontmatter>) => {
      calls.frontmatterPatches.push({ id, patch });
      return overrides.frontmatterFails !== true;
    },
    // Signature-faithful to StorageManager.updateMemoryIfUnchanged: the
    // compare is on the caller's snapshot, not on the id.
    updateMemoryIfUnchanged: async (
      expected: MemoryFile,
      content: string,
      options?: { actor?: string },
    ) => {
      if (overrides.rollbackFails && options?.actor === "semantic-merge-rollback") return false;
      if (overrides.mutateOnWrite !== undefined && options?.actor === "semantic-merge") {
        await commit(overrides.mutateOnWrite);
      }
      if (!(await unchanged(expected))) return false;
      calls.contentUpdates.push({ id: expected.frontmatter.id, content, actor: options?.actor });
      await commit(content);
      return true;
    },
    // Signature-faithful to StorageManager.writeMemoryFrontmatterIfUnchanged.
    writeMemoryFrontmatterIfUnchanged: async (
      expected: MemoryFile,
      patch: Partial<MemoryFrontmatter>,
    ) => {
      // A concurrent writer inside the patch window: after the caller's
      // verifying read, before storage takes its own lock.
      if (overrides.mutateAtPatch !== undefined) await commit(overrides.mutateAtPatch);
      if (!(await unchanged(expected))) return false;
      calls.frontmatterPatches.push({ id: expected.frontmatter.id, patch });
      return overrides.frontmatterFails !== true;
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

  return { deps, storage, target, setTargetContent: commit, calls };
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

  assert.deepEqual(outcome, { action: "merged", targetId: "fact-target", provenancePatched: true });
  // Same id, same file path — an update, never a new fragment.
  assert.deepEqual(h.calls.contentUpdates, [
    { id: "fact-target", content: MERGED, actor: "semantic-merge" },
  ]);
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

// ── Finding 1: connector boundaries survive a merge ──────────────────────────

test("decideSemanticMerge: a foreign-connector neighbor is never a merge target", async () => {
  const base = {
    content: INCOMING,
    category: "fact",
    config: MERGE_CONFIG,
    dedupThreshold: 0.92,
    resolveCandidate: candidateResolver(),
    judge: mergeJudge,
  };
  // Connector B's fact must not rewrite connector A's memory: A's
  // `sourceConnector` frontmatter would still name A after the merge.
  const foreign = await decideSemanticMerge({
    ...base,
    sourceConnector: "connector-b",
    lookup: async () => [{ id: "mem-a", score: 0.85, sourceConnector: "connector-a" }],
  });
  assert.deepEqual(foreign, { action: "create", reason: "no_candidates" });

  // An unattributed neighbor is equally ineligible for a scoped candidate.
  const unattributed = await decideSemanticMerge({
    ...base,
    sourceConnector: "connector-b",
    lookup: async () => hits(["mem-operator", 0.85]),
  });
  assert.deepEqual(unattributed, { action: "create", reason: "no_candidates" });

  // Same connector merges, and a whitespace-only scope is "unattributed",
  // preserving the pre-provenance unscoped behavior.
  const same = await decideSemanticMerge({
    ...base,
    sourceConnector: "connector-b",
    lookup: async () => [{ id: "mem-b", score: 0.85, sourceConnector: "connector-b" }],
  });
  assert.equal(same.action, "merge");
  const unscoped = await decideSemanticMerge({
    ...base,
    sourceConnector: "   ",
    lookup: async () => [{ id: "mem-a", score: 0.85, sourceConnector: "connector-a" }],
  });
  assert.equal(unscoped.action, "merge");
});

test("applySemanticMergeAtPersist: the incoming fact's connector scopes the lookup", async () => {
  const h = await harness({
    lookupHits: [{ id: "fact-target", score: 0.85, sourceConnector: "connector-a" }],
  });
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    sourceConnector: "connector-b",
    judgeCall: (options) => acceptingJudge(options),
  });
  assert.deepEqual(outcome, { action: "created", reason: "no_candidates" });
  assert.deepEqual(h.calls.contentUpdates, []);
  assert.equal(await readFile(h.target.path, "utf8").then((t) => t.includes(EXISTING)), true);
});

// ── Finding 2: the write is conditional on the judged snapshot ───────────────

test("applySemanticMergeAtPersist: a target changed after judging creates, never clobbers", async () => {
  const CONCURRENT = "Billing service deploys happen on Tuesdays, paused during freeze weeks.";
  const h = await harness();
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    sources: [INCOMING_SOURCE],
    // Another extraction lands between the judge resolving the target body
    // and the write. `MERGED` was composed from the older body.
    judgeCall: async (options) => {
      const verdict = await acceptingJudge(options);
      await h.setTargetContent(CONCURRENT);
      return verdict;
    },
  });
  assert.deepEqual(outcome, { action: "created", reason: "target_changed" });
  assert.deepEqual(h.calls.contentUpdates, []);
  // The concurrent writer's details survive verbatim.
  const onDisk = await readFile(h.target.path, "utf8");
  assert.equal(onDisk.includes(CONCURRENT), true);
  assert.equal(onDisk.includes(MERGED), false);
});

test("applySemanticMergeAtPersist: a failed compare-and-swap creates instead of overwriting", async () => {
  const RACED = "Billing service deploys happen on Tuesdays, except during a freeze.";
  const h = await harness({ mutateOnWrite: RACED });
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    judgeCall: (options) => acceptingJudge(options),
  });
  assert.deepEqual(outcome, { action: "created", reason: "target_changed" });
  assert.deepEqual(h.calls.contentUpdates, []);
  const onDisk = await readFile(h.target.path, "utf8");
  assert.equal(onDisk.includes(RACED), true);
  assert.equal(onDisk.includes(MERGED), false);
});

// ── Finding 3: a failed frontmatter patch really restores the body ───────────

test("applySemanticMergeAtPersist: a failed frontmatter patch restores the pre-merge body", async () => {
  const h = await harness({ frontmatterFails: true });
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    sources: [INCOMING_SOURCE],
    judgeCall: (options) => acceptingJudge(options),
  });
  // Reporting `created` is only honest once the target no longer holds the
  // merged text — otherwise the caller writes a duplicate. Read the body back
  // out of storage: a rollback that only claimed success would pass an
  // assertion on the recorded calls alone.
  assert.deepEqual(outcome, { action: "created", reason: "update_failed" });
  const restored = await h.storage.getMemoryByIdIncludingArchived("fact-target");
  assert.equal(restored?.content, EXISTING);
  const onDisk = await readFile(h.target.path, "utf8");
  assert.equal(onDisk.includes(EXISTING), true);
  assert.equal(onDisk.includes(MERGED), false);
  assert.deepEqual(h.calls.contentUpdates, [
    { id: "fact-target", content: MERGED, actor: "semantic-merge" },
    { id: "fact-target", content: EXISTING, actor: "semantic-merge-rollback" },
  ]);
  // Neither hash resync nor reindex may run for a merge that did not stand.
  assert.deepEqual(h.calls.hashRemovals, []);
  assert.deepEqual(h.calls.reindexed, []);
});

test("applySemanticMergeAtPersist: a writer inside the patch window keeps its body and blocks a false merge", async () => {
  const RACED = "Billing service deploys are paused during freeze weeks.";
  // Another writer replaces the target after the content commit and after the
  // verifying read — the window an id-keyed frontmatter patch left open. That
  // patch would have stamped this merge's provenance onto the other writer's
  // body and still returned `merged`, so the caller would drop the fact.
  const h = await harness({ mutateAtPatch: RACED });
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    sources: [INCOMING_SOURCE],
    judgeCall: (options) => acceptingJudge(options),
  });
  // Never `merged`: the merged body was overwritten, so the fact is unwritten.
  assert.deepEqual(outcome, { action: "created", reason: "update_failed" });
  // No provenance was attached to a body this merge never composed.
  assert.deepEqual(h.calls.frontmatterPatches, []);
  // The other writer's body survives verbatim — the rollback must not treat
  // someone else's content as its own to revert.
  const current = await h.storage.getMemoryByIdIncludingArchived("fact-target");
  assert.equal(current?.content, RACED);
  assert.deepEqual(
    h.calls.contentUpdates.map((c) => c.actor),
    ["semantic-merge"],
  );
  const onDisk = await readFile(h.target.path, "utf8");
  assert.equal(onDisk.includes(MERGED), false);
  assert.equal(onDisk.includes(EXISTING), false);
  assert.deepEqual(h.calls.hashRemovals, []);
  assert.deepEqual(h.calls.reindexed, []);
});

test("applySemanticMergeAtPersist: an unrollbackable patch failure reports merged, not created", async () => {
  const h = await harness({ frontmatterFails: true, rollbackFails: true });
  const outcome = await applySemanticMergeAtPersist(h.deps, {
    storage: h.storage,
    content: INCOMING,
    category: "fact",
    judgeCall: (options) => acceptingJudge(options),
  });
  // The merged text IS in the target; claiming `created` would duplicate it.
  assert.deepEqual(outcome, {
    action: "merged",
    targetId: "fact-target",
    provenancePatched: false,
  });
  assert.equal(await readFile(h.target.path, "utf8").then((t) => t.includes(MERGED)), true);
});

// ── Finding 4: a disabled feature never invalidates a legacy config ──────────

test("parseSemanticMergeConfig: a low dedup threshold with no semanticMerge block still parses", () => {
  for (const semanticDedupThreshold of [0.8, 0.75, 0.5]) {
    const { semanticMerge } = parseSemanticMergeConfig({ semanticDedupThreshold });
    assert.equal(semanticMerge.enabled, false, `threshold ${semanticDedupThreshold}`);
    assert.equal(semanticMerge.minSimilarity, DEFAULT_SEMANTIC_MERGE_MIN);
  }
  // parseConfig is the real startup path a legacy deployment takes.
  assert.equal(parseConfig({ semanticDedupThreshold: 0.8 }).semanticMerge.enabled, false);
  // Enabling it against the same threshold is a real misconfiguration.
  assert.throws(
    () => parseSemanticMergeConfig({ semanticDedupThreshold: 0.8, semanticMerge: { enabled: true } }),
    /strictly below semanticDedupThreshold/,
  );
  // An explicitly inverted band is rejected even while disabled.
  assert.throws(
    () =>
      parseSemanticMergeConfig({
        semanticDedupThreshold: 0.8,
        semanticMerge: { minSimilarity: 0.9 },
      }),
    /strictly below semanticDedupThreshold/,
  );
});
