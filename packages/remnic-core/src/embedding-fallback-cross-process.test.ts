/**
 * Cross-process warm-cache revalidation for EmbeddingFallback (issue #3165,
 * the declined P1 on PR #3148). The warm search path trusts the in-memory
 * index because "every in-process mutation saves through saveIndex" — that
 * argument does not cover a second process publishing the generation on
 * disk (the offline-sync apply of remote-authoritative runtime state). Each
 * test spawns a real child process that writes through the normal
 * EmbeddingFallback mutation path, then asserts the parent's warm searches
 * revalidate against disk. Vectors are pure functions of the text so both
 * processes agree on them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { parseConfig } from "./config.js";
import { EmbeddingFallback } from "./embedding-fallback.js";
import {
  clearHostEmbeddingProvidersForTest,
  registerHostEmbeddingProvider,
  type HostEmbeddingProvider,
} from "./host-embedding-provider.js";
import type { EmbeddingIndexStoreIo } from "./embedding-index-storage.js";

/** Deterministic across processes: both sides embed with this exact function. */
function vectorFor(text: string): number[] {
  const vec = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) vec[i % 4] += text.charCodeAt(i) % 13;
  return vec;
}

function hostProvider(model: string): HostEmbeddingProvider {
  return {
    id: model,
    model,
    embed: async (text: string) => vectorFor(text),
  };
}

const PARENT_TEXT = "parent fact about database indexes";
const CHILD_TEXT = "child fact about queue consumers";

/** Spawn a real second process that indexes one memory under the given identity. */
function runChildPeer(options: {
  memoryDir: string;
  hostModel: string;
  memoryId: string;
  text: string;
  relPath: string;
}): Promise<void> {
  const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
  const childSource = [
    "const [fallbackUrl, configUrl, hostUrl, memoryDir, hostModel, memoryId, text, relPath] = process.argv.slice(1);",
    `const vectorFor = (text) => { const vec = [0, 0, 0, 0]; for (let i = 0; i < text.length; i++) vec[i % 4] += text.charCodeAt(i) % 13; return vec; };`,
    "const { EmbeddingFallback } = await import(fallbackUrl);",
    "const { parseConfig } = await import(configUrl);",
    "const { registerHostEmbeddingProvider } = await import(hostUrl);",
    "registerHostEmbeddingProvider(memoryDir, { id: hostModel, model: hostModel, embed: async (t) => vectorFor(t) });",
    'const config = parseConfig({ memoryDir, embeddingFallbackEnabled: true, embeddingFallbackProvider: "openai", openaiApiKey: false });',
    "const fallback = new EmbeddingFallback(config);",
    "await fallback.indexFile(memoryId, text, relPath);",
    'process.stdout.write("CHILD_DONE\\n");',
    "",
  ].join("\n");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(
    process.execPath,
    [
      "--import", "tsx",
      "-e", childSource,
      moduleUrl("./embedding-fallback.js"),
      moduleUrl("./config.js"),
      moduleUrl("./host-embedding-provider.js"),
      options.memoryDir,
      options.hostModel,
      options.memoryId,
      options.text,
      options.relPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0 && stdout.split("\n").includes("CHILD_DONE")) resolve();
    else reject(new Error(`peer exited ${code}: ${stderr || stdout}`));
  });
  return promise;
}

function makeCountingIo() {
  let reads = 0;
  const io: EmbeddingIndexStoreIo = {
    readUtf8: async (filePath) => {
      reads += 1;
      return readFile(filePath, "utf-8");
    },
    writeUtf8: async (filePath, contents) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf-8");
    },
  };
  return { io, reads: () => reads };
}

async function newMemoryDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `embed-cross-${process.pid}-`));
}

function parentConfig(memoryDir: string) {
  return parseConfig({
    memoryDir,
    embeddingFallbackEnabled: true,
    embeddingFallbackProvider: "openai",
    openaiApiKey: false,
  });
}

test("a peer's identity swap invalidates the warm cache instead of serving the old generation", async (t) => {
  const memoryDir = await newMemoryDir();
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  t.after(() => clearHostEmbeddingProvidersForTest());
  t.after(registerHostEmbeddingProvider(memoryDir, hostProvider("host-model-a")));

  const fallback = new EmbeddingFallback(parentConfig(memoryDir));
  await fallback.indexFile("mem-a", PARENT_TEXT, "namespaces/alpha/facts/parent-a.md");
  const warm = await fallback.search(PARENT_TEXT, 5);
  assert.equal(warm[0]?.id, "mem-a", "baseline: own entry is searchable");

  await runChildPeer({
    memoryDir,
    hostModel: "host-model-b",
    memoryId: "mem-b",
    text: CHILD_TEXT,
    relPath: "namespaces/alpha/facts/child-b.md",
  });

  const hits = await fallback.search(PARENT_TEXT, 5);
  assert.deepEqual(
    hits.map((hit) => hit.id),
    [],
    "stale host-model-a entries must not be served after the disk identity swapped to host-model-b",
  );
});

test("a peer's same-identity write becomes visible to warm searches, via one revalidation read", async (t) => {
  const memoryDir = await newMemoryDir();
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  t.after(() => clearHostEmbeddingProvidersForTest());
  t.after(registerHostEmbeddingProvider(memoryDir, hostProvider("host-model-a")));

  const counting = makeCountingIo();
  const fallback = new EmbeddingFallback(parentConfig(memoryDir), counting.io);
  await fallback.indexFile("mem-a", PARENT_TEXT, "namespaces/alpha/facts/parent-a.md");
  assert.equal((await fallback.search(PARENT_TEXT, 5))[0]?.id, "mem-a");

  const readsAfterWarmup = counting.reads();
  await fallback.search(PARENT_TEXT, 5);
  await fallback.search(PARENT_TEXT, 5);
  assert.equal(
    counting.reads(),
    readsAfterWarmup,
    "warm searches with an unchanged disk marker perform no index reads",
  );

  await runChildPeer({
    memoryDir,
    hostModel: "host-model-a",
    memoryId: "mem-b",
    text: CHILD_TEXT,
    relPath: "namespaces/alpha/facts/child-b.md",
  });

  const hits = await fallback.search(CHILD_TEXT, 5);
  assert.equal(
    hits[0]?.id,
    "mem-b",
    "a peer's same-identity entry must be visible to the next warm search (merged, not replacing mem-a)",
  );
  assert.ok(
    counting.reads() > readsAfterWarmup,
    "the peer write must trigger revalidation reads (the marker changed)",
  );
});

test("a peer's dirty-shard write into a published generation moves the stamp without a directory swap", async (t) => {
  const memoryDir = await newMemoryDir();
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  t.after(() => clearHostEmbeddingProvidersForTest());
  t.after(registerHostEmbeddingProvider(memoryDir, hostProvider("host-model-a")));
  const prevLimit = process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT;
  process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT = "1024";
  t.after(() => {
    if (prevLimit === undefined) delete process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT;
    else process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT = prevLimit;
  });

  const counting = makeCountingIo();
  const fallback = new EmbeddingFallback(parentConfig(memoryDir), counting.io);
  for (let i = 0; i < 14; i++) {
    await fallback.indexFile(
      `mem-a-${i}`,
      `${PARENT_TEXT} variant number ${i}`,
      `namespaces/alpha/facts/parent-a-${i}.md`,
    );
  }
  const shardDir = path.join(memoryDir, "state", "embeddings");
  const seeded = await lstat(shardDir);
  assert.equal(seeded.isDirectory(), true, "precondition: seed migrated to the published sharded generation");

  const readsAfterSeed = counting.reads();
  await fallback.search(PARENT_TEXT, 5);
  assert.equal(counting.reads(), readsAfterSeed, "warm search reads nothing while the marker is unchanged");
  const inoBefore = (await lstat(shardDir)).ino;

  await runChildPeer({
    memoryDir,
    hostModel: "host-model-a",
    memoryId: "mem-b",
    text: CHILD_TEXT,
    relPath: "namespaces/alpha/facts/child-b.md",
  });

  assert.equal(
    (await lstat(shardDir)).ino,
    inoBefore,
    "the peer rewrote shards inside the existing directory (no swap): the stamp must still move so the warm cache revalidates",
  );
  const hits = await fallback.search(CHILD_TEXT, 5);
  assert.equal(hits[0]?.id, "mem-b", "the peer's entry is visible to the parent's warm search");
  assert.ok(
    counting.reads() > readsAfterSeed,
    "the in-place peer write must trigger revalidation reads",
  );
  assert.match(
    (await fallback.search(PARENT_TEXT, 5))[0]?.id ?? "",
    /^mem-a-/,
    "parent entries survive the peer's dirty-shard write (merge, not replacement)",
  );
});

test("an identity probe that raced an in-flight peer publication revalidates at the completion marker", async (t) => {
  const memoryDir = await newMemoryDir();
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  t.after(() => clearHostEmbeddingProvidersForTest());
  t.after(registerHostEmbeddingProvider(memoryDir, hostProvider("host-model-a")));

  // The peer's io gate freezes its publication after the marker moved but
  // before the index bytes are replaced: the window an unlocked reader sees.
  const { promise: release, resolve: unblock } = Promise.withResolvers<void>();
  const { promise: atWrite, resolve: reachedWrite } = Promise.withResolvers<void>();
  let peerGated = false;
  const peerIo: EmbeddingIndexStoreIo = {
    readUtf8: async (filePath) => readFile(filePath, "utf-8"),
    writeUtf8: async (filePath, contents) => {
      if (!peerGated) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, contents, "utf-8");
        return;
      }
      peerGated = false;
      reachedWrite();
      await release;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf-8");
    },
  };
  const counting = makeCountingIo();
  const fallback = new EmbeddingFallback(parentConfig(memoryDir), counting.io);
  await fallback.indexFile("mem-a", PARENT_TEXT, "namespaces/alpha/facts/parent-a.md");
  assert.equal((await fallback.search(PARENT_TEXT, 5))[0]?.id, "mem-a");

  // The peer's io gate freezes its publication after the marker moved but
  // before the index bytes are replaced: the window an unlocked reader sees.
  const peer = new EmbeddingFallback(parentConfig(memoryDir), peerIo);
  peerGated = true;
  const peerWrite = peer.indexFile("mem-b", CHILD_TEXT, "namespaces/alpha/facts/child-b.md");
  await atWrite;

  // Park the parent's probe on the in-flight window: its identity probe
  // reads the old bytes, then its locked content load blocks on the peer's
  // generation lock. Unblock only once the probe read has landed.
  const { promise: probeRead, resolve: probeReadLanded } = Promise.withResolvers<void>();
  const countingReadUtf8 = counting.io.readUtf8;
  counting.io.readUtf8 = async (filePath) => {
    const raw = await countingReadUtf8(filePath);
    probeReadLanded();
    return raw;
  };
  const parentSearch = fallback.search(CHILD_TEXT, 5);
  await probeRead;
  unblock();
  const hits = await parentSearch;
  await peerWrite;
  assert.equal(hits[0]?.id, "mem-b", "the peer's entry is visible once the in-flight publication completes");

  const readsAfterBarrierSearch = counting.reads();
  await fallback.search(CHILD_TEXT, 5);
  assert.ok(
    counting.reads() > readsAfterBarrierSearch,
    "the probe cached during the in-flight window must be re-read at the completion marker; a mid-flight stamp must never stay stable",
  );
});

test("a peer write that aliases the warm stamp's mtime tick still invalidates the warm cache", async (t) => {
  const memoryDir = await newMemoryDir();
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  t.after(() => clearHostEmbeddingProvidersForTest());
  t.after(registerHostEmbeddingProvider(memoryDir, hostProvider("host-model-a")));
  const prevLimit = process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT;
  process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT = "1024";
  t.after(() => {
    if (prevLimit === undefined) delete process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT;
    else process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT = prevLimit;
  });

  const counting = makeCountingIo();
  const fallback = new EmbeddingFallback(parentConfig(memoryDir), counting.io);
  for (let i = 0; i < 14; i++) {
    await fallback.indexFile(
      `mem-a-${i}`,
      `${PARENT_TEXT} variant number ${i}`,
      `namespaces/alpha/facts/parent-a-${i}.md`,
    );
  }
  const shardDir = path.join(memoryDir, "state", "embeddings");
  assert.equal((await lstat(shardDir)).isDirectory(), true, "precondition: seed migrated to the published sharded generation");
  // Pin the directory mtime to a whole-millisecond tick, warm the cache on
  // it, then restore the SAME tick after the peer's write: on a coarse-tick
  // filesystem the pre- and post-write stats are indistinguishable, so the
  // revalidation stamp must still move through something that cannot alias.
  const aliasedTickSec = 1_700_000_000.5;
  await utimes(shardDir, aliasedTickSec, aliasedTickSec);
  assert.match(
    (await fallback.search(PARENT_TEXT, 5))[0]?.id ?? "",
    /^mem-a-/,
    "baseline: own entries are searchable",
  );
  const readsAfterWarmup = counting.reads();
  await fallback.search(PARENT_TEXT, 5);
  assert.equal(counting.reads(), readsAfterWarmup, "warm search reads nothing while the stamp is unchanged");
  const inoBefore = (await lstat(shardDir)).ino;

  await runChildPeer({
    memoryDir,
    hostModel: "host-model-a",
    memoryId: "mem-b",
    text: CHILD_TEXT,
    relPath: "namespaces/alpha/facts/child-b.md",
  });

  assert.equal((await lstat(shardDir)).ino, inoBefore, "precondition: the peer rewrote shards in place (no directory swap)");
  await utimes(shardDir, aliasedTickSec, aliasedTickSec);

  const hits = await fallback.search(CHILD_TEXT, 5);
  assert.equal(
    hits[0]?.id,
    "mem-b",
    "a peer write that lands in an aliased stat tick must still invalidate the warm cache",
  );
  assert.ok(counting.reads() > readsAfterWarmup, "the aliased peer write must trigger revalidation reads");
  assert.match(
    (await fallback.search(PARENT_TEXT, 5))[0]?.id ?? "",
    /^mem-a-/,
    "parent entries survive the peer's write (merge, not replacement)",
  );
});
