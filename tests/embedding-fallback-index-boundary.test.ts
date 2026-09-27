/**
 * Issue #3146 regression coverage: the embedding fallback index must survive
 * the V8 single-string ceiling via a one-way, atomically-published sharded
 * generation; a near-limit legacy index must migrate without loss or
 * resurrection; unreadable/oversized index files must fail mutations CLOSED
 * (never continue from an empty index); failed persistence must invalidate
 * the in-memory cache; and failures must leave durable, console-visible
 * diagnostics.
 *
 * Tests force the boundary with REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT
 * (test-boundary injection, no >512MB fixtures). The hard V8 ceiling is
 * simulated by patching JSON.stringify to throw
 * RangeError("Invalid string length") past the limit — the exact failure
 * class observed in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { EmbeddingFallback } from "@remnic/core/embedding-fallback";
import {
  clearHostEmbeddingProvidersForTest,
  registerHostEmbeddingProvider,
} from "@remnic/core/host-embedding-provider";
import type { PluginConfig } from "@remnic/core/types";

const LIMIT_ENV = "REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT";
const LEGACY_REL = path.join("state", "embeddings.json");
const SHARD_DIR_REL = path.join("state", "embeddings");
const STATUS_REL = path.join("state", "embedding-fallback-status.json");

interface IndexEntry {
  vector: number[];
  path: string;
}

interface LegacyIndexFile {
  version: number;
  provider: string;
  model: string;
  entries: Record<string, IndexEntry>;
}

function stubConfig(memoryDir: string): PluginConfig {
  return {
    openaiApiKey: "test-key",
    openaiBaseUrl: undefined,
    memoryDir,
    embeddingFallbackEnabled: true,
    embeddingFallbackProvider: "openai",
    localLlmEnabled: false,
    localLlmUrl: undefined,
    localLlmModel: undefined,
    localLlmApiKey: undefined,
    localLlmHeaders: undefined,
    localLlmAuthHeader: true,
    // Test stub: PluginConfig carries ~700 required defaults the stub never exercises.
  } as unknown as PluginConfig;
}

async function withEnv(overrides: Record<string, string>, fn: () => Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Stub the embedding HTTP endpoint; each call consumes the next vector. */
function installEmbedFetch(vectors: number[][]): () => void {
  const queue = [...vectors];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const embedding = queue.length > 0 ? queue.shift()! : [0.5];
    return new Response(JSON.stringify({ data: [{ embedding }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function vectorOf(elements: number): number[] {
  return Array.from({ length: elements }, () => 0.123456789);
}

function entryOf(elements: number, relPath: string): IndexEntry {
  return { vector: vectorOf(elements), path: relPath };
}

const shardName = (id: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `shard-${String(h % 64).padStart(4, "0")}.json`;
};

function buildIndex(entries: Record<string, IndexEntry>): LegacyIndexFile {
  return {
    version: 1,
    provider: "openai",
    model: "text-embedding-3-small",
    entries,
  };
}

async function writeLegacyIndex(memoryDir: string, index: LegacyIndexFile): Promise<number> {
  const raw = JSON.stringify(index);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(path.join(memoryDir, LEGACY_REL), raw, "utf-8");
  return raw.length;
}

interface ShardHeader {
  file: string;
  provider?: string;
  model?: string;
  entries: Record<string, IndexEntry>;
}

interface CollectedIndex {
  legacy: LegacyIndexFile | null;
  legacyRaw: string | null;
  shardFiles: string[];
  shards: ShardHeader[];
  backupFiles: string[];
  stagingDirs: string[];
  merged: Record<string, IndexEntry>;
}

async function collectIndex(memoryDir: string): Promise<CollectedIndex> {
  const stateDir = path.join(memoryDir, "state");
  const out: CollectedIndex = {
    legacy: null,
    legacyRaw: null,
    shardFiles: [],
    shards: [],
    backupFiles: [],
    stagingDirs: [],
    merged: {},
  };
  let stateEntries: string[] = [];
  try {
    stateEntries = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of stateEntries) {
    if (name === "embeddings.json") {
      out.legacyRaw = await readFile(path.join(stateDir, name), "utf-8");
      try {
        out.legacy = JSON.parse(out.legacyRaw);
      } catch {
        // Caller-inspected via legacyRaw (e.g. the corrupt-file tests).
      }
    }
    if (name.startsWith("embeddings.json.pre-migration.tmp-")) out.backupFiles.push(name);
    if (name.startsWith("embeddings.staging.tmp-")) out.stagingDirs.push(name);
  }
  let shardDirPresent = false;
  let shardDirEntries: string[] = [];
  try {
    shardDirEntries = await readdir(path.join(memoryDir, SHARD_DIR_REL));
    shardDirPresent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of shardDirEntries) {
    if (!/^shard-\d{4}\.json$/.test(name)) continue;
    out.shardFiles.push(name);
    const parsed = JSON.parse(await readFile(path.join(memoryDir, SHARD_DIR_REL, name), "utf-8"));
    out.shards.push({ file: name, provider: parsed.provider, model: parsed.model, entries: parsed.entries });
    Object.assign(out.merged, parsed.entries as Record<string, IndexEntry>);
  }
  // Single-generation rule: the legacy file is authoritative only while the
  // published shard directory is entirely absent. Even an EMPTIED published
  // directory (all shards removed) is the authoritative generation, so the
  // stray legacy file must not merge back.
  if (out.legacy && out.shardFiles.length === 0 && !shardDirPresent) {
    Object.assign(out.merged, out.legacy.entries);
  }
  return out;
}

/** Seed 8 entries; returns the char budget between the 8-entry and 9-entry serialization. */
async function seedEightEntryIndex(memoryDir: string): Promise<number> {
  const eight: Record<string, IndexEntry> = {};
  for (let i = 0; i < 8; i++) {
    eight[`mem-${i}`] = entryOf(55, `facts/${i}.md`);
  }
  const nine = { ...eight, "mem-8": entryOf(55, "facts/8.md") };
  const s8 = JSON.stringify(buildIndex(eight)).length;
  const s9 = JSON.stringify(buildIndex(nine)).length;
  const limit = Math.floor((s8 + s9) / 2);
  await writeLegacyIndex(memoryDir, buildIndex(eight));
  return limit;
}

async function tmpMemoryDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * True when the OS actually denies writes into `dir` after a chmod. Root
 * containers and Windows ignore directory permission bits, so chmod-forced
 * failure tests must skip instead of failing (issue #3148 review).
 */
async function chmodDeniesWrites(dir: string, mode: number): Promise<boolean> {
  await chmod(dir, mode);
  try {
    await writeFile(path.join(dir, `.perm-probe-${Math.random().toString(16).slice(2)}`), "x", "utf-8");
    return false;
  } catch {
    return true;
  }
}

const HOST_PROVIDER_STUB = {
  id: "host-test",
  model: "host-model",
  async embed() {
    return null;
  },
};

test("migrates to shards atomically when the next entry would exceed the hard string ceiling", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-spill-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const limit = await seedEightEntryIndex(memoryDir);
    const legacyBefore = await readFile(path.join(memoryDir, LEGACY_REL), "utf-8");

    await withEnv({ [LIMIT_ENV]: String(limit) }, async () => {
      // Simulate the V8 ceiling: any string past the budget throws exactly
      // like production ("Invalid string length") without allocating it.
      const realStringify = JSON.stringify;
      JSON.stringify = ((value: unknown, replacer?: never, space?: string | number) => {
        const out = realStringify(value, replacer, space);
        if (typeof out === "string" && out.length > limit) {
          throw new RangeError("Invalid string length");
        }
        return out;
      }) as typeof JSON.stringify;
      // LIFO: the fetch stub is restored before the stringify patch.
      cleanup.push(() => {
        JSON.stringify = realStringify;
      });

      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(55)]));
      await fallback.indexFile("mem-8", "ninth fact", path.join(memoryDir, "facts", "8.md"));
    });

    const collected = await collectIndex(memoryDir);
    assert.equal(collected.legacy, null, "legacy file must be demoted at migration");
    assert.equal(collected.backupFiles.length, 1, "legacy file must be preserved as a recovery artifact");
    assert.equal(
      await readFile(path.join(memoryDir, "state", collected.backupFiles[0]), "utf-8"),
      legacyBefore,
      "recovery artifact must hold the pre-migration bytes",
    );
    assert.equal(collected.stagingDirs.length, 0, "staging dir must be consumed by the publish");
    assert.ok(collected.shardFiles.length > 0, "entries must live in the published shard generation");
    assert.equal(Object.keys(collected.merged).length, 9);
    assert.equal(collected.merged["mem-3"].path, "facts/3.md");
    assert.equal(collected.merged["mem-8"].path, "facts/8.md");
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("loads entries and path associations from the published shard generation in a fresh instance", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-read-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const shardDir = path.join(memoryDir, SHARD_DIR_REL);
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      path.join(shardDir, shardName("mem-r1")),
      JSON.stringify(
        buildIndex({
          "mem-r1": entryOf(2, "facts/one.md"),
        }),
      ),
      "utf-8",
    );
    await writeFile(
      path.join(shardDir, shardName("mem-r2")),
      JSON.stringify(
        buildIndex({
          "mem-r2": { vector: [1, 0], path: "namespaces/alpha/facts/two.md" },
        }),
      ),
      "utf-8",
    );

    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[0.1, 0.2]]));
    const results = await fallback.search("needle", 5);
    assert.deepEqual(
      results.map((r) => r.id).sort(),
      ["mem-r1", "mem-r2"],
      "shard entries must be searchable without any legacy file",
    );
    assert.equal(results.find((r) => r.id === "mem-r2")?.path, "namespaces/alpha/facts/two.md");
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("migrates a near-limit legacy index on the next write, preserving identity, vectors, and paths", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-migrate-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const limit = await seedEightEntryIndex(memoryDir);
    await withEnv({ [LIMIT_ENV]: String(limit) }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(55), vectorOf(55)]));
      await fallback.indexFile("mem-8", "ninth fact", path.join(memoryDir, "facts", "8.md"));

      const collected = await collectIndex(memoryDir);
      assert.equal(collected.legacy, null);
      assert.ok(collected.shardFiles.length > 0);
      assert.equal(Object.keys(collected.merged).length, 9);
      assert.equal(collected.merged["mem-5"].path, "facts/5.md");

      // The migration is one-way: further writes stay in the shard generation.
      await fallback.indexFile("mem-9", "tenth fact", path.join(memoryDir, "facts", "9.md"));
      const after = await collectIndex(memoryDir);
      assert.equal(after.legacy, null, "index must not fall back to the legacy file");
      assert.equal(Object.keys(after.merged).length, 10);
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("removes a sharded entry without resurrection from the pre-migration artifact", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-remove-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const limit = await seedEightEntryIndex(memoryDir);
    await withEnv({ [LIMIT_ENV]: String(limit) }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(55), [0.123456789, 0.123456789]]));
      await fallback.indexFile("mem-8", "ninth fact", path.join(memoryDir, "facts", "8.md"));
      await fallback.removeFromIndex("mem-3");

      const collected = await collectIndex(memoryDir);
      assert.equal(collected.legacy, null, "deletion must not compact back to the legacy generation");
      assert.equal(collected.backupFiles.length, 1);
      // The pre-migration artifact still contains mem-3; it must never be served.
      const backup = JSON.parse(
        await readFile(path.join(memoryDir, "state", collected.backupFiles[0]), "utf-8"),
      ) as LegacyIndexFile;
      assert.ok(backup.entries["mem-3"], "fixture assumption: artifact holds the removed id");
      assert.equal(collected.merged["mem-3"], undefined, "removed id must not resurrect");

      // A fresh instance reads the same authoritative generation.
      const fresh = new EmbeddingFallback(stubConfig(memoryDir));
      const results = await fresh.search("anything", 20);
      assert.equal(results.find((r) => r.id === "mem-3"), undefined);
      assert.equal(results.length, 8);
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a stray legacy file beside the published generation is never merged (crash after publish)", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-stray-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    // Simulate a crash between the atomic publish and the legacy rename:
    // shards are authoritative, a stale legacy file sits next to them.
    const shardDir = path.join(memoryDir, SHARD_DIR_REL);
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      path.join(shardDir, shardName("mem-live")),
      JSON.stringify(buildIndex({ "mem-live": entryOf(2, "facts/live.md") })),
      "utf-8",
    );
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(
      path.join(memoryDir, LEGACY_REL),
      JSON.stringify(buildIndex({ "mem-stale": entryOf(2, "facts/stale.md") })),
      "utf-8",
    );

    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[0.1, 0.2], [0.3, 0.4]]));
    const results = await fallback.search("needle", 10);
    assert.deepEqual(results.map((r) => r.id), ["mem-live"], "stray legacy entry must not resurrect");
    assert.equal(results.find((r) => r.id === "mem-stale"), undefined);

    await fallback.indexFile("mem-new", "new fact", path.join(memoryDir, "facts", "new.md"));
    const collected = await collectIndex(memoryDir);
    assert.ok(collected.shardFiles.length >= 1);
    assert.ok(collected.merged["mem-new"]);
    assert.equal(collected.merged["mem-stale"], undefined, "writes must not adopt the stray generation");
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a single entry too large for any shard fails persist without changing authoritative state", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-capacity-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const seed = buildIndex({ "mem-seed": entryOf(55, "facts/seed.md") });
    const rawBefore = JSON.stringify(seed);
    await writeLegacyIndex(memoryDir, seed);

    await withEnv({ [LIMIT_ENV]: "2000" }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(300), [0.123456789, 0.123456789]]));
      await assert.rejects(
        fallback.indexFile("mem-huge", "huge fact", path.join(memoryDir, "facts", "huge.md")),
        (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexCapacityError",
      );

      const collected = await collectIndex(memoryDir);
      assert.equal(collected.legacyRaw, rawBefore, "failed migration must leave the legacy file untouched");
      assert.equal(collected.shardFiles.length, 0, "nothing may be published by a failed save");
      assert.equal(collected.stagingDirs.length, 0, "staging dir must be cleaned after the failure");
      const status = JSON.parse(await readFile(path.join(memoryDir, STATUS_REL), "utf-8"));
      assert.equal(status.failureCount, 1);
      assert.equal(status.lastWriteFailure.kind, "capacity");
      assert.equal(status.lastWriteFailure.memoryId, "mem-huge");

      // The index stays usable for reads after the explicit failure.
      const results = await fallback.search("still works", 5);
      assert.deepEqual(results.map((r) => r.id), ["mem-seed"]);
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("durable status records a failure once and clears it after a successful save", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-status-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const seed = buildIndex({ "mem-seed": entryOf(55, "facts/seed.md") });
    await writeLegacyIndex(memoryDir, seed);

    await withEnv({ [LIMIT_ENV]: "2000" }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(300), vectorOf(3)]));
      await assert.rejects(
        fallback.indexFile("mem-huge", "huge fact", path.join(memoryDir, "facts", "huge.md")),
        (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexCapacityError",
      );
      await fallback.indexFile("mem-ok", "small fact", path.join(memoryDir, "facts", "ok.md"));

      const status = JSON.parse(await readFile(path.join(memoryDir, STATUS_REL), "utf-8"));
      assert.equal(status.failureCount, 1, "failure count is cumulative history");
      assert.equal(status.lastWriteFailure, undefined, "a successful save clears the active failure");
      assert.ok(status.lastSuccessAt);
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unparseable legacy index fails writes closed and leaves the file in place", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-corrupt-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const corruptBody = '{"version":1,"provider":"ope';
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(path.join(memoryDir, LEGACY_REL), corruptBody, "utf-8");

    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([vectorOf(3), [0.1, 0.2]]));
    await assert.rejects(
      fallback.indexFile("mem-x", "fact x", path.join(memoryDir, "facts", "x.md")),
      (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexStorageError",
    );

    // Fail closed: no fresh index was written over it, file byte-identical.
    assert.equal(await readFile(path.join(memoryDir, LEGACY_REL), "utf-8"), corruptBody);
    const collected = await collectIndex(memoryDir);
    assert.equal(collected.shardFiles.length, 0);
    const status = JSON.parse(await readFile(path.join(memoryDir, STATUS_REL), "utf-8"));
    assert.match(status.lastReadRecovery.message, /JSON parse failed/);

    // Read-only paths fail open (recall survives) but serve nothing from it.
    const results = await fallback.search("query", 5);
    assert.deepEqual(results, []);
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a legacy index over the hard read ceiling fails writes closed and preserves bytes", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-oversize-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const oversize = buildIndex({ "mem-big": entryOf(300, "facts/big.md") });
    const rawBefore = JSON.stringify(oversize);
    await writeLegacyIndex(memoryDir, oversize);

    // Soft write budget 2000, hard read ceiling 2500: the 3.6KB file is
    // genuinely past what a readFile can materialize.
    await withEnv({
      [LIMIT_ENV]: "2000",
      "REMNIC_EMBEDDING_INDEX_HARD_READ_LIMIT_CHARS": "2500",
    }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(3), [0.1, 0.2]]));
      await assert.rejects(
        fallback.indexFile("mem-x", "fact x", path.join(memoryDir, "facts", "x.md")),
        (err: NodeJS.ErrnoException) =>
          err.name === "EmbeddingIndexStorageError" && /hard single-string read ceiling/.test(err.message),
      );
      assert.equal(await readFile(path.join(memoryDir, LEGACY_REL), "utf-8"), rawBefore);
      assert.deepEqual(await fallback.search("query", 5), []);
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a legacy index between the soft write budget and the hard read ceiling still loads and migrates", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-softband-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    // The reported production file sits in exactly this band: over the soft
    // write budget (496MiB chars) but under the V8 hard ceiling (~512MiB).
    // Old-writer fixture: 12 small entries, serialized just over the budget.
    const entries: Record<string, IndexEntry> = {};
    for (let i = 0; i < 12; i++) {
      entries[`mem-old-${i}`] = entryOf(10, `facts/old-${i}.md`);
    }
    const rawBefore = JSON.stringify(buildIndex(entries));
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(path.join(memoryDir, LEGACY_REL), rawBefore, "utf-8");
    assert.ok(rawBefore.length > 2000, `fixture assumption: over the soft write budget, got ${rawBefore.length}`);

    await withEnv({
      [LIMIT_ENV]: "2000",
      "REMNIC_EMBEDDING_INDEX_HARD_READ_LIMIT_CHARS": "10000",
    }, async () => {
      // Reads must serve the file even though it is over the write budget.
      const reader = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([[0.123456789, 0.123456789]]));
      const readable = await reader.search("load check", 20);
      assert.equal(readable.length, 12);

      // A mutation migrates it to the sharded generation, preserving entries.
      cleanup.push(installEmbedFetch([vectorOf(3)]));
      await reader.indexFile("mem-new", "new fact", path.join(memoryDir, "facts", "new.md"));

      const collected = await collectIndex(memoryDir);
      assert.equal(collected.legacy, null, "migration must demote the legacy file");
      assert.equal(collected.backupFiles.length, 1);
      assert.equal(
        await readFile(path.join(memoryDir, "state", collected.backupFiles[0]), "utf-8"),
        rawBefore,
        "recovery artifact must hold the pre-migration bytes",
      );
      assert.ok(collected.shardFiles.length > 0);
      assert.equal(collected.merged["mem-old-7"].path, "facts/old-7.md");
      assert.equal(collected.merged["mem-new"].path, "facts/new.md");

      // A fresh instance serves the migrated generation.
      const fresh = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([[0.123456789, 0.123456789]]));
      const results = await fresh.search("post-migration", 30);
      assert.equal(results.length, 13);
      assert.equal(results.find((r) => r.id === "mem-new")?.path, "facts/new.md");
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recall fails open uncached and a following mutation still fails closed on a corrupt index", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-uncached-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const corruptBody = '{"version":1,"provider":"ope';
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(path.join(memoryDir, LEGACY_REL), corruptBody, "utf-8");

    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[0.1, 0.2], vectorOf(3)]));

    // Lenient recall: [] without caching anything.
    assert.deepEqual(await fallback.search("q", 5), []);

    // The SAME instance must not have cached an empty load: the mutation
    // revalidates, fails closed, and never overwrites the bad file.
    await assert.rejects(
      fallback.indexFile("mem-x", "fact x", path.join(memoryDir, "facts", "x.md")),
      (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexStorageError",
    );
    assert.equal(await readFile(path.join(memoryDir, LEGACY_REL), "utf-8"), corruptBody);
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unreadable published generation fails mutation closed instead of writing into it blind", async (t) => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-direnum-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  const shardDir = path.join(memoryDir, SHARD_DIR_REL);
  try {
    await mkdir(shardDir, { recursive: true });
    const seeded = buildIndex({
      "mem-live-1": entryOf(2, "facts/one.md"),
      "mem-live-2": entryOf(2, "facts/two.md"),
    });
    await writeFile(path.join(shardDir, shardName("mem-live-1")), JSON.stringify(buildIndex({
      "mem-live-1": entryOf(2, "facts/one.md"),
    })), "utf-8");
    await writeFile(path.join(shardDir, shardName("mem-live-2")), JSON.stringify(buildIndex({
      "mem-live-2": entryOf(2, "facts/two.md"),
    })), "utf-8");
    const shardBefore = await readFile(path.join(shardDir, shardName("mem-live-1")), "utf-8");

    await withEnv({ [LIMIT_ENV]: "2000" }, async () => {
      // Revoke read permission on the published generation directory.
      await chmod(shardDir, 0o000);
      if (!(await chmodDeniesWrites(shardDir, 0o000))) {
        t.skip("directory permission enforcement unavailable (root or Windows)");
        return;
      }

      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(3)]));
      await assert.rejects(
        fallback.indexFile("mem-new", "new fact", path.join(memoryDir, "facts", "new.md")),
        (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexStorageError",
      );
    });

    await chmod(shardDir, 0o755);
    // Existing shards are untouched: the mutation never wrote blind.
    assert.equal(await readFile(path.join(shardDir, shardName("mem-live-1")), "utf-8"), shardBefore);
    const collected = await collectIndex(memoryDir);
    assert.equal(collected.merged["mem-new"], undefined, "no entry may be written from an unloadable generation");
    assert.deepEqual(Object.keys(collected.merged).sort(), ["mem-live-1", "mem-live-2"]);

    // Recall fails open at its boundary.
    const fresh = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[0.1, 0.2]]));
    const readable = await fresh.search("after restore", 5);
    assert.deepEqual(readable.map((r) => r.id).sort(), ["mem-live-1", "mem-live-2"]);
  } finally {
    await chmod(shardDir, 0o755).catch(() => undefined);
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("mutations reject a mixed-identity generation and a malformed shard instead of partially rewriting them", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-mixed-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const shardDir = path.join(memoryDir, SHARD_DIR_REL);
    await mkdir(shardDir, { recursive: true });
    const openaiShard = JSON.stringify(
      buildIndex({ "mem-a": entryOf(2, "facts/a.md") }),
    );
    // Foreign-identity shard: same format, different provider/model.
    const hostShard = JSON.stringify({
      version: 1,
      provider: "host",
      model: "some-host-model",
      entries: { "mem-b": { vector: [1, 0], path: "facts/b.md" } },
    });
    await writeFile(path.join(shardDir, shardName("mem-a")), openaiShard, "utf-8");
    await writeFile(path.join(shardDir, shardName("mem-b")), hostShard, "utf-8");

    await withEnv({ [LIMIT_ENV]: "2000" }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(3)]));
      await assert.rejects(
        fallback.indexFile("mem-new", "new fact", path.join(memoryDir, "facts", "new.md")),
        (err: NodeJS.ErrnoException) =>
          err.name === "EmbeddingIndexStorageError" && /mixed-identity/.test(err.message),
      );

      // Both files preserved; nothing was rewritten from a partial view.
      assert.equal(await readFile(path.join(shardDir, shardName("mem-a")), "utf-8"), openaiShard);
      assert.equal(await readFile(path.join(shardDir, shardName("mem-b")), "utf-8"), hostShard);
    });

    // Now a malformed shard instead: recall skips it; mutation rejects it.
    const malformed = '{"hello":1}';
    await writeFile(path.join(shardDir, shardName("mem-b")), malformed, "utf-8");
    const fallback2 = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[0.1, 0.2], vectorOf(3)]));
    // Recall fails open UNCACHED on any generation read failure — it never
    // serves a partially-read generation.
    assert.deepEqual(await fallback2.search("q", 5), []);
    await assert.rejects(
      fallback2.indexFile("mem-new", "new fact", path.join(memoryDir, "facts", "new.md")),
      (err: NodeJS.ErrnoException) =>
        err.name === "EmbeddingIndexStorageError" && /malformed embedding index shard/.test(err.message),
    );
    assert.equal(await readFile(path.join(shardDir, shardName("mem-b")), "utf-8"), malformed);
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("identity change on a sharded generation publishes a complete replacement (host to openai fallback)", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-replace-openai-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    // Sharded generation with the OLD host identity.
    const shardDir = path.join(memoryDir, SHARD_DIR_REL);
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      path.join(shardDir, shardName("mem-h1")),
      JSON.stringify({
        version: 1,
        provider: "host",
        model: "host-model",
        entries: { "mem-h1": { vector: [1, 0], path: "facts/h1.md" } },
      }),
      "utf-8",
    );
    await writeFile(
      path.join(shardDir, shardName("mem-h2")),
      JSON.stringify({
        version: 1,
        provider: "host",
        model: "host-model",
        entries: { "mem-h2": { vector: [0, 1], path: "facts/h2.md" } },
      }),
      "utf-8",
    );

    // Host embeds fail (HOST_PROVIDER_STUB returns null), so indexing falls
    // back to OpenAI — the legitimate replacement path.
    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([vectorOf(3), vectorOf(3)]));
    await fallback.indexFile("mem-o1", "openai fact", path.join(memoryDir, "facts", "o1.md"));

    const collected = await collectIndex(memoryDir);
    assert.ok(collected.shardFiles.length > 0);
    for (const shard of collected.shards) {
      assert.equal(shard.provider, "openai", `shard ${shard.file} must carry the replacement identity`);
      assert.equal(shard.model, "text-embedding-3-small");
    }
    assert.deepEqual(Object.keys(collected.merged).sort(), ["mem-o1"], "replacement discards the obsolete generation");

    // Reload in a fresh instance and follow up with another write.
    const fresh = new EmbeddingFallback(stubConfig(memoryDir));
    const results = await (async () => {
      const r = await fresh.search("reload check", 5);
      return r;
    })();
    assert.deepEqual(results.map((r) => r.id), ["mem-o1"]);
    await fresh.indexFile("mem-o2", "second openai fact", path.join(memoryDir, "facts", "o2.md"));
    const after = await collectIndex(memoryDir);
    for (const shard of after.shards) {
      assert.equal(shard.provider, "openai");
    }
    assert.equal(after.merged["mem-o2"] !== undefined, true);
    assert.equal(after.stagingDirs.length, 0);
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("identity change to a new host model replaces the generation and keeps it writable", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-replace-model-");
  const unregister = registerHostEmbeddingProvider(memoryDir, {
    id: "host-test",
    model: "host-model-v2",
    async embed() {
      return [1, 0];
    },
  });
  const cleanup: Array<() => void> = [];
  try {
    const shardDir = path.join(memoryDir, SHARD_DIR_REL);
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      path.join(shardDir, shardName("mem-v1")),
      JSON.stringify({
        version: 1,
        provider: "host",
        model: "host-model-v1",
        entries: { "mem-v1": { vector: [1, 0], path: "facts/v1.md" } },
      }),
      "utf-8",
    );

    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[1, 0]]));
    await fallback.indexFile("mem-v2", "v2 fact", path.join(memoryDir, "facts", "v2.md"));

    const collected = await collectIndex(memoryDir);
    for (const shard of collected.shards) {
      assert.equal(shard.provider, "host");
      assert.equal(shard.model, "host-model-v2");
    }
    assert.deepEqual(Object.keys(collected.merged).sort(), ["mem-v2"]);

    const fresh = new EmbeddingFallback(stubConfig(memoryDir));
    const results = await fresh.search("reload", 5);
    assert.deepEqual(results.map((r) => r.id), ["mem-v2"]);
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("injected replacement failures preserve the old generation until the replacement is valid", async (t) => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-replace-fail-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  const stateDir = path.join(memoryDir, "state");
  try {
    const shardDir = path.join(memoryDir, SHARD_DIR_REL);
    await mkdir(shardDir, { recursive: true });
    const oldShard = JSON.stringify({
      version: 1,
      provider: "host",
      model: "host-model",
      entries: { "mem-h1": { vector: [1, 0], path: "facts/h1.md" } },
    });
    await writeFile(path.join(shardDir, shardName("mem-h1")), oldShard, "utf-8");

    // (a) Serialization failure while staging the replacement: the huge
    // entry overflows its shard, throwing BEFORE any destructive step.
    // (b) uses chmod, which is unenforced as root/on Windows - skip there.
    if (process.getuid?.() === 0 || process.platform === "win32") {
      t.skip("permission-based failure injection unavailable (root or Windows)");
      return;
    }
    await withEnv({ [LIMIT_ENV]: "2000" }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(300), vectorOf(3)]));
      await assert.rejects(
        fallback.indexFile("mem-huge", "huge fact", path.join(memoryDir, "facts", "huge.md")),
        (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexCapacityError",
      );
      assert.equal(await readFile(path.join(shardDir, shardName("mem-h1")), "utf-8"), oldShard, "old generation must survive a staging failure");
      assert.equal((await collectIndex(memoryDir)).stagingDirs.length, 0, "staging must be rolled back");
      // Recall honestly reports nothing: the surviving generation still has
      // the host identity, which this config's openai query cannot serve.
      assert.deepEqual(await fallback.search("after failure", 5), []);
      // A normal write re-attempts the replacement and succeeds.
      await fallback.indexFile("mem-ok", "ok fact", path.join(memoryDir, "facts", "ok.md"));
      const replaced = await collectIndex(memoryDir);
      assert.ok(replaced.shards.length > 0);
      for (const shard of replaced.shards) {
        assert.equal(shard.provider, "openai");
      }
      assert.equal(replaced.merged["mem-ok"] !== undefined, true);
    });

    // (b) Write failure while staging an IDENTITY replacement (state dir
    // read-only blocks the staging mkdir): old generation intact, then
    // recovery and a successful replacement after permissions return.
    await withEnv({ [LIMIT_ENV]: "2000" }, async () => {
      // Back to a host-identity generation so the next write is a
      // replacement (staging lives under the state dir).
      await rm(shardDir, { recursive: true, force: true });
      await mkdir(shardDir, { recursive: true });
      await writeFile(path.join(shardDir, shardName("mem-h1")), oldShard, "utf-8");

      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(3), vectorOf(3)]));
      await chmod(stateDir, 0o500);
      await assert.rejects(
        fallback.indexFile("mem-blocked", "blocked fact", path.join(memoryDir, "facts", "blocked.md")),
        (err: NodeJS.ErrnoException) => (err as NodeJS.ErrnoException).code === "EACCES",
      );
      await chmod(stateDir, 0o755);
      assert.equal(await readFile(path.join(shardDir, shardName("mem-h1")), "utf-8"), oldShard, "old generation must survive an I/O failure");
      assert.equal((await collectIndex(memoryDir)).stagingDirs.length, 0, "staging must be rolled back");
      assert.deepEqual(await fallback.search("after io failure", 5), []);
      await fallback.indexFile("mem-after", "after fact", path.join(memoryDir, "facts", "after.md"));
      assert.equal((await collectIndex(memoryDir)).merged["mem-after"] !== undefined, true);
    });
  } finally {
    await chmod(stateDir, 0o755).catch(() => undefined);
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a corrupt backup file is recovered by the mutation queue, which then fails closed loudly", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-gapjunk-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    // Gap state where the fixed backup is NOT a directory (corrupt): the
    // mutation queue's recovery moves it into the published position, and
    // the mutation must fail closed with a tagged error instead of
    // degrading to the stray legacy file or a fresh index.
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "embeddings.pre-replace.tmp"), "junk", "utf-8");
    await writeFile(
      path.join(memoryDir, LEGACY_REL),
      JSON.stringify(buildIndex({ "mem-stale": entryOf(2, "facts/stale.md") })),
      "utf-8",
    );

    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([vectorOf(3), [0.1, 0.2]]));
    await assert.rejects(
      fallback.indexFile("mem-x", "fact x", path.join(memoryDir, "facts", "x.md")),
      (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexStorageError",
    );
    // The stray legacy file was moved (recovered) but never served or
    // overwritten: recall fails open to [] and the legacy bytes survive.
    assert.deepEqual(await fallback.search("q", 5), []);
    assert.equal(
      await readFile(path.join(memoryDir, LEGACY_REL), "utf-8"),
      JSON.stringify(buildIndex({ "mem-stale": entryOf(2, "facts/stale.md") })),
    );
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a restart inside the replacement rename gap rolls back to the old generation, not stale legacy", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-gap-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    // Crash state: the publish rename never ran. The former (openai)
    // generation sits in the fixed transaction backup, the published
    // directory is gone, and a stale pre-migration legacy file lurks beside
    // them trying to resurrect old vectors.
    const backupDir = path.join(memoryDir, "state", "embeddings.pre-replace.tmp");
    await mkdir(backupDir, { recursive: true });
    // shard-0058 is mem-old's hash slot for SHARD_COUNT=64.
    await writeFile(
      path.join(backupDir, "shard-0058.json"),
      JSON.stringify(buildIndex({ "mem-old": entryOf(2, "facts/old.md") })),
      "utf-8",
    );
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(
      path.join(memoryDir, LEGACY_REL),
      JSON.stringify(buildIndex({ "mem-stale": entryOf(2, "facts/stale.md") })),
      "utf-8",
    );

    // Recall during the gap fails open to [] - it never adopts the stale
    // legacy file, and the backup generation is only recovered by a write.
    const fallback = new EmbeddingFallback(stubConfig(memoryDir));
    cleanup.push(installEmbedFetch([[0.1, 0.2], vectorOf(3)]));
    assert.deepEqual(await fallback.search("after restart", 5), []);
    const duringGap = await collectIndex(memoryDir);
    assert.equal(duringGap.legacy?.entries["mem-stale"] !== undefined, true, "fixture assumption: stray legacy on disk");
    // (duringGap.merged includes the stray file only because the TEST helper
    // merges whatever is on disk; the library serves [] per the assertion
    // above.)

    // A DELETE as the first post-crash mutation must also recover before its
    // no-op skip (codex round 3): removing mem-old restores the generation,
    // then drops the entry from it.
    await fallback.removeFromIndex("mem-old");
    const after = await collectIndex(memoryDir);
    // Recovery consumed the fixed transaction backup; the removal was
    // applied to the restored generation; the stray legacy file never
    // served.
    let replacementBackupLeft = false;
    try {
      await readFile(path.join(memoryDir, "state", "embeddings.pre-replace.tmp"));
      replacementBackupLeft = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") replacementBackupLeft = true;
    }
    assert.equal(replacementBackupLeft, false, "transaction backup consumed by the recovery");
    assert.equal(after.merged["mem-old"], undefined, "requested removal applied to the restored generation");
    assert.equal(after.merged["mem-stale"], undefined, "stray legacy never merges");
    const results = await fallback.search("recovered", 5);
    assert.deepEqual(results.map((r) => r.id), [], "mem-old was the only searchable entry and is now removed");
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an interrupted migration leaves no staging debris and the legacy file authoritative", async () => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-interrupted-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  try {
    const seed = buildIndex({ "mem-seed": entryOf(3, "facts/seed.md") });
    const rawBefore = JSON.stringify(seed);
    await writeLegacyIndex(memoryDir, seed);
    // Orphan staging dir from a crashed process (different pid), aged past
    // the cleanup grace window.
    const staleStaging = path.join(memoryDir, "state", "embeddings.staging.tmp-999999-stale");
    await mkdir(staleStaging, { recursive: true });
    await writeFile(path.join(staleStaging, "shard-0000.json"), "junk", "utf-8");
    const old = new Date(Date.now() - 30 * 60 * 1000);
    await utimes(staleStaging, old, old);

    await withEnv({ [LIMIT_ENV]: "100000" }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(3)]));
      await fallback.indexFile("mem-next", "next fact", path.join(memoryDir, "facts", "next.md"));

      const collected = await collectIndex(memoryDir);
      assert.equal(collected.stagingDirs.length, 0, "orphaned staging dir must be cleaned");
      assert.equal(collected.shardFiles.length, 0, "index stays in the legacy generation");
      assert.ok(collected.legacy);
      assert.ok(collected.legacyRaw?.includes("mem-next"));
      assert.ok(collected.legacyRaw?.includes("mem-seed"));
      assert.notEqual(collected.legacyRaw, rawBefore);
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed persistence invalidates the cache and the retry actually reaches disk", async (t) => {
  const memoryDir = await tmpMemoryDir("remnic-emb3146-cache-");
  const unregister = registerHostEmbeddingProvider(memoryDir, HOST_PROVIDER_STUB);
  const cleanup: Array<() => void> = [];
  const stateDir = path.join(memoryDir, "state");
  try {
    const seed = buildIndex({ "mem-seed": entryOf(3, "facts/seed.md") });
    await writeLegacyIndex(memoryDir, seed);
    const queryVec = [0.123456789, 0.123456789, 0.123456789];

    await withEnv({ [LIMIT_ENV]: "100000" }, async () => {
      const fallback = new EmbeddingFallback(stubConfig(memoryDir));
      cleanup.push(installEmbedFetch([vectorOf(3), queryVec, vectorOf(3), queryVec]));
      await chmod(stateDir, 0o500);
      if (!(await chmodDeniesWrites(stateDir, 0o500))) {
        t.skip("directory permission enforcement unavailable (root or Windows)");
        return;
      }
      await assert.rejects(
        fallback.indexFile("mem-x", "fact x", path.join(memoryDir, "facts", "x.md")),
        (err: NodeJS.ErrnoException) => (err as NodeJS.ErrnoException).code === "EACCES",
      );
      // The mutated-but-unsaved entry must not be served as durable.
      const afterFailure = await fallback.search("durable check", 10);
      assert.equal(afterFailure.find((r) => r.id === "mem-x"), undefined, "unsaved entry must not be visible");

      await chmod(stateDir, 0o755);
      await fallback.indexFile("mem-x", "fact x", path.join(memoryDir, "facts", "x.md"));
      const onDisk = JSON.parse(await readFile(path.join(memoryDir, LEGACY_REL), "utf-8")) as LegacyIndexFile;
      assert.ok(onDisk.entries["mem-x"], "retry must really persist the entry");
      const afterRetry = await fallback.search("durable check", 10);
      assert.equal(afterRetry.find((r) => r.id === "mem-x")?.path, "facts/x.md");
    });
  } finally {
    for (const fn of cleanup.reverse()) fn();
    unregister();
    clearHostEmbeddingProvidersForTest();
    await chmod(stateDir, 0o755).catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});
