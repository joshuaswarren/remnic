import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * Corpus watermark primitive (issue #2149) + pre-merge hardening (issue #2156).
 *
 * The digest is a per-partition, TIER-AWARE census fingerprint, so two daemons
 * that agree on per-day HOT and COLD file counts share a digest and a differing
 * digest is a cheap divergence signal. These tests pin that property, the census
 * determinism (AGENTS.md pattern 26), the "newest write is scoped to the newest
 * HOT partition" contract, and the #2156 findings across review rounds: the
 * cold-tier census (D), the shared config-driven namespace resolver (C), the
 * caller-capability filter (B), the stale-while-revalidate cache (A), the
 * per-namespace degrade, the migration-race retry, and fail-distinct scans.
 */
import test from "node:test";
import { parseConfig } from "./config.js";
import {
  type CorpusNamespaceRoot,
  type CorpusStorage,
  type CorpusWatermark,
  CorpusWatermarkCache,
  UNPARTITIONED_BUCKET,
  buildPartitionCensus,
  computeCorpusWatermark,
  computeCorpusWatermarks,
  computeServiceCorpusCensus,
  computeServiceCorpusWatermarks,
  digestPartitionCensus,
  resolveCorpusNamespaceRoots,
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

function sampleWatermark(namespace = "global"): CorpusWatermark {
  return {
    namespace,
    memoryFileCount: 0,
    newestPartition: null,
    newestWriteAt: null,
    digest: "d",
    computedAt: "t",
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

test("computeCorpusWatermark: computedAt is stamped and reflects the invocation, not passed as a stale literal", async () => {
  // Finding round-4: computedAt is captured AFTER the (possibly slow) stat loop.
  const before = Date.now();
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    const { paths, baseDir } = await scanHot(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    const stampedMs = Date.parse(watermark.computedAt);
    assert.ok(Number.isFinite(stampedMs), "computedAt is a valid ISO timestamp");
    assert.ok(stampedMs >= before, "computedAt is not stamped before the scan began");
    // An explicit `now` still wins (deterministic callers).
    const fixed = await computeCorpusWatermark({ namespace: "global", paths, baseDir, now: new Date("2026-01-01T00:00:00.000Z") });
    assert.equal(fixed.computedAt, "2026-01-01T00:00:00.000Z");
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
    assert.equal(coldWatermark.memoryFileCount, 1, "cold memories still count");
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

// ── finding C / round-4: one shared, config-driven namespace resolver ─────────

test("resolveCorpusNamespaceRoots: config-driven enumeration is deterministic and covers on-disk tenants", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "namespaces/team-a/facts/2026-03-08/x.md");
    const config = serviceConfig(memoryDir, { namespacesEnabled: true, defaultNamespace: "global" });
    // Both /health and the doctor call this ONE helper with just `{ config }`, so
    // identical output here is what guarantees the two surfaces cannot drift.
    const a = (await resolveCorpusNamespaceRoots({ config })).map((r) => r.namespace).sort();
    const b = (await resolveCorpusNamespaceRoots({ config })).map((r) => r.namespace).sort();
    assert.deepEqual(a, b, "the shared resolver is deterministic for a given config");
    assert.ok(a.includes("global") && a.includes("team-a"), "config-driven enumeration finds on-disk tenants");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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
    // A tenant present on disk; there is NO persisted catalog (opted out). The
    // pre-fix health path returned ONLY the default namespace here.
    await writeMemory(memoryDir, "namespaces/team-a/facts/2026-03-08/x.md");
    const config = serviceConfig(memoryDir, { namespacesEnabled: true, defaultNamespace: "global" });
    const host = {
      config,
      getStorage: (namespace: string) => fakeStorage(`/mem/${namespace}`, [`/mem/${namespace}/facts/2026-03-08/x.md`]),
    };
    const names = (await computeServiceCorpusWatermarks(host)).map((w) => w.namespace);
    assert.ok(names.includes("global"), "default namespace present");
    assert.ok(names.includes("team-a"), "config-driven enumeration finds the on-disk tenant despite an empty catalog");
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

// ── per-namespace degrade + fail-distinct scans ──────────────────────────────

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

test("finding round-4/5: an unreadable corpus root is omitted, not published as false-empty; ENOENT stays empty", async () => {
  const root = await makeMemoryDir();
  try {
    // A regular FILE used as a namespace base dir: the strict scan hits ENOTDIR
    // walking its category children — a backend read failure it must propagate,
    // portably (no permission bits, so it holds even for the superuser).
    const brokenBase = path.join(root, "broken-base");
    await writeFile(brokenBase, "not a directory", "utf-8");
    // A never-created base dir is ENOENT => a genuine empty corpus.
    const missingBase = path.join(root, "never-created");

    const watermarks = await computeCorpusWatermarks(
      ["broken", "empty"],
      (namespace) => new StorageManager(namespace === "broken" ? brokenBase : missingBase),
    );
    const names = watermarks.map((w) => w.namespace);
    assert.ok(!names.includes("broken"), "an unreadable corpus root is omitted, not counted as zero");
    assert.ok(names.includes("empty"), "a not-yet-created (ENOENT) namespace is a legitimate empty corpus");
    assert.equal(watermarks.find((w) => w.namespace === "empty")?.memoryFileCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finding round-5: an unreadable NESTED category dir propagates (partial census is omitted, not published)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    const lockedDir = path.join(memoryDir, "procedures");
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o000);
    // The superuser bypasses directory permissions; only assert where the OS
    // actually enforces them (probe the exact op the walker performs).
    let enforced = false;
    try {
      await readdir(lockedDir);
    } catch {
      enforced = true;
    }
    try {
      const watermarks = await computeCorpusWatermarks(["global"], () => new StorageManager(memoryDir));
      if (enforced) {
        assert.deepEqual(watermarks, [], "an unreadable category dir omits the namespace, not a partial count");
      } else {
        // perms bypassed (superuser): the scan succeeds and counts the readable hot file.
        assert.equal(watermarks.length, 1);
        assert.equal(watermarks[0]?.memoryFileCount, 1);
      }
    } finally {
      await chmod(lockedDir, 0o755); // restore so rm() can clean up
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── migration-race retry ─────────────────────────────────────────────────────

test("computeNamespaceWatermark: retries when a corpus-mutation sentinel changes mid-scan (tier-migration race)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    let scanVersion = 0;
    let racesLeft = 1; // a single racing write during the first attempt, then stable
    let collectCalls = 0;
    const storage: CorpusStorage = {
      dir: memoryDir, // a real dir for the watermark baseDir
      getCorpusScanVersion: async () => String(scanVersion),
      collectActiveMemoryPaths: async () => {
        collectCalls += 1;
        if (racesLeft > 0) {
          racesLeft -= 1;
          scanVersion += 1; // a tier write lands between the before/after sentinel reads
        }
        return [path.join(memoryDir, "facts/2026-03-08/a.md")];
      },
      collectColdMemoryPaths: async () => [],
    };
    const [watermark] = await computeCorpusWatermarks(["global"], () => storage);
    assert.equal(collectCalls, 2, "a sentinel change mid-scan triggers exactly one retry");
    assert.equal(watermark?.memoryFileCount, 1, "the retried snapshot is returned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeNamespaceWatermark: a stable sentinel scans once (no needless retry)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    let collectCalls = 0;
    const storage: CorpusStorage = {
      dir: memoryDir,
      getCorpusScanVersion: async () => "stable",
      collectActiveMemoryPaths: async () => {
        collectCalls += 1;
        return [];
      },
      collectColdMemoryPaths: async () => [],
    };
    await computeCorpusWatermarks(["global"], () => storage);
    assert.equal(collectCalls, 1, "a consistent snapshot is not re-scanned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeNamespaceWatermark: throws (namespace omitted) when the sentinel never stabilizes", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    let scanVersion = 0;
    let collectCalls = 0;
    const storage: CorpusStorage = {
      dir: memoryDir,
      getCorpusScanVersion: async () => String(scanVersion),
      collectActiveMemoryPaths: async () => {
        collectCalls += 1;
        scanVersion += 1; // a write races EVERY attempt (sustained churn)
        return [path.join(memoryDir, "facts/2026-03-08/a.md")];
      },
      collectColdMemoryPaths: async () => [],
    };
    const watermarks = await computeCorpusWatermarks(["global"], () => storage);
    assert.deepEqual(watermarks, [], "a never-stable census is omitted, not cached as a transient snapshot");
    assert.ok(collectCalls >= 2, "it retried before giving up");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── finding A: stale-while-revalidate TTL + single-flight cache ───────────────

test("finding A: the cache computes once for back-to-back calls and recomputes after the TTL expires", async () => {
  let now = 1_000;
  const cache = new CorpusWatermarkCache({ ttlMs: 60_000, clock: () => now });
  let computeCalls = 0;
  const compute = async (): Promise<CorpusWatermark> => {
    computeCalls += 1;
    return sampleWatermark();
  };
  assert.equal(cache.get("global", compute), undefined, "cold start returns nothing and refreshes in the background");
  await cache.whenIdle();
  const warm = cache.get("global", compute);
  assert.ok(warm, "the value is served once the background refresh settles");
  assert.equal(computeCalls, 1, "a fresh entry is not recomputed");
  now += 60_001;
  cache.get("global", compute); // stale -> triggers a background refresh
  await cache.whenIdle();
  assert.equal(computeCalls, 2, "the cache recomputes once the TTL has elapsed");
});

test("finding A: a probe serves the stale value immediately while revalidating (never blocks on the scan)", async () => {
  let now = 1_000;
  const cache = new CorpusWatermarkCache({ ttlMs: 60_000, clock: () => now });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let computeCalls = 0;
  const first = sampleWatermark();
  const compute = async (): Promise<CorpusWatermark> => {
    computeCalls += 1;
    if (computeCalls === 1) return first; // warm the cache promptly
    await gate; // the second (revalidation) scan is slow
    return { ...sampleWatermark(), digest: "d2" };
  };
  cache.get("global", compute);
  await cache.whenIdle(); // entry is now warm with `first`
  now += 60_001; // expire

  const served = cache.get("global", compute); // stale served immediately; revalidation in flight
  assert.equal(served?.digest, "d", "the probe gets the stale value without awaiting the slow rescan");
  assert.equal(computeCalls, 2, "a background revalidation was triggered");
  release();
  await cache.whenIdle();
  assert.equal(cache.get("global", compute)?.digest, "d2", "the refreshed value is served after revalidation");
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
    return sampleWatermark();
  };
  cache.get("global", compute);
  cache.get("global", compute);
  release();
  await cache.whenIdle();
  assert.equal(computeCalls, 1, "N in-flight probes trigger ONE background scan, not N");
});

test("finding A: with a cache, /health probes never re-run the corpus scan within the TTL", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const config = serviceConfig(memoryDir, { namespacesEnabled: false, defaultNamespace: "global" });
    let scans = 0;
    const storage: CorpusStorage = {
      dir: memoryDir,
      collectActiveMemoryPaths: async () => {
        scans += 1;
        return [path.join(memoryDir, "facts/2026-03-08/a.md")];
      },
      collectColdMemoryPaths: async () => [],
    };
    const host = { config, getStorage: (_namespace: string) => storage };
    const cache = new CorpusWatermarkCache();

    // Two stale-while-revalidate layers warm in turn (never blocking a probe):
    // 1st probe resolves nothing (enumeration in flight); 2nd sees the roots and
    // kicks off the corpus scan; 3rd serves the fully-warm watermark.
    assert.deepEqual(await computeServiceCorpusWatermarks(host, { cache }), [], "probe 1 never blocks (enumeration async)");
    await cache.whenIdle();
    assert.deepEqual(await computeServiceCorpusWatermarks(host, { cache }), [], "probe 2 never blocks (corpus scan async)");
    await cache.whenIdle();
    const warm = await computeServiceCorpusWatermarks(host, { cache });
    assert.equal(warm.length, 1, "the fully-warmed probe serves the cached watermark");
    assert.equal(scans, 1, "the path-collector runs exactly once across the probes");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── finding round-6: calendar validation + freshness-stat propagation ─────────

test("finding round-6: an impossible date-shaped dir is bucketed unpartitioned, not as a dated partition", () => {
  const baseDir = path.join(os.tmpdir(), "mem-fixture");
  const census = buildPartitionCensus(
    [
      path.join(baseDir, "facts/2026-03-08/a.md"),
      path.join(baseDir, "facts/2026-99-99/b.md"), // date-shaped but not a real calendar day
    ],
    baseDir,
  );
  assert.equal(census.get("hot:facts/2026-03-08"), 1);
  assert.equal(census.get(`hot:${UNPARTITIONED_BUCKET}`), 1, "the impossible date falls back to unpartitioned");
  assert.equal(census.get("hot:facts/2026-99-99"), undefined, "an impossible date is never a dated bucket");
});

test("finding round-6: an impossible date-shaped dir never becomes newestPartition", async () => {
  const paths = ["/mem/facts/2026-03-08/a.md", "/mem/facts/2026-99-99/b.md"];
  const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir: "/mem" });
  assert.equal(watermark.newestPartition, "2026-03-08", "the impossible date is not promoted above the valid partition");
  assert.equal(watermark.memoryFileCount, 2, "but both files still count in the census");
});

test("finding round-6: a non-ENOENT stat failure in the freshness loop propagates (not published as stale)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    const { paths, baseDir } = await scanHot(memoryDir);
    const partitionDir = path.join(memoryDir, "facts", "2026-03-08");
    await chmod(partitionDir, 0o000); // make stat() on the file (traverse its parent) fail
    let enforced = false;
    try {
      await stat(paths[0]); // probe the exact op the freshness loop performs
    } catch {
      enforced = true;
    }
    try {
      if (enforced) {
        await assert.rejects(
          () => computeCorpusWatermark({ namespace: "global", paths, baseDir }),
          "a backend stat failure propagates instead of publishing a stale/null freshness",
        );
      } else {
        const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
        assert.equal(watermark.memoryFileCount, 1, "perms bypassed (superuser): the scan simply succeeds");
      }
    } finally {
      await chmod(partitionDir, 0o755); // restore so rm() can clean up
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("finding round-7: namespace enumeration is cached (resolved once per TTL, served stale-while-revalidate)", async () => {
  let now = 1_000;
  const cache = new CorpusWatermarkCache({ ttlMs: 60_000, clock: () => now });
  let resolveCalls = 0;
  const resolve = async (): Promise<CorpusNamespaceRoot[]> => {
    resolveCalls += 1;
    return [{ namespace: "global", rootDir: "/mem", namespaces: ["global"] }];
  };
  assert.equal(cache.getResolvedRoots(resolve), undefined, "cold: nothing yet, enumerating in background");
  await cache.whenIdle();
  assert.equal(cache.getResolvedRoots(resolve)?.length, 1, "warm: served from cache");
  assert.equal(resolveCalls, 1, "back-to-back probes do not re-enumerate");
  now += 60_001;
  cache.getResolvedRoots(resolve); // stale -> background refresh
  await cache.whenIdle();
  assert.equal(resolveCalls, 2, "re-enumerated once the TTL elapsed");
});

test("finding round-9: background refresh scans are bounded to maxConcurrentRefreshes", async () => {
  const cache = new CorpusWatermarkCache({ maxConcurrentRefreshes: 2 });
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compute = async (): Promise<CorpusWatermark> => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return sampleWatermark();
  };
  for (const namespace of ["a", "b", "c", "d", "e"]) cache.get(namespace, compute);
  release();
  await cache.whenIdle();
  assert.ok(peak >= 1, "at least one scan ran");
  assert.ok(peak <= 2, `peak concurrent scans ${peak} must not exceed the cap (2), even with 5 cold namespaces`);
});

test("finding round-10: a token scoped to a non-representative alias still sees the shared-root corpus", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    // namespaces disabled: default (global) and shared collapse onto memoryDir,
    // so `global` wins dedupe. A token scoped to `shared` must still see it.
    const config = serviceConfig(memoryDir, {
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
    });
    const host = {
      config,
      getStorage: (_namespace: string) => fakeStorage(memoryDir, [path.join(memoryDir, "facts/2026-03-08/a.md")]),
    };
    const roots = await resolveCorpusNamespaceRoots({ config });
    assert.equal(roots.length, 1, "the shared root is reported once");
    assert.ok(roots[0]?.namespaces.includes("global") && roots[0]?.namespaces.includes("shared"), "both aliases are tracked");
    const scopedToShared = await computeServiceCorpusWatermarks(host, { caps: { version: 1, namespaces: ["shared"] } });
    assert.equal(scopedToShared.length, 1, "a shared-scoped token sees the shared-root corpus, not an empty array");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("finding round-10: a non-directory category root fails a strict census (namespace omitted, not partial)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    // A category dir replaced by a regular file is a layout corruption; the
    // strict census must omit the namespace rather than publish facts/ alone.
    await writeFile(path.join(memoryDir, "procedures"), "not a directory", "utf-8");
    const watermarks = await computeCorpusWatermarks(["global"], () => new StorageManager(memoryDir));
    assert.deepEqual(watermarks, [], "a non-directory category root omits the namespace, not a partial count");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("round 6 (coderabbit): a failed namespace enumeration is an INCOMPLETE census, not an empty corpus", async () => {
  // computeServiceCorpusCensus wraps resolveCorpusNamespaceRoots: when enumeration
  // throws, the census must report complete:false (so a peer is never certified
  // converged against it) rather than an empty set that reads as an empty deployment.
  const throwingConfig = new Proxy({} as PluginConfig, {
    get() {
      throw new Error("namespace enumeration unavailable");
    },
  });
  const host = {
    config: throwingConfig,
    getStorage: () => {
      throw new Error("getStorage must not be reached once enumeration fails");
    },
  };
  const census = await computeServiceCorpusCensus(host);
  assert.equal(census.complete, false, "an enumeration failure is incomplete, never a certified empty census");
  assert.deepEqual(census.watermarks, [], "and it yields no watermarks");
});
