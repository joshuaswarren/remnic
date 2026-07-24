import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * Corpus watermark primitive (issue #2149).
 *
 * The digest is a per-partition CENSUS fingerprint, so two daemons that agree
 * on per-day file counts share a digest and a differing digest is a cheap
 * divergence signal. These tests pin that property plus the census determinism
 * (AGENTS.md pattern 26) and the "newest write is scoped to the newest
 * partition" contract.
 */
import test from "node:test";
import {
  type CorpusStorage,
  UNPARTITIONED_BUCKET,
  buildPartitionCensus,
  computeCorpusWatermark,
  computeServiceCorpusWatermarks,
  digestPartitionCensus,
} from "./corpus-watermark.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

async function makeMemoryDir(prefix = "engram-corpus-wm-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMemory(memoryDir: string, rel: string): Promise<string> {
  const full = path.join(memoryDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `---\nid: ${path.basename(rel, ".md")}\n---\n\nbody\n`, "utf-8");
  return full;
}

async function scanPaths(memoryDir: string): Promise<{ paths: string[]; baseDir: string }> {
  const storage = new StorageManager(memoryDir);
  return { paths: await storage.collectActiveMemoryPaths(), baseDir: storage.dir };
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

// ── census bucketing ─────────────────────────────────────────────────────────

test("buildPartitionCensus buckets by <category>/<day>; non-day paths land in the explicit unpartitioned bucket", () => {
  const baseDir = path.join(os.tmpdir(), "mem-fixture");
  const paths = [
    path.join(baseDir, "facts/2026-01-01/a.md"),
    path.join(baseDir, "facts/2026-01-01/b.md"),
    path.join(baseDir, "procedures/2026-01-02/c.md"),
    path.join(baseDir, "facts/loose.md"),
  ];
  const census = buildPartitionCensus(paths, baseDir);
  assert.equal(census.get("facts/2026-01-01"), 2);
  assert.equal(census.get("procedures/2026-01-02"), 1);
  assert.equal(census.get(UNPARTITIONED_BUCKET), 1);
});

// ── watermark computation ────────────────────────────────────────────────────

test("computeCorpusWatermark: an empty corpus yields a stable digest, null timestamps, and does not throw", async () => {
  const empty = await computeCorpusWatermark({ namespace: "global", paths: [], baseDir: "/mem" });
  const emptyElsewhere = await computeCorpusWatermark({ namespace: "global", paths: [], baseDir: "/other" });
  assert.equal(empty.activeMemoryCount, 0);
  assert.equal(empty.newestPartition, null);
  assert.equal(empty.newestWriteAt, null);
  assert.equal(empty.digest, digestPartitionCensus(new Map<string, number>()));
  assert.equal(empty.digest, emptyElsewhere.digest);
});

test("computeCorpusWatermark: activeMemoryCount matches the files written by the fixture", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    await writeMemory(memoryDir, "facts/2026-03-08/b.md");
    await writeMemory(memoryDir, "procedures/2026-03-09/c.md");
    const { paths, baseDir } = await scanPaths(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.activeMemoryCount, 3);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("computeCorpusWatermark: a memory without a day dir is counted in the unpartitioned bucket", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    await writeMemory(memoryDir, "facts/loose.md");
    const { paths, baseDir } = await scanPaths(memoryDir);
    const census = buildPartitionCensus(paths, baseDir);
    assert.equal(census.get(UNPARTITIONED_BUCKET), 1);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.activeMemoryCount, 2);
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
    const { paths, baseDir } = await scanPaths(memoryDir);
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

    const { paths, baseDir } = await scanPaths(memoryDir);
    const watermark = await computeCorpusWatermark({ namespace: "global", paths, baseDir });
    assert.equal(watermark.newestPartition, "2026-03-10");
    assert.equal(watermark.newestWriteAt, newestPartitionMtime.toISOString());
    assert.notEqual(watermark.newestWriteAt, olderPartitionButNewerOnDisk.toISOString());
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("two corpora with identical layouts share a digest; adding one file diverges it (the detection property)", async () => {
  const dirA = await makeMemoryDir("engram-corpus-wm-a-");
  const dirB = await makeMemoryDir("engram-corpus-wm-b-");
  try {
    for (const dir of [dirA, dirB]) {
      await writeMemory(dir, "facts/2026-03-08/a.md");
      await writeMemory(dir, "facts/2026-03-08/b.md");
      await writeMemory(dir, "procedures/2026-03-09/c.md");
    }
    const scanA = await scanPaths(dirA);
    const scanB = await scanPaths(dirB);
    const watermarkA = await computeCorpusWatermark({
      namespace: "global",
      paths: scanA.paths,
      baseDir: scanA.baseDir,
    });
    const watermarkB = await computeCorpusWatermark({
      namespace: "global",
      paths: scanB.paths,
      baseDir: scanB.baseDir,
    });
    assert.equal(watermarkA.digest, watermarkB.digest);

    await writeMemory(dirB, "facts/2026-03-08/d.md");
    const scanB2 = await scanPaths(dirB);
    const watermarkB2 = await computeCorpusWatermark({
      namespace: "global",
      paths: scanB2.paths,
      baseDir: scanB2.baseDir,
    });
    assert.notEqual(watermarkA.digest, watermarkB2.digest);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

// ── service (/health) watermark builder ──────────────────────────────────────

function fakeStorage(dir: string, paths: string[]): CorpusStorage {
  return { dir, collectActiveMemoryPaths: async () => paths };
}

test("computeServiceCorpusWatermarks: namespaces disabled -> single default-namespace watermark", async () => {
  const config = { namespacesEnabled: false, defaultNamespace: "global" } as unknown as PluginConfig;
  const host = {
    config,
    getStorage: (_namespace: string) =>
      fakeStorage("/mem", ["/mem/facts/2026-03-08/a.md", "/mem/facts/2026-03-08/b.md"]),
  };
  const result = await computeServiceCorpusWatermarks(host);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.namespace, "global");
  assert.equal(result[0]?.activeMemoryCount, 2);
});

test("computeServiceCorpusWatermarks: namespaces enabled -> enumerates the catalog namespaces", async () => {
  const config = { namespacesEnabled: true, defaultNamespace: "global" } as unknown as PluginConfig;
  const pathsByNamespace: Record<string, string[]> = {
    global: ["/mem/facts/2026-03-08/a.md"],
    "team-a": ["/mem-a/facts/2026-03-08/x.md", "/mem-a/facts/2026-03-08/y.md"],
  };
  const host = {
    config,
    namespaceCatalog: {
      listNamespaces: async () => [{ namespace: "global" }, { namespace: "team-a" }],
    },
    getStorage: (namespace: string) =>
      fakeStorage(namespace === "team-a" ? "/mem-a" : "/mem", pathsByNamespace[namespace] ?? []),
  };
  const result = await computeServiceCorpusWatermarks(host);
  const byNamespace = new Map(result.map((w) => [w.namespace, w]));
  assert.deepEqual([...byNamespace.keys()].sort(), ["global", "team-a"]);
  assert.equal(byNamespace.get("global")?.activeMemoryCount, 1);
  assert.equal(byNamespace.get("team-a")?.activeMemoryCount, 2);
});
