import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * Corpus watermark primitive (issue #2149) + pre-merge hardening (issue #2156).
 *
 * The digest is a per-partition, TIER-AWARE census fingerprint, so two daemons
 * that agree on per-day HOT and COLD file counts share a digest and a differing
 * digest is a cheap divergence signal. These tests pin that property plus the
 * census determinism (AGENTS.md pattern 26), the "newest write is scoped to the
 * newest HOT partition" contract, and the four #2156 findings: the cold-tier
 * census (D), the shared namespace resolver (C), the caller-capability filter
 * (B), and the TTL + single-flight cache (A).
 */
import test from "node:test";
import { parseConfig } from "./config.js";
import {
  type CorpusStorage,
  type CorpusWatermark,
  CorpusWatermarkCache,
  UNPARTITIONED_BUCKET,
  buildPartitionCensus,
  computeCorpusWatermark,
  computeServiceCorpusWatermarks,
  digestPartitionCensus,
} from "./corpus-watermark.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

async function makeMemoryDir(prefix = "remnic-corpus-wm-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMemory(memoryDir: string, rel: string): Promise<string> {
  const full = path.join(memoryDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `---\nid: ${path.basename(rel, ".md")}\n---\n\nbody\n`, "utf-8");
  return full;
}

/** Hot-tier scan only (the recall corpus). */
async function scanHot(memoryDir: string): Promise<{ paths: string[]; baseDir: string }> {
  const storage = new StorageManager(memoryDir);
  return { paths: await storage.collectActiveMemoryPaths(), baseDir: storage.dir };
}

/** Both tiers combined, exactly as the watermark builder feeds computeCorpusWatermark. */
async function scanBothTiers(memoryDir: string): Promise<{ paths: string[]; baseDir: string }> {
  const storage = new StorageManager(memoryDir);
  const [hot, cold] = await Promise.all([
    storage.collectActiveMemoryPaths(),
    storage.collectColdMemoryPaths(),
  ]);
  return { paths: [...hot, ...cold], baseDir: storage.dir };
}

function fakeStorage(dir: string, hotPaths: string[], coldPaths: string[] = []): CorpusStorage {
  return {
    dir,
    collectActiveMemoryPaths: async () => hotPaths,
    collectColdMemoryPaths: async () => coldPaths,
  };
}

/** A valid (parseConfig-normalized) service config rooted at `memoryDir`. */
function serviceConfig(memoryDir: string, overrides: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    captureMode: "implicit",
    namespacesEnabled: false,
    defaultNamespace: "global",
    ...overrides,
  });
}

// ── digest determinism (pattern 26) ──────────────────────────────────────────

test("digestPartitionCensus is insertion-order independent (Map and Record agree)", () => {
  const forward = new Map<string, number>([
    ["facts/2026-01-01", 2],
    ["procedures/2026-01-02", 5],
    [UNPARTITIONED_BUCKET, 1],
  ]);
  const reversed = new Map<string, number>([
    [UNPARTITIONED_BUCKET, 1],
    ["procedures/2026-01-02", 5],
    ["facts/2026-01-01", 2],
  ]);
  assert.equal(digestPartitionCensus(forward), digestPartitionCensus(reversed));

  const recordA = { "facts/2026-01-01": 2, "procedures/2026-01-02": 5, [UNPARTITIONED_BUCKET]: 1 };
  const recordB = { [UNPARTITIONED_BUCKET]: 1, "procedures/2026-01-02": 5, "facts/2026-01-01": 2 };
  assert.equal(digestPartitionCensus(recordA), digestPartitionCensus(recordB));
  assert.equal(digestPartitionCensus(forward), digestPartitionCensus(recordA));
});

test("digestPartitionCensus changes when a count changes", () => {
  const base = new Map<string, number>([["facts/2026-01-01", 2]]);
  const grown = new Map<string, number>([["facts/2026-01-01", 3]]);
  assert.notEqual(digestPartitionCensus(base), digestPartitionCensus(grown));
});

test("digestPartitionCensus changes when a bucket is added or removed", () => {
  const base = new Map<string, number>([["facts/2026-01-01", 2]]);
  const added = new Map<string, number>([
    ["facts/2026-01-01", 2],
    ["facts/2026-01-02", 1],
  ]);
  assert.notEqual(digestPartitionCensus(base), digestPartitionCensus(added));
  assert.notEqual(digestPartitionCensus(base), digestPartitionCensus(new Map<string, number>()));
});

// ── census bucketing (tier-aware) ────────────────────────────────────────────

test("buildPartitionCensus buckets by <tier>:<category>/<day>; non-day paths land in the explicit unpartitioned bucket", () => {
  const baseDir = path.join(os.tmpdir(), "mem-fixture");
  const paths = [
    path.join(baseDir, "facts/2026-01-01/a.md"),
    path.join(baseDir, "facts/2026-01-01/b.md"),
    path.join(baseDir, "procedures/2026-01-02/c.md"),
    path.join(baseDir, "facts/loose.md"),
    path.join(baseDir, "cold/facts/2026-01-01/d.md"),
  ];
  const census = buildPartitionCensus(paths, baseDir);
  assert.equal(census.get("hot:facts/2026-01-01"), 2);
  assert.equal(census.get("hot:procedures/2026-01-02"), 1);
  assert.equal(census.get(`hot:${UNPARTITIONED_BUCKET}`), 1);
  // The cold-tier file is bucketed separately, never folded into the hot count.
  assert.equal(census.get("cold:facts/2026-01-01"), 1);
});

// ── watermark computation ────────────────────────────────────────────────────

test("computeCorpusWatermark: an empty corpus yields a stable digest, null timestamps, and does not throw", async () => {
  const empty = await computeCorpusWatermark({ namespace: "global", paths: [], baseDir: "/mem" });
  const emptyElsewhere = await computeCorpusWatermark({ namespace: "global", paths: [], baseDir: "/other" });
  assert.equal(empty.memoryFileCount, 0);
  assert.equal(empty.newestPartition, null);
  assert.equal(empty.newestWriteAt, null);
  assert.equal(empty.digest, digestPartitionCensus(new Map<string, number>()));
  assert.equal(empty.digest, emptyElsewhere.digest);
});

test("computeCorpusWatermark: memoryFileCount matches the files written by the fixture", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    await writeMemory(memoryDir, "facts/2026-03-08/b.md");
    await writeMemory(memoryDir, "procedures/2026-03-09/c.md");
    const { paths, baseDir } = await scanHot(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.memoryFileCount, 3);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeCorpusWatermark: a memory without a day dir is counted in the unpartitioned bucket", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    await writeMemory(memoryDir, "facts/loose.md");
    const { paths, baseDir } = await scanHot(memoryDir);
    const census = buildPartitionCensus(paths, baseDir);
    assert.equal(census.get(`hot:${UNPARTITIONED_BUCKET}`), 1);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.memoryFileCount, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeCorpusWatermark: newestPartition is the lexicographically greatest date across day dirs", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-01/a.md");
    await writeMemory(memoryDir, "facts/2026-03-15/b.md");
    await writeMemory(memoryDir, "procedures/2026-03-10/c.md");
    const { paths, baseDir } = await scanHot(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.newestPartition, "2026-03-15");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeCorpusWatermark: newestWriteAt reflects the newest mtime IN the newest partition, not an older partition's newer file", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const olderPartitionFile = await writeMemory(memoryDir, "facts/2026-03-08/old.md");
    const newestPartitionFile = await writeMemory(memoryDir, "facts/2026-03-10/new.md");
    // Deliberately make the OLDER partition's file the newest on disk.
    const newestPartitionMtime = new Date("2026-03-10T00:00:00.000Z");
    const olderPartitionButNewerOnDisk = new Date("2030-01-01T00:00:00.000Z");
    await utimes(newestPartitionFile, newestPartitionMtime, newestPartitionMtime);
    await utimes(olderPartitionFile, olderPartitionButNewerOnDisk, olderPartitionButNewerOnDisk);

    const { paths, baseDir } = await scanHot(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.newestPartition, "2026-03-10");
    assert.equal(watermark.newestWriteAt, newestPartitionMtime.toISOString());
    assert.notEqual(watermark.newestWriteAt, olderPartitionButNewerOnDisk.toISOString());
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("two corpora with identical layouts share a digest; adding one file diverges it (the detection property)", async () => {
  const dirA = await makeMemoryDir("remnic-corpus-wm-a-");
  const dirB = await makeMemoryDir("remnic-corpus-wm-b-");
  try {
    for (const dir of [dirA, dirB]) {
      await writeMemory(dir, "facts/2026-03-08/a.md");
      await writeMemory(dir, "facts/2026-03-08/b.md");
      await writeMemory(dir, "procedures/2026-03-09/c.md");
    }
    const scanA = await scanHot(dirA);
    const scanB = await scanHot(dirB);
    const watermarkA = await computeCorpusWatermark({ namespace: "global", paths: scanA.paths, baseDir: scanA.baseDir });
    const watermarkB = await computeCorpusWatermark({ namespace: "global", paths: scanB.paths, baseDir: scanB.baseDir });
    assert.equal(watermarkA.digest, watermarkB.digest);

    await writeMemory(dirB, "facts/2026-03-08/d.md");
    const scanB2 = await scanHot(dirB);
    const watermarkB2 = await computeCorpusWatermark({ namespace: "global", paths: scanB2.paths, baseDir: scanB2.baseDir });
    assert.notEqual(watermarkA.digest, watermarkB2.digest);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

// ── finding D: cold-tier census ──────────────────────────────────────────────

test("finding D: moving a memory from hot to cold changes the digest while the count is unchanged", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const hotFile = await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    const hotScan = await scanBothTiers(memoryDir);
    const hotWatermark = await computeCorpusWatermark({ namespace: "global", ...hotScan });

    // Demote: same memory, same day-partition, now under cold/.
    await rm(hotFile);
    await writeMemory(memoryDir, "cold/facts/2026-03-08/a.md");
    const coldScan = await scanBothTiers(memoryDir);
    const coldWatermark = await computeCorpusWatermark({ namespace: "global", ...coldScan });

    assert.equal(hotWatermark.memoryFileCount, 1);
    assert.equal(coldWatermark.memoryFileCount, 1, "cold memories still count as active");
    assert.notEqual(
      hotWatermark.digest,
      coldWatermark.digest,
      "a hot->cold demotion must change the digest even though the count is identical",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("finding D: a replica missing a cold file diverges from one that has it", async () => {
  const dirA = await makeMemoryDir("remnic-corpus-wm-a-");
  const dirB = await makeMemoryDir("remnic-corpus-wm-b-");
  try {
    for (const dir of [dirA, dirB]) {
      await writeMemory(dir, "facts/2026-03-08/hot.md");
    }
    // Only replica A holds the cold memory; the hot tiers are identical.
    await writeMemory(dirA, "cold/facts/2026-03-08/cold.md");

    const scanA = await scanBothTiers(dirA);
    const scanB = await scanBothTiers(dirB);
    const wmA = await computeCorpusWatermark({ namespace: "global", ...scanA });
    const wmB = await computeCorpusWatermark({ namespace: "global", ...scanB });

    assert.equal(wmA.memoryFileCount, 2);
    assert.equal(wmB.memoryFileCount, 1);
    assert.notEqual(wmA.digest, wmB.digest, "differing cold tiers must diverge the digest, not read as converged");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("finding D: cold files count in the census but never advance the newest-write freshness probe", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const hotFile = await writeMemory(memoryDir, "facts/2026-03-08/hot.md");
    const coldFile = await writeMemory(memoryDir, "cold/facts/2030-01-01/cold.md");
    // Make the COLD file the newest on disk AND in a later-dated partition.
    const hotMtime = new Date("2026-03-08T00:00:00.000Z");
    const coldMtime = new Date("2030-01-01T00:00:00.000Z");
    await utimes(hotFile, hotMtime, hotMtime);
    await utimes(coldFile, coldMtime, coldMtime);

    const scan = await scanBothTiers(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", ...scan });
    assert.equal(watermark.newestPartition, "2026-03-08", "newest partition is scoped to the hot tier");
    assert.equal(watermark.newestWriteAt, hotMtime.toISOString(), "freshness ignores the newer cold file");
    assert.equal(watermark.memoryFileCount, 2, "but the cold file still counts in the census");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager.collectColdMemoryPaths finds cold files and leaves the hot recall scan untouched", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/hot.md");
    await writeMemory(memoryDir, "cold/facts/2026-03-08/cold.md");
    const storage = new StorageManager(memoryDir);
    const hot = await storage.collectActiveMemoryPaths();
    const cold = await storage.collectColdMemoryPaths();
    assert.equal(hot.length, 1, "the hot recall scan must not pick up cold files");
    assert.ok(hot[0]?.endsWith(path.join("facts", "2026-03-08", "hot.md")));
    assert.equal(cold.length, 1, "the cold scan finds demoted memories under cold/");
    assert.ok(cold[0]?.includes(`${path.sep}cold${path.sep}`));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── service (/health) watermark builder + finding C (shared resolver) ─────────

test("computeServiceCorpusWatermarks: namespaces disabled -> single default-namespace watermark", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const config = serviceConfig(memoryDir, { namespacesEnabled: false, defaultNamespace: "global" });
    const host = {
      config,
      getStorage: (_namespace: string) =>
        fakeStorage("/mem", ["/mem/facts/2026-03-08/a.md", "/mem/facts/2026-03-08/b.md"]),
    };
    const result = await computeServiceCorpusWatermarks(host);
    assert.equal(result.length, 1, "flat-root deployment reports its shared corpus once");
    assert.equal(result[0]?.namespace, "global");
    assert.equal(result[0]?.memoryFileCount, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("finding C: with the catalog opted out, config-driven enumeration still covers every tenant", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    // A tenant present on disk but NOT surfaced by the (opted-out) live catalog.
    await writeMemory(memoryDir, "namespaces/team-a/facts/2026-03-08/x.md");
    const config = serviceConfig(memoryDir, { namespacesEnabled: true, defaultNamespace: "global" });
    const host = {
      config,
      // Empty catalog === opted out: the pre-fix health path returned ONLY the default here.
      namespaceCatalog: { listNamespaces: async () => [] },
      getStorage: (namespace: string) => fakeStorage(`/mem/${namespace}`, [`/mem/${namespace}/facts/2026-03-08/x.md`]),
    };
    const names = (await computeServiceCorpusWatermarks(host)).map((w) => w.namespace);
    assert.ok(names.includes("global"), "default namespace present");
    assert.ok(
      names.includes("team-a"),
      "config-driven enumeration finds the on-disk tenant even though the catalog is empty",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── finding B: caller-capability filter ──────────────────────────────────────

test("finding B: a namespace-restricted token sees only the namespaces it may access", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "namespaces/team-a/facts/2026-03-08/x.md");
    const config = serviceConfig(memoryDir, { namespacesEnabled: true, defaultNamespace: "global" });
    const host = {
      config,
      getStorage: (namespace: string) => fakeStorage(`/mem/${namespace}`, [`/mem/${namespace}/facts/2026-03-08/x.md`]),
    };
    const restricted = await computeServiceCorpusWatermarks(host, {
      caps: { version: 1, namespaces: ["team-a"] },
    });
    assert.deepEqual(
      restricted.map((w) => w.namespace),
      ["team-a"],
      "a token scoped to team-a must not learn any other tenant's name, count, or digest",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("finding B: an unrestricted/operator token keeps the full fleet view", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "namespaces/team-a/facts/2026-03-08/x.md");
    const config = serviceConfig(memoryDir, { namespacesEnabled: true, defaultNamespace: "global" });
    const host = {
      config,
      getStorage: (namespace: string) => fakeStorage(`/mem/${namespace}`, [`/mem/${namespace}/facts/2026-03-08/x.md`]),
    };
    const names = (await computeServiceCorpusWatermarks(host, { caps: { version: 1 } })).map((w) => w.namespace);
    assert.ok(names.includes("global") && names.includes("team-a"), "an unrestricted token sees all tenants");
    assert.ok(names.length >= 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── finding A: bounded TTL + single-flight cache ─────────────────────────────

test("finding A: the cache computes once for back-to-back calls and recomputes after the TTL expires", async () => {
  let now = 1_000;
  const cache = new CorpusWatermarkCache({ ttlMs: 60_000, clock: () => now });
  let computeCalls = 0;
  const compute = async (): Promise<CorpusWatermark> => {
    computeCalls += 1;
    return {
      namespace: "global",
      memoryFileCount: 0,
      newestPartition: null,
      newestWriteAt: null,
      digest: "d",
      computedAt: new Date(now).toISOString(),
    };
  };
  await cache.get("global", compute);
  await cache.get("global", compute);
  assert.equal(computeCalls, 1, "the second back-to-back probe is served from cache");
  now += 60_001;
  await cache.get("global", compute);
  assert.equal(computeCalls, 2, "the cache recomputes once the TTL has elapsed");
});

test("finding A: concurrent probes for one namespace collapse to a single computation", async () => {
  const cache = new CorpusWatermarkCache();
  let computeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compute = async (): Promise<CorpusWatermark> => {
    computeCalls += 1;
    await gate;
    return {
      namespace: "global",
      memoryFileCount: 0,
      newestPartition: null,
      newestWriteAt: null,
      digest: "d",
      computedAt: "t",
    };
  };
  const first = cache.get("global", compute);
  const second = cache.get("global", compute);
  release();
  await Promise.all([first, second]);
  assert.equal(computeCalls, 1, "N in-flight probes trigger ONE computation, not N corpus scans");
});

test("finding A: with a cache, two /health probes trigger ONE corpus scan", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const config = serviceConfig(memoryDir, { namespacesEnabled: false, defaultNamespace: "global" });
    let scans = 0;
    const storage: CorpusStorage = {
      dir: "/mem",
      collectActiveMemoryPaths: async () => {
        scans += 1;
        return ["/mem/facts/2026-03-08/a.md"];
      },
      collectColdMemoryPaths: async () => [],
    };
    const host = { config, getStorage: (_namespace: string) => storage };
    const cache = new CorpusWatermarkCache();
    await computeServiceCorpusWatermarks(host, { cache });
    await computeServiceCorpusWatermarks(host, { cache });
    assert.equal(scans, 1, "the path-collector runs once across two cached probes");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeServiceCorpusWatermarks: one failing namespace is omitted, not the whole payload (per-namespace degrade)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "namespaces/team-a/facts/2026-03-08/x.md");
    const config = serviceConfig(memoryDir, { namespacesEnabled: true, defaultNamespace: "global" });
    const host = {
      config,
      getStorage: (namespace: string) => {
        if (namespace === "team-a") throw new Error("storage unavailable for this tenant");
        return fakeStorage(`/mem/${namespace}`, [`/mem/${namespace}/facts/2026-03-08/x.md`]);
      },
    };
    const names = (await computeServiceCorpusWatermarks(host)).map((w) => w.namespace);
    assert.ok(names.includes("global"), "a healthy namespace is still reported");
    assert.ok(!names.includes("team-a"), "the failing namespace is omitted");
    assert.ok(names.length >= 1, "a single bad namespace must not blank the whole corpus payload");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
