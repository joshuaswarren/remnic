import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computePairId,
  writePair,
  writePairs,
  readPair,
  listPairs,
  isCoolingDown,
  resolvePair,
  deferPair,
  type ContradictionPair,
} from "./contradiction-review.js";
import { _pairKey, _contentHash } from "./contradiction-judge.js";
import { executeResolution, isValidResolutionVerb } from "./resolution.js";
import { ACTIVE_STATUSES } from "./contradiction-scan.js";
import type { StorageManager } from "../storage.js";
import type { MemoryCategory, MemoryFile, MemoryFrontmatter } from "../types.js";

type FrontmatterLifecycleOptions = Parameters<StorageManager["writeMemoryFrontmatter"]>[2];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeTempDir(prefix = "contradiction-test-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makePair(overrides?: Partial<ContradictionPair>): Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] } {
  return {
    memoryIds: ["mem-a-001", "mem-b-002"],
    verdict: "contradicts",
    rationale: "Test rationale",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function writeStoredPair(dir: string, pair: ContradictionPair): Promise<void> {
  const reviewDir = path.join(dir, ".review", "contradictions");
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(reviewDir, `${pair.pairId}.json`), JSON.stringify(pair, null, 2), "utf-8");
}

function makeMemory(id: string, category: MemoryCategory = "fact"): MemoryFile {
  const now = "2026-05-17T00:00:00.000Z";
  return {
    path: `/tmp/${id}.md`,
    content: `content for ${id}`,
    frontmatter: {
      id,
      category,
      created: now,
      updated: now,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
  };
}

function cloneMemory(memory: MemoryFile): MemoryFile {
  return {
    path: memory.path,
    content: memory.content,
    frontmatter: {
      ...memory.frontmatter,
      tags: [...(memory.frontmatter.tags ?? [])],
      lineage: memory.frontmatter.lineage ? [...memory.frontmatter.lineage] : undefined,
      derived_from: memory.frontmatter.derived_from ? [...memory.frontmatter.derived_from] : undefined,
    },
  };
}

function makeResolutionStorage(options: {
  failSupersedeFor?: string;
  failRollbackFor?: string;
  partialSupersedeBeforeFailureFor?: string;
} = {}) {
  const memories = new Map<string, MemoryFile>([
    ["mem-a-001", makeMemory("mem-a-001")],
    ["mem-b-002", makeMemory("mem-b-002")],
    ["mem-merged-003", makeMemory("mem-merged-003")],
  ]);
  const supersedeCalls: Array<{ oldId: string; newId: string; reason: string }> = [];
  const frontmatterWrites: Array<{
    memoryId: string;
    beforeStatus: MemoryFrontmatter["status"];
    patch: Partial<MemoryFrontmatter>;
    lifecycle?: FrontmatterLifecycleOptions;
  }> = [];
  const removedFactHashIds: string[] = [];

  const storage = {
    memories,
    supersedeCalls,
    frontmatterWrites,
    removedFactHashIds,
    async getMemoryById(id: string) {
      const memory = memories.get(id);
      return memory ? cloneMemory(memory) : null;
    },
    async writeMemory(category: MemoryCategory, content: string, writeOptions: {
      lineage?: string[];
      derivedFrom?: string[];
      derivedVia?: string;
      tags?: string[];
    }) {
      const id = `merged-created-${memories.size}`;
      const memory = makeMemory(id, category);
      memory.content = content;
      memory.frontmatter.tags = writeOptions.tags ?? [];
      memory.frontmatter.lineage = writeOptions.lineage;
      memory.frontmatter.derived_from = writeOptions.derivedFrom;
      memory.frontmatter.derived_via = writeOptions.derivedVia as MemoryFrontmatter["derived_via"];
      memories.set(id, memory);
      return id;
    },
    async supersedeMemory(oldId: string, newId: string, reason: string) {
      supersedeCalls.push({ oldId, newId, reason });
      if (oldId === options.failSupersedeFor) return false;
      const memory = memories.get(oldId);
      if (!memory) return false;
      const supersededMemory: MemoryFile = {
        ...memory,
        frontmatter: {
          ...memory.frontmatter,
          status: "superseded",
          supersededBy: newId,
          supersededAt: "2026-05-17T00:01:00.000Z",
        },
      };
      memories.set(oldId, supersededMemory);
      if (oldId === options.partialSupersedeBeforeFailureFor) return false;
      return true;
    },
    async writeMemoryFrontmatter(
      memory: MemoryFile,
      patch: Partial<MemoryFrontmatter>,
      lifecycle?: FrontmatterLifecycleOptions,
    ) {
      const existing = memories.get(memory.frontmatter.id);
      if (!existing) return false;
      frontmatterWrites.push({
        memoryId: memory.frontmatter.id,
        beforeStatus: memory.frontmatter.status,
        patch,
        lifecycle,
      });
      if (memory.frontmatter.id === options.failRollbackFor) return false;
      memories.set(memory.frontmatter.id, {
        ...memory,
        frontmatter: { ...memory.frontmatter, ...patch },
      });
      return true;
    },
    async invalidateMemory(id: string) {
      return memories.delete(id);
    },
    async removeFactContentHashesForMemories(hashMemories: MemoryFile[]) {
      removedFactHashIds.push(...hashMemories.map((memory) => memory.frontmatter.id));
    },
  };

  return storage as typeof storage & StorageManager;
}

// ── Pair ID determinism ────────────────────────────────────────────────────────

test("computePairId is deterministic and order-independent", () => {
  const ab = computePairId("a", "b");
  const ba = computePairId("b", "a");
  assert.equal(ab, ba, "Pair ID should be the same regardless of argument order");
});

test("computePairId produces different IDs for different pairs", () => {
  const ab = computePairId("a", "b");
  const ac = computePairId("a", "c");
  assert.notEqual(ab, ac);
});

// ── Review queue write/read ────────────────────────────────────────────────────

test("writePair and readPair round-trip", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    const written = writePair(dir, pair);
    assert.ok(written.pairId, "Written pair should have a pairId");
    assert.deepEqual(written.memoryIds, pair.memoryIds);

    const read = readPair(dir, written.pairId);
    assert.ok(read, "Should read back the pair");
    assert.equal(read!.pairId, written.pairId);
    assert.equal(read!.verdict, "contradicts");
  } finally {
    await cleanup();
  }
});

test("writePair is idempotent", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    const first = writePair(dir, pair);
    const second = writePair(dir, pair);
    assert.equal(first.pairId, second.pairId);
  } finally {
    await cleanup();
  }
});

test("writePair preserves user resolution", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    const written = writePair(dir, pair);
    resolvePair(dir, written.pairId, "keep-a");

    const updated = writePair(dir, makePair({ memoryIds: ["mem-a-001", "mem-b-002"], confidence: 0.95 }));
    assert.equal(updated.resolution, "keep-a", "Should preserve existing resolution");
  } finally {
    await cleanup();
  }
});

// ── Batch dedup (rule 49) ──────────────────────────────────────────────────────

test("writePairs deduplicates batch inputs", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    // Same pair submitted 3 times
    const results = writePairs(dir, [pair, pair, pair]);
    assert.equal(results.length, 1, "Should deduplicate identical pairs in batch");
  } finally {
    await cleanup();
  }
});

// ── List and filter ────────────────────────────────────────────────────────────

test("listPairs filters by verdict", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    writePair(dir, makePair({ verdict: "contradicts", memoryIds: ["a1", "b1"] }));
    writePair(dir, makePair({ verdict: "independent", memoryIds: ["a2", "b2"] }));
    writePair(dir, makePair({ verdict: "duplicates", memoryIds: ["a3", "b3"] }));

    const contradicts = listPairs(dir, { filter: "contradicts" });
    assert.equal(contradicts.pairs.length, 1);
    assert.equal(contradicts.pairs[0].verdict, "contradicts");

    const all = listPairs(dir, { filter: "all" });
    assert.equal(all.pairs.length, 3);
  } finally {
    await cleanup();
  }
});

test("listPairs respects limit", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    for (let i = 0; i < 5; i++) {
      writePair(dir, makePair({ memoryIds: [`a-${i}`, `b-${i}`] }));
    }
    const result = listPairs(dir, { filter: "all", limit: 2 });
    assert.equal(result.pairs.length, 2);
    assert.equal(result.total, 5, "total should reflect all matching pairs, not just returned");
  } finally {
    await cleanup();
  }
});

test("listPairs filters by namespace", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    writePair(dir, makePair({ namespace: "ns1", memoryIds: ["a1", "b1"] }));
    writePair(dir, makePair({ namespace: "ns2", memoryIds: ["a2", "b2"] }));

    const ns1 = listPairs(dir, { namespace: "ns1" });
    assert.equal(ns1.pairs.length, 1);
    assert.equal(ns1.pairs[0].namespace, "ns1");
  } finally {
    await cleanup();
  }
});

test("listPairs returns empty when dir does not exist", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const result = listPairs(path.join(dir, "nonexistent"));
    assert.equal(result.pairs.length, 0);
    assert.equal(result.total, 0);
  } finally {
    await cleanup();
  }
});

// ── Cooldown ───────────────────────────────────────────────────────────────────

test("isCoolingDown returns false when no lastReviewedAt", () => {
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
  };
  assert.equal(isCoolingDown(pair, 14), false);
});

test("isCoolingDown returns true within cooldown window", () => {
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
    lastReviewedAt: new Date().toISOString(),
  };
  assert.equal(isCoolingDown(pair, 14), true);
});

test("isCoolingDown returns false after cooldown expires", () => {
  const past = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: past,
    lastReviewedAt: past,
  };
  assert.equal(isCoolingDown(pair, 14), false);
});

test("isCoolingDown returns false when cooldownDays is 0 (rule 27)", () => {
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
    lastReviewedAt: new Date().toISOString(),
  };
  assert.equal(isCoolingDown(pair, 0), false, "0 cooldownDays should disable cooldown");
  assert.equal(
    isCoolingDown({ ...pair, pairId: "deferred", deferredUntil: new Date(Date.now() + 60_000).toISOString() }, 0),
    false,
    "0 cooldownDays should disable explicit deferral cooldown",
  );
  assert.equal(
    isCoolingDown({ ...pair, pairId: "legacy-deferred", resolution: "needs-more-context" }, 0),
    false,
    "0 cooldownDays should disable legacy deferral cooldown",
  );
});

test("isCoolingDown uses deferredUntil instead of generic cooldown for deferrals", () => {
  const now = Date.now();
  const active: ContradictionPair = {
    pairId: "active-deferral",
    memoryIds: ["a", "b"],
    verdict: "contradicts",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date(now).toISOString(),
    lastReviewedAt: new Date(now).toISOString(),
    deferredUntil: new Date(now + 60_000).toISOString(),
  };
  const expired: ContradictionPair = {
    ...active,
    pairId: "expired-deferral",
    deferredUntil: new Date(now - 60_000).toISOString(),
  };

  assert.equal(isCoolingDown(active, 14), true);
  assert.equal(isCoolingDown(expired, 14), false);
});

// ── Resolution verbs ───────────────────────────────────────────────────────────

test("isValidResolutionVerb accepts valid verbs", () => {
  assert.equal(isValidResolutionVerb("keep-a"), true);
  assert.equal(isValidResolutionVerb("keep-b"), true);
  assert.equal(isValidResolutionVerb("merge"), true);
  assert.equal(isValidResolutionVerb("both-valid"), true);
  assert.equal(isValidResolutionVerb("needs-more-context"), true);
});

test("isValidResolutionVerb rejects invalid verbs", () => {
  assert.equal(isValidResolutionVerb("delete"), false);
  assert.equal(isValidResolutionVerb(""), false);
  assert.equal(isValidResolutionVerb("unknown"), false);
});

test("executeResolution merge requires a real merged memory", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage();

    const result = await executeResolution(dir, storage, written.pairId, "merge");

    assert.deepEqual(storage.supersedeCalls, []);
    assert.match(result.message, /requires mergedMemoryId or mergedContent/);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution merge supersedes both sources to a verified merged memory", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage();

    const result = await executeResolution(dir, storage, written.pairId, "merge", {
      mergedMemoryId: "mem-merged-003",
    });

    assert.deepEqual(
      storage.supersedeCalls.map(({ oldId, newId }) => ({ oldId, newId })),
      [
        { oldId: "mem-a-001", newId: "mem-merged-003" },
        { oldId: "mem-b-002", newId: "mem-merged-003" },
      ],
    );
    assert.deepEqual(result.affectedIds, ["mem-a-001", "mem-b-002"]);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, "superseded");
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.supersededBy, "mem-merged-003");
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.status, "superseded");
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.supersededBy, "mem-merged-003");
    assert.equal(readPair(dir, written.pairId)?.resolution, "merge");
  } finally {
    await cleanup();
  }
});

test("executeResolution merge can create and verify a merged memory from content", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage();

    const result = await executeResolution(dir, storage, written.pairId, "merge", {
      mergedContent: "merged canonical fact",
    });

    const mergedId = storage.supersedeCalls[0]?.newId;
    assert.ok(mergedId);
    assert.deepEqual(result.affectedIds, ["mem-a-001", "mem-b-002"]);
    assert.equal(storage.memories.get(mergedId)?.content, "merged canonical fact");
    assert.deepEqual(storage.memories.get(mergedId)?.frontmatter.derived_from, ["mem-a-001", "mem-b-002"]);
    assert.equal(storage.memories.get(mergedId)?.frontmatter.derived_via, "merge");
    assert.equal(readPair(dir, written.pairId)?.resolution, "merge");
  } finally {
    await cleanup();
  }
});

test("executeResolution merge rolls back the first supersession when the second fails", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage({ failSupersedeFor: "mem-b-002" });

    const result = await executeResolution(dir, storage, written.pairId, "merge", {
      mergedMemoryId: "mem-merged-003",
    });

    assert.deepEqual(
      storage.supersedeCalls.map(({ oldId, newId }) => ({ oldId, newId })),
      [
        { oldId: "mem-a-001", newId: "mem-merged-003" },
        { oldId: "mem-b-002", newId: "mem-merged-003" },
      ],
    );
    assert.match(result.message, /restored mem-a-001 and mem-b-002/);
    assert.deepEqual(result.affectedIds, []);
    assert.deepEqual(
      storage.frontmatterWrites.map(({ memoryId, lifecycle }) => ({
        memoryId,
        actor: lifecycle?.actor,
        reasonCode: lifecycle?.reasonCode,
      })),
      [
        {
          memoryId: "mem-a-001",
          actor: "contradiction-resolution",
          reasonCode: "contradiction-resolution:merge-rollback",
        },
        {
          memoryId: "mem-b-002",
          actor: "contradiction-resolution",
          reasonCode: "contradiction-resolution:merge-rollback",
        },
      ],
    );
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, undefined);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.supersededBy, undefined);
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.status, undefined);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution merge restores the second source after partial supersede failure", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage({ partialSupersedeBeforeFailureFor: "mem-b-002" });

    const result = await executeResolution(dir, storage, written.pairId, "merge", {
      mergedContent: "merged canonical fact",
    });

    const mergedId = storage.supersedeCalls[0]?.newId;
    assert.ok(mergedId);
    assert.match(result.message, /restored mem-a-001 and mem-b-002/);
    assert.deepEqual(result.affectedIds, []);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, undefined);
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.status, undefined);
    assert.equal(storage.memories.has(mergedId), false);
    assert.deepEqual(
      storage.frontmatterWrites.map(({ memoryId, beforeStatus }) => ({ memoryId, beforeStatus })),
      [
        { memoryId: "mem-a-001", beforeStatus: "superseded" },
        { memoryId: "mem-b-002", beforeStatus: "superseded" },
      ],
    );
    assert.deepEqual(storage.removedFactHashIds, [mergedId]);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution merge restores the first source after partial supersede failure", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage({ partialSupersedeBeforeFailureFor: "mem-a-001" });

    const result = await executeResolution(dir, storage, written.pairId, "merge", {
      mergedContent: "merged canonical fact",
    });

    const mergedId = storage.supersedeCalls[0]?.newId;
    assert.ok(mergedId);
    assert.match(result.message, /restored mem-a-001/);
    assert.deepEqual(result.affectedIds, []);
    assert.deepEqual(
      storage.frontmatterWrites.map(({ memoryId, lifecycle }) => ({
        memoryId,
        actor: lifecycle?.actor,
        reasonCode: lifecycle?.reasonCode,
      })),
      [
        {
          memoryId: "mem-a-001",
          actor: "contradiction-resolution",
          reasonCode: "contradiction-resolution:merge-rollback",
        },
      ],
    );
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, undefined);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.supersededBy, undefined);
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.status, undefined);
    assert.equal(storage.memories.has(mergedId), false);
    assert.deepEqual(
      storage.frontmatterWrites.map(({ memoryId, beforeStatus }) => ({ memoryId, beforeStatus })),
      [{ memoryId: "mem-a-001", beforeStatus: "superseded" }],
    );
    assert.deepEqual(storage.removedFactHashIds, [mergedId]);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution merge keeps created replacement when rollback fails", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage({
      failSupersedeFor: "mem-b-002",
      failRollbackFor: "mem-a-001",
    });

    const result = await executeResolution(dir, storage, written.pairId, "merge", {
      mergedContent: "merged canonical fact",
    });

    const mergedId = storage.supersedeCalls[0]?.newId;
    assert.ok(mergedId);
    assert.match(result.message, /rollback incomplete for mem-a-001/);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, "superseded");
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.supersededBy, mergedId);
    assert.equal(storage.memories.get(mergedId)?.content, "merged canonical fact");
    assert.deepEqual(storage.removedFactHashIds, []);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution needs-more-context defers without terminal resolution", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage();

    const result = await executeResolution(dir, storage, written.pairId, "needs-more-context");
    const deferred = readPair(dir, written.pairId);

    assert.deepEqual(result.affectedIds, []);
    assert.match(result.message, /Deferred/);
    assert.ok(deferred?.lastReviewedAt);
    assert.ok(deferred?.deferredUntil);
    assert.equal(deferred?.resolution, undefined);
    assert.equal(listPairs(dir, { filter: "unresolved" }).total, 0);
    assert.equal(listPairs(dir, { filter: "all" }).total, 1);
  } finally {
    await cleanup();
  }
});

test("expired needs-more-context deferral returns to unresolved and can be refreshed", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair({ confidence: 0.95 }));
    const deferred = resolvePair(dir, written.pairId, "needs-more-context");
    assert.ok(deferred);

    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await writeStoredPair(dir, {
      ...deferred!,
      lastReviewedAt: expiredAt,
      deferredUntil: expiredAt,
    });

    assert.equal(listPairs(dir, { filter: "unresolved" }).total, 1);

    const refreshed = writePair(dir, makePair({
      confidence: 0.5,
      verdict: "duplicates",
      rationale: "Fresh judge result after deferral expiry",
    }));

    assert.equal(refreshed.confidence, 0.5);
    assert.equal(refreshed.verdict, "duplicates");
    assert.equal(refreshed.resolution, undefined);
    assert.equal(refreshed.deferredUntil, undefined);
    assert.equal(readPair(dir, written.pairId)?.deferredUntil, undefined);
  } finally {
    await cleanup();
  }
});

test("legacy needs-more-context resolutions honor cooldown before returning to unresolved", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());

    await writeStoredPair(dir, {
      ...written,
      lastReviewedAt: new Date().toISOString(),
      resolution: "needs-more-context",
    });
    assert.equal(listPairs(dir, { filter: "unresolved" }).total, 0);

    await writeStoredPair(dir, {
      ...written,
      lastReviewedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      resolution: "needs-more-context",
    });
    assert.equal(listPairs(dir, { filter: "unresolved" }).total, 1);
  } finally {
    await cleanup();
  }
});

// ── resolvePair ────────────────────────────────────────────────────────────────

test("resolvePair sets resolution and lastReviewedAt", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const resolved = resolvePair(dir, written.pairId, "both-valid");
    assert.ok(resolved);
    assert.equal(resolved!.resolution, "both-valid");
    assert.ok(resolved!.lastReviewedAt);
  } finally {
    await cleanup();
  }
});

test("needs-more-context deferral does not clear terminal resolutions", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const resolved = resolvePair(dir, written.pairId, "keep-a");
    assert.equal(resolved?.resolution, "keep-a");

    const deferredViaResolve = resolvePair(dir, written.pairId, "needs-more-context");
    assert.equal(deferredViaResolve?.resolution, "keep-a");
    assert.equal(deferredViaResolve?.deferredUntil, undefined);

    const deferredDirectly = deferPair(dir, written.pairId);
    assert.equal(deferredDirectly?.resolution, "keep-a");
    assert.equal(deferredDirectly?.deferredUntil, undefined);
    assert.equal(listPairs(dir, { filter: "unresolved" }).total, 0);
  } finally {
    await cleanup();
  }
});

test("resolvePair returns null for nonexistent pair", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const result = resolvePair(dir, "nonexistent", "both-valid");
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

// ── ACTIVE_STATUSES (rule 53) ──────────────────────────────────────────────────

test("ACTIVE_STATUSES contains only active", () => {
  assert.ok(ACTIVE_STATUSES.has("active"));
  assert.equal(ACTIVE_STATUSES.has("superseded"), false);
  assert.equal(ACTIVE_STATUSES.has("archived"), false);
  assert.equal(ACTIVE_STATUSES.has("quarantined"), false);
  assert.equal(ACTIVE_STATUSES.has("rejected"), false);
  assert.equal(ACTIVE_STATUSES.has("pending_review"), false);
});

// ── Judge helper: pairKey ──────────────────────────────────────────────────────

test("pairKey is order-independent", () => {
  assert.equal(_pairKey("a", "b"), _pairKey("b", "a"));
});

// ── Judge helper: contentHash ──────────────────────────────────────────────────

test("contentHash is deterministic", () => {
  const a = { memoryIdA: "1", memoryIdB: "2", textA: "hello", textB: "world" };
  const b = { memoryIdA: "1", memoryIdB: "2", textA: "hello", textB: "world" };
  assert.equal(_contentHash(a), _contentHash(b));
});

test("contentHash differs for different content", () => {
  const a = { memoryIdA: "1", memoryIdB: "2", textA: "hello", textB: "world" };
  const b = { memoryIdA: "1", memoryIdB: "2", textA: "goodbye", textB: "world" };
  assert.notEqual(_contentHash(a), _contentHash(b));
});

// ── JSON parse safety (rule 18) ────────────────────────────────────────────────

test("readPair returns null for invalid JSON", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const reviewDir = path.join(dir, ".review", "contradictions");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "test-id.json"), "null");
    assert.equal(readPair(dir, "test-id"), null, "JSON.parse('null') should not be a valid pair");
  } finally {
    await cleanup();
  }
});

test("readPair returns null for non-object JSON", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const reviewDir = path.join(dir, ".review", "contradictions");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "test-id.json"), '"a string"');
    assert.equal(readPair(dir, "test-id"), null);
  } finally {
    await cleanup();
  }
});
