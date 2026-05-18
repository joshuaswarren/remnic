import assert from "node:assert/strict";
import fs from "node:fs";
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
  migrateUnscopedPairsToNamespace,
  type ContradictionPair,
} from "./contradiction-review.js";
import { _pairKey, _contentHash } from "./contradiction-judge.js";
import { executeResolution, isValidResolutionVerb } from "./resolution.js";
import { ACTIVE_STATUSES, runContradictionScan } from "./contradiction-scan.js";
import { parseConfig } from "../config.js";
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

function makeScanStorage(memories: MemoryFile[]) {
  let readCount = 0;
  const storage = {
    get readCount() {
      return readCount;
    },
    async readAllMemories() {
      readCount += 1;
      return memories.map(cloneMemory);
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

test("computePairId includes namespace scope when present", () => {
  const unscoped = computePairId("a", "b");
  const ns1 = computePairId("a", "b", "ns1");
  const ns1Reversed = computePairId("b", "a", "ns1");
  const ns2 = computePairId("a", "b", "ns2");

  assert.notEqual(ns1, unscoped);
  assert.equal(ns1, ns1Reversed);
  assert.notEqual(ns1, ns2);
  assert.equal(computePairId("a", "b", "  "), unscoped);
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

test("writePair stores identical memory id pairs separately per namespace", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const ns1 = writePair(dir, makePair({ namespace: "ns1" }));
    const ns2 = writePair(dir, makePair({ namespace: "ns2" }));

    assert.notEqual(ns1.pairId, ns2.pairId);
    assert.equal(listPairs(dir, { namespace: "ns1" }).pairs[0]?.pairId, ns1.pairId);
    assert.equal(listPairs(dir, { namespace: "ns2" }).pairs[0]?.pairId, ns2.pairId);
  } finally {
    await cleanup();
  }
});

test("review queue writes use unique temporary paths", async () => {
  const { dir, cleanup } = await makeTempDir();
  const tempPaths: string[] = [];
  const originalWriteFileSync = fs.writeFileSync;

  (fs as any).writeFileSync = (file: unknown, ...args: unknown[]) => {
    const filePath = String(file);
    if (filePath.includes(`${path.sep}.review${path.sep}contradictions${path.sep}`)) {
      tempPaths.push(filePath);
    }
    return (originalWriteFileSync as any).call(fs, file, ...args);
  };

  try {
    const first = writePair(dir, makePair({ memoryIds: ["mem-a-001", "mem-b-002"] }));
    const second = writePair(dir, makePair({ memoryIds: ["mem-a-003", "mem-b-004"] }));
    resolvePair(dir, first.pairId, "both-valid");
    deferPair(dir, second.pairId);

    assert.equal(tempPaths.length, 4);
    assert.equal(new Set(tempPaths).size, tempPaths.length);
    for (const tempPath of tempPaths) {
      assert.match(tempPath, /\.json\.\d+\.\d+\.[0-9a-f-]+\.tmp$/);
      assert.equal(tempPath.endsWith(".json.tmp"), false);
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    await cleanup();
  }
});

test("review queue write failures clean up unique temporary files", async () => {
  const { dir, cleanup } = await makeTempDir();
  const originalRenameSync = fs.renameSync;
  let attemptedTempPath: string | null = null;

  (fs as any).renameSync = (oldPath: unknown, newPath: unknown) => {
    if (String(newPath).includes(`${path.sep}.review${path.sep}contradictions${path.sep}`)) {
      attemptedTempPath = String(oldPath);
      throw new Error("simulated rename failure");
    }
    return (originalRenameSync as any).call(fs, oldPath, newPath);
  };

  try {
    assert.throws(
      () => writePair(dir, makePair()),
      /simulated rename failure/,
    );
    assert.ok(attemptedTempPath);
    assert.equal(fs.existsSync(attemptedTempPath), false);
  } finally {
    fs.renameSync = originalRenameSync;
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

test("writePair preserves both-valid resolutions without scan cooldown context", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair({ confidence: 0.5 }));
    resolvePair(dir, written.pairId, "both-valid");

    const updated = writePair(dir, makePair({ confidence: 0.95 }));
    assert.equal(updated.resolution, "both-valid");
    assert.equal(updated.confidence, 0.5);
  } finally {
    await cleanup();
  }
});

test("writePair preserves dormant independent verdicts during cooldown", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const now = new Date().toISOString();
    const dormant = writePair(dir, makePair({
      verdict: "independent",
      confidence: 0.95,
      lastReviewedAt: now,
    }));

    const refreshed = writePair(dir, makePair({
      verdict: "contradicts",
      confidence: 1,
      rationale: "Fresh actionable judge result during cooldown",
    }), { cooldownDays: 14 });

    assert.equal(refreshed.pairId, dormant.pairId);
    assert.equal(refreshed.verdict, "independent");
    assert.equal(refreshed.confidence, 0.95);
    assert.equal(refreshed.lastReviewedAt, now);
  } finally {
    await cleanup();
  }
});

test("writePair refreshes expired independent verdicts with actionable lower-confidence results", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const expiredAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const dormant = writePair(dir, makePair({
      verdict: "independent",
      confidence: 0.95,
      detectedAt: expiredAt,
      lastReviewedAt: expiredAt,
    }));

    const refreshed = writePair(dir, makePair({
      verdict: "contradicts",
      confidence: 0.5,
      rationale: "Fresh actionable judge result after cooldown",
    }), { cooldownDays: 14 });

    assert.equal(refreshed.pairId, dormant.pairId);
    assert.equal(refreshed.verdict, "contradicts");
    assert.equal(refreshed.confidence, 0.5);
    assert.equal(refreshed.resolution, undefined);
    assert.equal(refreshed.lastReviewedAt, undefined);
    assert.equal(readPair(dir, dormant.pairId)?.verdict, "contradicts");

    const unresolved = listPairs(dir, { filter: "unresolved" });
    assert.equal(unresolved.total, 1);
    assert.equal(unresolved.pairs[0]?.pairId, dormant.pairId);
    assert.equal(unresolved.pairs[0]?.verdict, "contradicts");
  } finally {
    await cleanup();
  }
});

test("writePair refreshes expired both-valid resolutions with actionable results", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const expiredAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const written = writePair(dir, makePair({ confidence: 0.95 }));
    const resolved = resolvePair(dir, written.pairId, "both-valid");
    assert.ok(resolved);
    await writeStoredPair(dir, {
      ...resolved,
      lastReviewedAt: expiredAt,
    });

    const refreshed = writePair(dir, makePair({
      verdict: "contradicts",
      confidence: 0.5,
      rationale: "Fresh actionable judge result after both-valid cooldown",
    }), { cooldownDays: 14 });

    assert.equal(refreshed.pairId, written.pairId);
    assert.equal(refreshed.verdict, "contradicts");
    assert.equal(refreshed.confidence, 0.5);
    assert.equal(refreshed.resolution, undefined);
    assert.equal(refreshed.lastReviewedAt, undefined);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
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

test("listPairs can include legacy unscoped pairs for a namespace filter", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const legacy = writePair(dir, makePair({ memoryIds: ["legacy-a", "legacy-b"] }));
    writePair(dir, makePair({ namespace: "other", memoryIds: ["other-a", "other-b"] }));

    const result = listPairs(dir, { namespace: "default", includeUnscopedForNamespace: true });

    assert.equal(result.total, 1);
    assert.equal(result.pairs[0]?.pairId, legacy.pairId);
    assert.equal(result.pairs[0]?.namespace, undefined);
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace adopts legacy unscoped review pairs", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const legacy = writePair(dir, makePair({ memoryIds: ["legacy-a", "legacy-b"] }));
    writePair(dir, makePair({ namespace: "other", memoryIds: ["other-a", "other-b"] }));

    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);

    const migrated = listPairs(dir, { filter: "all", namespace: "default" }).pairs;
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0]!.namespace, "default");
    assert.equal(migrated[0]!.pairId, computePairId("legacy-a", "legacy-b", "default"));
    assert.equal(readPair(dir, legacy.pairId), null);

    const other = listPairs(dir, { filter: "all", namespace: "other" }).pairs;
    assert.equal(other.length, 1);
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace skips review directory scan after completion marker", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    writePair(dir, makePair({ memoryIds: ["legacy-a", "legacy-b"] }));
    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);

    const reviewPath = path.join(dir, ".review", "contradictions");
    const originalReaddirSync = fs.readdirSync;
    const callOriginalReaddirSync = originalReaddirSync as unknown as (...args: unknown[]) => unknown;
    const fsMutable = fs as unknown as { readdirSync: typeof fs.readdirSync };
    let reviewDirScans = 0;
    try {
      fsMutable.readdirSync = ((...args: unknown[]) => {
        if (String(args[0]) === reviewPath) reviewDirScans += 1;
        return callOriginalReaddirSync(...args);
      }) as typeof fs.readdirSync;

      assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 0);
      assert.equal(reviewDirScans, 0);
    } finally {
      fsMutable.readdirSync = originalReaddirSync;
    }

    const lateLegacy = writePair(dir, makePair({ memoryIds: ["late-a", "late-b"] }));
    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);
    assert.equal(readPair(dir, lateLegacy.pairId), null);
    assert.equal(readPair(dir, computePairId("late-a", "late-b", "default"))?.namespace, "default");
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace preserves legacy both-valid state on scoped collisions", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const scoped = writePair(dir, makePair({
      namespace: "default",
      memoryIds: ["shared-a", "shared-b"],
      verdict: "contradicts",
      confidence: 0.95,
      detectedAt: "2026-01-01T00:00:00.000Z",
    }));
    const legacy: ContradictionPair = {
      ...makePair({
        memoryIds: ["shared-a", "shared-b"],
        verdict: "independent",
        resolution: "both-valid",
        lastReviewedAt: "2026-02-01T00:00:00.000Z",
        detectedAt: "2026-01-15T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b"),
    };
    await writeStoredPair(dir, legacy);

    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);

    const migrated = readPair(dir, scoped.pairId);
    assert.ok(migrated);
    assert.equal(migrated.namespace, "default");
    assert.equal(migrated.resolution, "both-valid");
    assert.equal(migrated.verdict, "independent");
    assert.equal(migrated.lastReviewedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(readPair(dir, legacy.pairId), null);
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace preserves legacy cooldown state on scoped collisions", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const scoped = writePair(dir, makePair({
      namespace: "default",
      memoryIds: ["shared-a", "shared-b"],
      verdict: "contradicts",
      confidence: 0.95,
      detectedAt: "2026-01-01T00:00:00.000Z",
    }));
    const legacy: ContradictionPair = {
      ...makePair({
        memoryIds: ["shared-a", "shared-b"],
        verdict: "independent",
        lastReviewedAt: "2026-02-01T00:00:00.000Z",
        detectedAt: "2026-01-15T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b"),
    };
    await writeStoredPair(dir, legacy);

    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);

    const migrated = readPair(dir, scoped.pairId);
    assert.ok(migrated);
    assert.equal(migrated.namespace, "default");
    assert.equal(migrated.verdict, "independent");
    assert.equal(migrated.lastReviewedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(readPair(dir, legacy.pairId), null);
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace preserves scoped conflicts over expired legacy cooldowns", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const scoped = writePair(dir, makePair({
      namespace: "default",
      memoryIds: ["shared-a", "shared-b"],
      verdict: "contradicts",
      confidence: 0.95,
      detectedAt: "2026-04-01T00:00:00.000Z",
    }));
    const legacy: ContradictionPair = {
      ...makePair({
        memoryIds: ["shared-a", "shared-b"],
        verdict: "independent",
        lastReviewedAt: "2020-01-01T00:00:00.000Z",
        detectedAt: "2020-01-01T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b"),
    };
    await writeStoredPair(dir, legacy);

    assert.equal(migrateUnscopedPairsToNamespace(dir, "default", { cooldownDays: 14 }), 1);

    const migrated = readPair(dir, scoped.pairId);
    assert.ok(migrated);
    assert.equal(migrated.namespace, "default");
    assert.equal(migrated.verdict, "contradicts");
    assert.equal(migrated.resolution, undefined);
    assert.equal(readPair(dir, legacy.pairId), null);
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace preserves existing terminal scoped state on collisions", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const scoped: ContradictionPair = {
      ...makePair({
        namespace: "default",
        memoryIds: ["shared-a", "shared-b"],
        verdict: "contradicts",
        resolution: "keep-a",
        lastReviewedAt: "2026-01-01T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b", "default"),
    };
    await writeStoredPair(dir, scoped);
    const legacy: ContradictionPair = {
      ...makePair({
        memoryIds: ["shared-a", "shared-b"],
        verdict: "independent",
        resolution: "both-valid",
        lastReviewedAt: "2026-02-01T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b"),
    };
    await writeStoredPair(dir, legacy);

    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);

    const migrated = readPair(dir, scoped.pairId);
    assert.ok(migrated);
    assert.equal(migrated.namespace, "default");
    assert.equal(migrated.resolution, "keep-a");
    assert.equal(migrated.verdict, "contradicts");
    assert.equal(readPair(dir, legacy.pairId), null);
  } finally {
    await cleanup();
  }
});

test("migrateUnscopedPairsToNamespace keeps selected memory order on scoped collisions", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const scoped: ContradictionPair = {
      ...makePair({
        namespace: "default",
        memoryIds: ["shared-b", "shared-a"],
        verdict: "contradicts",
        resolution: "keep-a",
        lastReviewedAt: "2026-01-01T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b", "default"),
    };
    await writeStoredPair(dir, scoped);
    const legacy: ContradictionPair = {
      ...makePair({
        memoryIds: ["shared-a", "shared-b"],
        verdict: "independent",
        resolution: "both-valid",
        lastReviewedAt: "2026-02-01T00:00:00.000Z",
      }),
      pairId: computePairId("shared-a", "shared-b"),
    };
    await writeStoredPair(dir, legacy);

    assert.equal(migrateUnscopedPairsToNamespace(dir, "default"), 1);

    const migrated = readPair(dir, scoped.pairId);
    assert.ok(migrated);
    assert.equal(migrated.resolution, "keep-a");
    assert.deepEqual(migrated.memoryIds, ["shared-b", "shared-a"]);
    assert.equal(readPair(dir, legacy.pairId), null);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan loads memories from namespace-scoped storage", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const ns1A = makeMemory("ns1-a");
    ns1A.frontmatter.entityRef = "entity:shared";
    const ns1B = makeMemory("ns1-b");
    ns1B.frontmatter.entityRef = "entity:shared";
    const ns2A = makeMemory("ns2-a");
    ns2A.frontmatter.entityRef = "entity:shared";

    const rootStorage = makeScanStorage([ns1A, ns1B, ns2A]);
    const ns1Storage = makeScanStorage([ns1A, ns1B]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
        topicOverlapFloor: 0,
        similarityFloor: 0,
      },
    });

    const result = await runContradictionScan({
      storage: rootStorage,
      storageForNamespace(namespace) {
        assert.equal(namespace, "ns1");
        return ns1Storage;
      },
      config,
      memoryDir: dir,
      localLlm: null,
      fallbackLlm: null,
      namespace: "ns1",
    });

    assert.equal(rootStorage.readCount, 0);
    assert.equal(ns1Storage.readCount, 1);
    assert.equal(result.scanned, 2);
    assert.equal(result.judged, 1);
    assert.equal(result.queued, 1);

    const queued = listPairs(dir, { filter: "all", namespace: "ns1" }).pairs;
    assert.equal(queued.length, 1);
    assert.deepEqual([...queued[0]!.memoryIds].sort(), ["ns1-a", "ns1-b"]);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan caps candidates during generation and preserves strategy priority", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const entityA = makeMemory("entity-a");
    entityA.frontmatter.entityRef = "entity:shared";
    const entityB = makeMemory("entity-b");
    entityB.frontmatter.entityRef = "entity:shared";

    const topicA = makeMemory("topic-a");
    topicA.frontmatter.tags = ["shared-topic"];
    const topicB = makeMemory("topic-b");
    topicB.frontmatter.tags = ["shared-topic"];

    const embedA = makeMemory("embed-0-a");
    embedA.frontmatter.tags = ["embed-a"];
    const embedB = makeMemory("embed-0-b");
    embedB.frontmatter.tags = ["embed-b"];

    const storage = makeScanStorage([embedB, topicB, entityB, embedA, topicA, entityA]);
    const config = parseConfig({
      memoryDir: dir,
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 2,
        topicOverlapFloor: 0.5,
        similarityFloor: 0.8,
      },
    });
    let embeddingCalls = 0;

    const result = await runContradictionScan({
      storage,
      config,
      memoryDir: dir,
      embeddingLookup: async (content) => {
        embeddingCalls += 1;
        return content === embedA.content ? [{ id: "embed-0-b", score: 0.99 }] : [];
      },
      localLlm: null,
      fallbackLlm: null,
    });

    assert.equal(result.candidates, 2);
    assert.equal(result.judged, 2);
    assert.equal(result.queued, 2);
    assert.equal(embeddingCalls, 0);

    const queuedPairs = listPairs(dir, { filter: "all" }).pairs
      .map((pair) => [...pair.memoryIds].sort().join(":"))
      .sort();
    assert.deepEqual(queuedPairs, ["entity-a:entity-b", "topic-a:topic-b"]);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan resolves default namespace scans through namespace storage resolver", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const defaultA = makeMemory("default-a");
    defaultA.frontmatter.entityRef = "entity:shared";
    const defaultB = makeMemory("default-b");
    defaultB.frontmatter.entityRef = "entity:shared";
    const rootOnly = makeMemory("root-only");
    rootOnly.frontmatter.entityRef = "entity:shared";

    const rootStorage = makeScanStorage([rootOnly]);
    const defaultStorage = makeScanStorage([defaultA, defaultB]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "configured-default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
        topicOverlapFloor: 0,
        similarityFloor: 0,
      },
    });

    const result = await runContradictionScan({
      storage: rootStorage,
      storageForNamespace(namespace) {
        assert.equal(namespace, undefined);
        return { storage: defaultStorage, namespace: "resolved-default" };
      },
      config,
      memoryDir: dir,
      localLlm: null,
      fallbackLlm: null,
    });

    assert.equal(rootStorage.readCount, 0);
    assert.equal(defaultStorage.readCount, 1);
    assert.equal(result.scanned, 2);

    const queued = listPairs(dir, { filter: "all", namespace: "resolved-default" }).pairs;
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.namespace, "resolved-default");
    assert.deepEqual([...queued[0]!.memoryIds].sort(), ["default-a", "default-b"]);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan treats StorageManager with storage property as raw storage", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const defaultA = makeMemory("default-a");
    defaultA.frontmatter.entityRef = "entity:shared";
    const defaultB = makeMemory("default-b");
    defaultB.frontmatter.entityRef = "entity:shared";
    const nestedOnly = makeMemory("nested-only");
    nestedOnly.frontmatter.entityRef = "entity:shared";

    const rawStorage = makeScanStorage([defaultA, defaultB]) as ReturnType<typeof makeScanStorage> & {
      storage: ReturnType<typeof makeScanStorage>;
    };
    rawStorage.storage = makeScanStorage([nestedOnly]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "configured-default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
        topicOverlapFloor: 0,
        similarityFloor: 0,
      },
    });

    const result = await runContradictionScan({
      storage: makeScanStorage([]),
      storageForNamespace() {
        return rawStorage;
      },
      config,
      memoryDir: dir,
      localLlm: null,
      fallbackLlm: null,
    });

    assert.equal(rawStorage.readCount, 1);
    assert.equal(rawStorage.storage.readCount, 0);
    assert.equal(result.scanned, 2);

    const queued = listPairs(dir, { filter: "all", namespace: "configured-default" }).pairs;
    assert.equal(queued.length, 1);
    assert.deepEqual([...queued[0]!.memoryIds].sort(), ["default-a", "default-b"]);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan migrates legacy unscoped cooldown pairs for default namespace scans", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const defaultA = makeMemory("default-a");
    defaultA.frontmatter.entityRef = "entity:shared";
    const defaultB = makeMemory("default-b");
    defaultB.frontmatter.entityRef = "entity:shared";
    writePair(dir, makePair({
      memoryIds: ["default-a", "default-b"],
      verdict: "independent",
      lastReviewedAt: new Date().toISOString(),
    }));

    const defaultStorage = makeScanStorage([defaultA, defaultB]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "configured-default",
      contradictionScan: {
        enabled: true,
        cooldownDays: 14,
        maxPairsPerRun: 10,
        topicOverlapFloor: 0,
        similarityFloor: 0,
      },
    });

    const result = await runContradictionScan({
      storage: makeScanStorage([]),
      storageForNamespace(namespace) {
        assert.equal(namespace, undefined);
        return { storage: defaultStorage, namespace: "resolved-default" };
      },
      config,
      memoryDir: dir,
      localLlm: null,
      fallbackLlm: null,
    });

    assert.equal(result.cooledDown, 1);
    assert.equal(result.judged, 0);
    assert.equal(result.queued, 0);

    const queued = listPairs(dir, { filter: "all", namespace: "resolved-default" }).pairs;
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.namespace, "resolved-default");
  } finally {
    await cleanup();
  }
});

test("runContradictionScan migrates legacy unscoped cooldown pairs for explicit default namespace scans", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const defaultA = makeMemory("default-a");
    defaultA.frontmatter.entityRef = "entity:shared";
    const defaultB = makeMemory("default-b");
    defaultB.frontmatter.entityRef = "entity:shared";
    writePair(dir, makePair({
      memoryIds: ["default-a", "default-b"],
      verdict: "independent",
      lastReviewedAt: new Date().toISOString(),
    }));

    const defaultStorage = makeScanStorage([defaultA, defaultB]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "configured-default",
      contradictionScan: {
        enabled: true,
        cooldownDays: 14,
        maxPairsPerRun: 10,
        topicOverlapFloor: 0,
        similarityFloor: 0,
      },
    });

    const result = await runContradictionScan({
      storage: makeScanStorage([]),
      storageForNamespace(namespace) {
        assert.equal(namespace, "configured-default");
        return { storage: defaultStorage, namespace: "configured-default" };
      },
      config,
      memoryDir: dir,
      localLlm: null,
      fallbackLlm: null,
      namespace: "configured-default",
    });

    assert.equal(result.cooledDown, 1);
    assert.equal(result.judged, 0);
    assert.equal(result.queued, 0);

    const queued = listPairs(dir, { filter: "all", namespace: "configured-default" }).pairs;
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.namespace, "configured-default");
  } finally {
    await cleanup();
  }
});

test("runContradictionScan rejects namespace scans without an access-checked storage resolver", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootStorage = makeScanStorage([makeMemory("root-a"), makeMemory("root-b")]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
      },
    });

    await assert.rejects(
      runContradictionScan({
        storage: rootStorage,
        config,
        memoryDir: dir,
        localLlm: null,
        fallbackLlm: null,
        namespace: "ns1",
      }),
      /storageForNamespace/,
    );

    assert.equal(rootStorage.readCount, 0);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan rejects default scans without an access-checked storage resolver when namespaces are enabled", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootStorage = makeScanStorage([makeMemory("root-a"), makeMemory("root-b")]);
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
      },
    });

    await assert.rejects(
      runContradictionScan({
        storage: rootStorage,
        config,
        memoryDir: dir,
        localLlm: null,
        fallbackLlm: null,
      }),
      /storageForNamespace/,
    );

    assert.equal(rootStorage.readCount, 0);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan rejects unsupported explicit namespaces when namespaces are disabled", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootStorage = makeScanStorage([makeMemory("root-a"), makeMemory("root-b")]);
    let resolverCalls = 0;
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: false,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
      },
    });

    await assert.rejects(
      runContradictionScan({
        storage: rootStorage,
        storageForNamespace() {
          resolverCalls += 1;
          return makeScanStorage([]);
        },
        config,
        memoryDir: dir,
        localLlm: null,
        fallbackLlm: null,
        namespace: "typo",
      }),
      /unsupported namespace: typo/,
    );

    assert.equal(resolverCalls, 0);
    assert.equal(rootStorage.readCount, 0);
  } finally {
    await cleanup();
  }
});

test("runContradictionScan ignores explicit default namespace when namespaces are disabled", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootA = makeMemory("root-a");
    rootA.frontmatter.entityRef = "entity:shared";
    const rootB = makeMemory("root-b");
    rootB.frontmatter.entityRef = "entity:shared";
    const rootStorage = makeScanStorage([rootA, rootB]);
    let resolverCalls = 0;
    const config = parseConfig({
      memoryDir: dir,
      namespacesEnabled: false,
      defaultNamespace: "default",
      contradictionScan: {
        enabled: true,
        maxPairsPerRun: 10,
        topicOverlapFloor: 0,
        similarityFloor: 0,
      },
    });

    const result = await runContradictionScan({
      storage: rootStorage,
      storageForNamespace() {
        resolverCalls += 1;
        return makeScanStorage([]);
      },
      config,
      memoryDir: dir,
      localLlm: null,
      fallbackLlm: null,
      namespace: "default",
    });

    assert.equal(resolverCalls, 0);
    assert.equal(rootStorage.readCount, 1);
    assert.equal(result.scanned, 2);
    assert.equal(result.queued, 1);
    assert.equal(listPairs(dir, { filter: "all", namespace: "default" }).pairs.length, 0);
    assert.equal(listPairs(dir, { filter: "all" }).pairs.length, 1);
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

test("executeResolution keep-a does not supersede when the kept memory is missing", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage();
    storage.memories.delete("mem-a-001");

    const result = await executeResolution(dir, storage, written.pairId, "keep-a");

    assert.match(result.message, /Kept memory mem-a-001 not found/);
    assert.deepEqual(result.affectedIds, []);
    assert.deepEqual(storage.supersedeCalls, []);
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.status, undefined);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution resolves namespaced pairs against namespace storage", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootStorage = makeResolutionStorage();
    rootStorage.memories.clear();
    const nsStorage = makeResolutionStorage();
    const written = writePair(dir, makePair({ namespace: "ns1" }));

    const result = await executeResolution(dir, rootStorage, written.pairId, "keep-a", {
      storageForNamespace(namespace) {
        assert.equal(namespace, "ns1");
        return nsStorage;
      },
    });

    assert.deepEqual(result.affectedIds, ["mem-b-002"]);
    assert.equal(rootStorage.supersedeCalls.length, 0);
    assert.deepEqual(nsStorage.supersedeCalls, [{
      oldId: "mem-b-002",
      newId: "mem-a-001",
      reason: "contradiction-resolution:keep-a",
    }]);
    assert.equal(readPair(dir, written.pairId)?.resolution, "keep-a");
  } finally {
    await cleanup();
  }
});

test("executeResolution rejects namespaced pairs without a storage resolver", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootStorage = makeResolutionStorage();
    const written = writePair(dir, makePair({ namespace: "ns1" }));

    await assert.rejects(
      () => executeResolution(dir, rootStorage, written.pairId, "keep-a"),
      /storageForNamespace/,
    );
    assert.equal(rootStorage.supersedeCalls.length, 0);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution checks namespace resolver before reporting already resolved pairs", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair: ContradictionPair = {
      ...makePair({
        namespace: "team",
        resolution: "both-valid",
        lastReviewedAt: "2026-01-01T00:00:00.000Z",
      }),
      pairId: computePairId("mem-a-001", "mem-b-002", "team"),
    };
    await writeStoredPair(dir, pair);
    const storage = makeResolutionStorage();
    let resolverCalls = 0;

    await assert.rejects(
      () => executeResolution(dir, storage, pair.pairId, "keep-a", {
        storageForNamespace(namespace) {
          resolverCalls += 1;
          assert.equal(namespace, "team");
          throw new Error("namespace denied");
        },
      }),
      /namespace denied/,
    );

    assert.equal(resolverCalls, 1);
    assert.equal(storage.supersedeCalls.length, 0);
  } finally {
    await cleanup();
  }
});

test("executeResolution resolves legacy unscoped pairs through default namespace storage", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const rootStorage = makeResolutionStorage();
    rootStorage.memories.clear();
    const defaultStorage = makeResolutionStorage();
    const written = writePair(dir, makePair());

    const result = await executeResolution(dir, rootStorage, written.pairId, "keep-a", {
      storageForNamespace(namespace) {
        assert.equal(namespace, undefined);
        return defaultStorage;
      },
    });

    assert.deepEqual(result.affectedIds, ["mem-b-002"]);
    assert.equal(rootStorage.supersedeCalls.length, 0);
    assert.deepEqual(defaultStorage.supersedeCalls, [{
      oldId: "mem-b-002",
      newId: "mem-a-001",
      reason: "contradiction-resolution:keep-a",
    }]);
    assert.equal(readPair(dir, written.pairId)?.resolution, "keep-a");
  } finally {
    await cleanup();
  }
});

test("executeResolution keep-b does not supersede when the kept memory is inactive", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage();
    const keepB = storage.memories.get("mem-b-002");
    assert.ok(keepB);
    storage.memories.set("mem-b-002", {
      ...keepB,
      frontmatter: {
        ...keepB.frontmatter,
        status: "superseded",
        supersededBy: "replacement",
      },
    });

    const result = await executeResolution(dir, storage, written.pairId, "keep-b");

    assert.match(result.message, /Kept memory mem-b-002 is superseded/);
    assert.deepEqual(result.affectedIds, []);
    assert.deepEqual(storage.supersedeCalls, []);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, undefined);
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution keep-a restores source after partial supersede failure", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage({ partialSupersedeBeforeFailureFor: "mem-b-002" });

    const result = await executeResolution(dir, storage, written.pairId, "keep-a");

    assert.match(result.message, /restored mem-b-002/);
    assert.deepEqual(result.affectedIds, []);
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.status, undefined);
    assert.equal(storage.memories.get("mem-b-002")?.frontmatter.supersededBy, undefined);
    assert.deepEqual(
      storage.frontmatterWrites.map(({ memoryId, beforeStatus, lifecycle }) => ({
        memoryId,
        beforeStatus,
        actor: lifecycle?.actor,
        reasonCode: lifecycle?.reasonCode,
      })),
      [
        {
          memoryId: "mem-b-002",
          beforeStatus: "superseded",
          actor: "contradiction-resolution",
          reasonCode: "contradiction-resolution:keep-a-rollback",
        },
      ],
    );
    assert.equal(readPair(dir, written.pairId)?.resolution, undefined);
  } finally {
    await cleanup();
  }
});

test("executeResolution keep-b restores source after partial supersede failure", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const storage = makeResolutionStorage({ partialSupersedeBeforeFailureFor: "mem-a-001" });

    const result = await executeResolution(dir, storage, written.pairId, "keep-b");

    assert.match(result.message, /restored mem-a-001/);
    assert.deepEqual(result.affectedIds, []);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.status, undefined);
    assert.equal(storage.memories.get("mem-a-001")?.frontmatter.supersededBy, undefined);
    assert.deepEqual(
      storage.frontmatterWrites.map(({ memoryId, beforeStatus, lifecycle }) => ({
        memoryId,
        beforeStatus,
        actor: lifecycle?.actor,
        reasonCode: lifecycle?.reasonCode,
      })),
      [
        {
          memoryId: "mem-a-001",
          beforeStatus: "superseded",
          actor: "contradiction-resolution",
          reasonCode: "contradiction-resolution:keep-b-rollback",
        },
      ],
    );
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
    const keepPair = writePair(dir, makePair());
    const keepResolved = resolvePair(dir, keepPair.pairId, "keep-a");
    assert.equal(keepResolved?.resolution, "keep-a");

    const deferredKeepViaResolve = resolvePair(dir, keepPair.pairId, "needs-more-context");
    assert.equal(deferredKeepViaResolve?.resolution, "keep-a");
    assert.equal(deferredKeepViaResolve?.deferredUntil, undefined);

    const deferredKeepDirectly = deferPair(dir, keepPair.pairId);
    assert.equal(deferredKeepDirectly?.resolution, "keep-a");
    assert.equal(deferredKeepDirectly?.deferredUntil, undefined);

    const bothValidPair = writePair(dir, makePair({ memoryIds: ["mem-a-003", "mem-b-004"] }));
    const bothValidResolved = resolvePair(dir, bothValidPair.pairId, "both-valid");
    assert.equal(bothValidResolved?.resolution, "both-valid");

    const deferredBothValidViaResolve = resolvePair(dir, bothValidPair.pairId, "needs-more-context");
    assert.equal(deferredBothValidViaResolve?.resolution, "both-valid");
    assert.equal(deferredBothValidViaResolve?.deferredUntil, undefined);

    const deferredBothValidDirectly = deferPair(dir, bothValidPair.pairId);
    assert.equal(deferredBothValidDirectly?.resolution, "both-valid");
    assert.equal(deferredBothValidDirectly?.deferredUntil, undefined);
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
