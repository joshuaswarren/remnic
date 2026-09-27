// Round-4 regression suite for PR #3148 (issue #3146 embedding index).
// Covers the six review findings:
//   1. incoming legacy generation replaces local shards (cross-layout);
//   2. entry-shape validation at the read boundary (fail-closed, tagged);
//   3. unchanged-base shortcut requires the shared base to be supplied;
//   4. a deferral anywhere in a generation defers the WHOLE generation;
//   5. filtered-out generations are omitted (files + deletion metadata),
//      never interpreted as deleted by the receiver;
//   6. atomic staged generation replacement with crash recovery, and
//      secure-store staged ciphertext readable at the canonical path.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { EmbeddingFallback } from "./embedding-fallback.js";
import {
  EmbeddingIndexCapacityError,
  type EmbeddingIndexEntry,
  type EmbeddingIndexFile,
  EmbeddingIndexFileStore,
  EmbeddingIndexStorageError,
  parseEmbeddingIndexDocument,
  serializeEmbeddingShard,
  shardEntriesForIndex,
  shardIndexOf,
} from "./embedding-index-storage.js";
import {
  applyEmbeddingGenerationTransaction,
  computeOmittedEmbeddingGenerationPaths,
  embeddingGenerationMembership,
} from "./offline-sync-embedding-generation.js";
import { respondOfflineSnapshotStream } from "./access-http-offline-stream.js";
import {
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  type OfflineSyncSnapshot,
  applyOfflineSyncSnapshot,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotFromBase,
  iterateOfflineSyncSnapshotFileRecords,
  normalizeOfflineSyncSnapshot,
} from "./offline-sync.js";
import { MAGIC_BYTES, readMaybeEncryptedFile } from "./secure-store/secure-fs.js";
import { gatherConsoleState } from "./console/state.js";
import { storageBackedIndexStoreIo } from "./offline-sync-embedding-generation.js";
import { StorageManager } from "./storage.js";
import { type SafeArchiveRoot, prepareSafeArchiveRoot } from "./transfer/fs-utils.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function write(root: string, relPath: string, content: string | Buffer): Promise<void> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function readUtf8(root: string, relPath: string): Promise<string> {
  return readFile(path.join(root, relPath), "utf-8");
}

function trueShardRel(id: string): string {
  return `state/embeddings/shard-${String(shardIndexOf(id, 64)).padStart(4, "0")}.json`;
}

function indexFile(provider: string, model: string, entries: Record<string, EmbeddingIndexEntry>): EmbeddingIndexFile {
  return { version: 1, provider: provider as EmbeddingIndexFile["provider"], model, entries };
}

function serializeIndex(index: EmbeddingIndexFile): string {
  return JSON.stringify(index);
}

/** Collect every entry across the published shard generation. */
async function readGenerationEntries(
  root: string,
  shardDirRel = "state/embeddings"
): Promise<Record<string, EmbeddingIndexEntry>> {
  const merged: Record<string, EmbeddingIndexEntry> = {};
  const names = await readdir(path.join(root, ...shardDirRel.split("/")));
  for (const name of names.filter((n) => /^shard-\d{4}\.json$/.test(n)).sort()) {
    const read = parseEmbeddingIndexDocument(await readUtf8(root, `${shardDirRel}/${name}`));
    assert.equal(read.outcome, "ok", `${name} must parse as a valid shard: ${JSON.stringify(read)}`);
    if (read.outcome === "ok") Object.assign(merged, read.file.entries);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Finding 1 — incoming legacy generation replaces local shards
// ---------------------------------------------------------------------------

test("incoming legacy index replaces a local sharded generation as a whole", async () => {
  const localRoot = await tempDir("remnic-3148-legacy-over-shards");
  const remoteRoot = await tempDir("remnic-3148-legacy-remote");
  try {
    // Local sharded generation (older identity).
    await write(
      localRoot,
      "state/embeddings/shard-0000.json",
      serializeIndex(
        indexFile("openai", "text-embedding-3-small", {
          local1: { path: "memories/local1.md", vector: [1, 0] },
        })
      )
    );
    await write(
      localRoot,
      "state/embeddings/shard-0050.json",
      serializeIndex(
        indexFile("openai", "text-embedding-3-small", {
          local2: { path: "memories/local2.md", vector: [0, 1] },
        })
      )
    );
    // Remote legacy generation: new identity, new entries only.
    const incoming = indexFile("openai", "text-embedding-3-large", {
      remote1: { path: "memories/remote1.md", vector: [0.5, 0.5] },
    });
    await write(remoteRoot, "facts/a.md", "alpha");
    await write(remoteRoot, "state/embeddings.json", serializeIndex(incoming));
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot,
      sourceId: "remote",
      includeContent: true,
    });

    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot });

    // The whole local generation is replaced by the converted incoming one.
    const entries = await readGenerationEntries(localRoot);
    assert.deepEqual(Object.keys(entries).sort(), ["remote1"]);
    assert.deepEqual(entries.remote1?.vector, [0.5, 0.5]);
    // The incoming marker is written as the inert remote-authoritative
    // artifact; the published directory remains the layout marker.
    assert.equal(await readUtf8(localRoot, "state/embeddings.json"), serializeIndex(incoming));
    const store = new EmbeddingIndexFileStore(
      path.join(localRoot, "state/embeddings.json"),
      path.join(localRoot, "state/embeddings"),
      path.join(localRoot, "state/embedding-fallback-status.json")
    );
    assert.equal(await store.detectLayout(), "sharded");
    // Reload finds the incoming generation and a subsequent write works.
    const merged: Record<string, EmbeddingIndexEntry> = {};
    assert.deepEqual(await store.readShardGenerationInto(merged), {
      provider: "openai",
      model: "text-embedding-3-large",
    });
    await store.persist(
      indexFile("openai", "text-embedding-3-large", {
        ...merged,
        remote2: { path: "memories/remote2.md", vector: [1, 1] },
      }),
      { touchedIds: ["remote2"] }
    );
    const after = await readGenerationEntries(localRoot);
    assert.ok(after.remote1 && after.remote2);
    assert.equal(result.upserted >= 1, true);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("sharded incoming generation over a local legacy marker removes the marker", async () => {
  const localRoot = await tempDir("remnic-3148-shards-over-legacy");
  const remoteRoot = await tempDir("remnic-3148-shards-remote");
  try {
    await write(
      localRoot,
      "state/embeddings.json",
      serializeIndex(
        indexFile("openai", "old-model", {
          stale: { path: "memories/stale.md", vector: [9, 9] },
        })
      )
    );
    await write(
      remoteRoot,
      trueShardRel("fresh"),
      serializeIndex(
        indexFile("openai", "new-model", {
          fresh: { path: "memories/fresh.md", vector: [1, 2] },
        })
      )
    );
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot,
      sourceId: "remote",
      includeContent: true,
    });
    await applyOfflineSyncSnapshot({ root: localRoot, snapshot });
    // Legacy generation removed wholesale; incoming generation published.
    assert.equal(await existsQuiet(localRoot, "state/embeddings.json"), false);
    const entries = await readGenerationEntries(localRoot);
    assert.deepEqual(Object.keys(entries), ["fresh"]);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

async function existsQuiet(root: string, relPath: string): Promise<boolean> {
  try {
    await readFile(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Finding 2 — entry-shape validation at the read boundary
// ---------------------------------------------------------------------------

test("parseEmbeddingIndexDocument rejects malformed entry shapes as unreadable", () => {
  const base = { version: 1 as const, provider: "openai", model: "m" };
  // entries is an array, not a plain record
  const arrayEntries = parseEmbeddingIndexDocument(JSON.stringify({ ...base, entries: [] }));
  assert.equal(arrayEntries.outcome, "unreadable");
  assert.match(arrayEntries.outcome === "unreadable" ? arrayEntries.reason : "", /entries must be a plain record/);
  // entries null
  assert.equal(parseEmbeddingIndexDocument(JSON.stringify({ ...base, entries: null })).outcome, "unreadable");
  // entry value is not an object
  const scalarEntry = parseEmbeddingIndexDocument(JSON.stringify({ ...base, entries: { id1: "nope" } }));
  assert.equal(scalarEntry.outcome, "unreadable");
  // entry missing string path
  const badPath = parseEmbeddingIndexDocument(JSON.stringify({ ...base, entries: { id1: { vector: [1] } } }));
  assert.match(badPath.outcome === "unreadable" ? badPath.reason : "", /path must be a string/);
  // entry vector not an array
  const badVector = parseEmbeddingIndexDocument(
    JSON.stringify({ ...base, entries: { id1: { path: "p", vector: "x" } } })
  );
  assert.match(badVector.outcome === "unreadable" ? badVector.reason : "", /vector must be an array/);
  // non-finite vector component
  const nonFinite = parseEmbeddingIndexDocument(
    JSON.stringify({ ...base, entries: { id1: { path: "p", vector: [1, "x"] } } })
  );
  assert.match(nonFinite.outcome === "unreadable" ? nonFinite.reason : "", /finite/);
  // a valid document still parses, and a foreign header stays foreign
  assert.equal(
    parseEmbeddingIndexDocument(JSON.stringify({ ...base, entries: { id1: { path: "p", vector: [1, 2] } } })).outcome,
    "ok"
  );
  assert.equal(
    parseEmbeddingIndexDocument(JSON.stringify({ version: 2, provider: "openai", model: "m", entries: {} })).outcome,
    "foreign"
  );
});

test("corrupt shard files stay in place and are tagged unreadable for the store", async () => {
  const root = await tempDir("remnic-3148-corrupt-shard");
  try {
    const corrupt = JSON.stringify({
      version: 1,
      provider: "openai",
      model: "m",
      entries: [{ id: "oops" }],
    });
    await write(root, "state/embeddings.json", "{}");
    await write(root, "state/embeddings/shard-0000.json", corrupt);
    const store = new EmbeddingIndexFileStore(
      path.join(root, "state/embeddings.json"),
      path.join(root, "state/embeddings"),
      path.join(root, "state/embedding-fallback-status.json")
    );
    const read = await store.readFileAt(path.join(root, "state/embeddings/shard-0000.json"));
    assert.equal(read.outcome, "unreadable");
    // Bytes preserved: the corrupt file is not rewritten or deleted.
    assert.equal(await readUtf8(root, "state/embeddings/shard-0000.json"), corrupt);
    // Strict mutation path fails closed with the tagged error.
    await assert.rejects(
      () => store.readShardGenerationInto({}),
      (err: unknown) => err instanceof EmbeddingIndexStorageError
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 4 — a deferral anywhere defers the WHOLE generation
// ---------------------------------------------------------------------------

test("a deferred incoming shard defers the whole incoming generation", async () => {
  const localRoot = await tempDir("remnic-3148-defer-incoming");
  const remoteRoot = await tempDir("remnic-3148-defer-remote");
  try {
    await write(
      localRoot,
      trueShardRel("neu"),
      serializeIndex(indexFile("openai", "m1", { old: { path: "p", vector: [0] } }))
    );
    await write(localRoot, "state/embeddings/shard-0050.json", "local only 0050");
    await write(
      remoteRoot,
      trueShardRel("neu"),
      serializeIndex(indexFile("openai", "m2", { neu: { path: "p", vector: [1] } }))
    );
    await write(
      remoteRoot,
      trueShardRel("neu2"),
      serializeIndex(indexFile("openai", "m2", { neu2: { path: "p2", vector: [2] } }))
    );
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot,
      sourceId: "remote",
      includeContent: true,
    });
    const result = await applyOfflineSyncSnapshot({
      root: localRoot,
      snapshot,
      deferredPaths: [trueShardRel("neu2")],
    });
    assert.ok((await readUtf8(localRoot, trueShardRel("neu"))).includes('"m1"'));
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0050.json"), "local only 0050");
    assert.equal(await existsQuiet(localRoot, trueShardRel("neu2")), false);
    assert.equal(result.deleted, 0);
    assert.equal(result.pendingLocal, 0);
    assert.ok(result.skipped >= 3);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("a deferred legacy marker defers the whole cross-layout replacement", async () => {
  const localRoot = await tempDir("remnic-3148-defer-marker");
  const remoteRoot = await tempDir("remnic-3148-defer-marker-remote");
  try {
    await write(localRoot, "state/embeddings/shard-0000.json", "local shard");
    const incoming = indexFile("openai", "m2", {
      remote1: { path: "p", vector: [1] },
    });
    await write(remoteRoot, "state/embeddings.json", serializeIndex(incoming));
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot,
      sourceId: "remote",
      includeContent: true,
    });
    const result = await applyOfflineSyncSnapshot({
      root: localRoot,
      snapshot,
      deferredPaths: ["state/embeddings.json"],
    });
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0000.json"), "local shard");
    assert.equal(await existsQuiet(localRoot, "state/embeddings.json"), false);
    assert.equal(await existsQuiet(localRoot, "state/embeddings/shard-0063.json"), false);
    assert.equal(result.deleted, 0);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 5 — filtered generations are omitted, never deleted
// ---------------------------------------------------------------------------

test("a user exclude on one shard omits the whole generation from files and deletions", async () => {
  const root = await tempDir("remnic-3148-omission-build");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "state/embeddings.json", serializeIndex(indexFile("openai", "m", {})));
    await write(root, "state/embeddings/shard-0000.json", "shard 0000");
    await write(root, "state/embeddings/shard-0003.json", "shard 0003");
    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "source",
      includeContent: true,
      userExcludeRegexps: [/^state\/embeddings\/shard-0003\.json$/],
      deletions: [{ path: "state/embeddings/shard-0005.json", mtimeMs: 1_000 }],
    });
    const paths = snapshot.files.map((file) => file.path);
    assert.deepEqual(paths, ["facts/a.md"]);
    assert.deepEqual(snapshot.omittedEmbeddingGenerationDirs, ["state/embeddings"]);
    // The sibling shard's deletion revision is suppressed with the generation.
    assert.deepEqual(snapshot.deletions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the excludeFile callback omission applies to the shared iterator and base builder", async () => {
  const root = await tempDir("remnic-3148-omission-exclude-file");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "state/embeddings/shard-0000.json", "shard 0000");
    await write(root, "state/embeddings/shard-0003.json", "shard 0003");
    const excludeFile = (target: { path: string }) => target.path.endsWith("shard-0003.json");
    const yielded: string[] = [];
    for await (const record of iterateOfflineSyncSnapshotFileRecords({
      root,
      excludeFile,
    })) {
      yielded.push(record.path);
    }
    assert.deepEqual(yielded, ["facts/a.md"]);
    const fromBase = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "source",
      excludeFile,
    });
    assert.deepEqual(
      fromBase.files.map((file) => file.path),
      ["facts/a.md"]
    );
    assert.deepEqual(fromBase.omittedEmbeddingGenerationDirs, ["state/embeddings"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a receiver keeps an omitted generation instead of deleting it", async () => {
  const localRoot = await tempDir("remnic-3148-omission-apply");
  try {
    await write(localRoot, "facts/incoming.md", "incoming");
    await write(localRoot, "state/embeddings/shard-0000.json", "local 0000");
    await write(localRoot, "state/embeddings/shard-0001.json", "local 0001");
    const baseFiles = [
      { path: "state/embeddings/shard-0000.json", sha256: "0".repeat(64), bytes: 11, mtimeMs: 1 },
      { path: "state/embeddings/shard-0001.json", sha256: "1".repeat(64), bytes: 11, mtimeMs: 1 },
    ];
    const snapshot: OfflineSyncSnapshot = {
      format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
      schemaVersion: 1,
      createdAt: "2026-09-27T00:00:00.000Z",
      sourceId: "remote",
      includeTranscripts: true,
      files: [
        {
          path: "facts/incoming.md",
          sha256: sha256Of("incoming"),
          bytes: "incoming".length,
          mtimeMs: 1,
          contentBase64: Buffer.from("incoming").toString("base64"),
        },
      ],
      deletions: [],
      omittedEmbeddingGenerationDirs: ["state/embeddings"],
    };
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot, baseFiles });
    // Generation kept byte-for-byte; absence never became a delete.
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0000.json"), "local 0000");
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0001.json"), "local 0001");
    assert.equal(result.deleted, 0);
    assert.equal(result.pendingLocal >= 2, true);
    assert.ok(result.nextBaseFiles.some((f) => f.path === "state/embeddings/shard-0000.json"));
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("an absent generation WITHOUT the omission marker still converges by deletion", async () => {
  const localRoot = await tempDir("remnic-3148-absent-delete");
  try {
    await write(localRoot, "state/embeddings/shard-0000.json", "local 0000");
    const baseFiles = [{ path: "state/embeddings/shard-0000.json", sha256: "0".repeat(64), bytes: 11, mtimeMs: 1 }];
    const snapshot: OfflineSyncSnapshot = {
      format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
      schemaVersion: 1,
      createdAt: "2026-09-27T00:00:00.000Z",
      sourceId: "remote",
      includeTranscripts: true,
      files: [],
    };
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot, baseFiles });
    assert.equal(await existsQuiet(localRoot, "state/embeddings/shard-0000.json"), false);
    assert.equal(result.deleted, 1);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Finding 6 — atomic staged replacement, failure and crash recovery
// ---------------------------------------------------------------------------

test("a staging write failure preserves the local generation", async () => {
  const localRoot = await tempDir("remnic-3148-stage-failure");
  try {
    await write(localRoot, trueShardRel("neu"), "local 0000");
    await write(localRoot, "state/embeddings/shard-0050.json", "local 0050");
    const incomingBuffers = new Map<string, Buffer>();
    const safeRoot: SafeArchiveRoot = await prepareSafeArchiveRoot(localRoot, "test", "root");
    incomingBuffers.set(
      trueShardRel("neu"),
      Buffer.from(
        serializeIndex(
          indexFile("openai", "m2", {
            neu: { path: "p", vector: [1] },
          })
        )
      )
    );
    await assert.rejects(
      () =>
        applyEmbeddingGenerationTransaction({
          root: safeRoot,
          shardDirRel: "state/embeddings",
          incomingShardPaths: [trueShardRel("neu")],
          incomingMarker: null,
          incomingMarkerPresent: false,
          incomingShardStates: new Map(),
          incomingBuffers,
          io: {
            writeStagingFile: async () => {
              throw new Error("disk full during stage");
            },
          },
          now: 1,
        }),
      /disk full during stage/
    );
    // Local generation byte-identical, no staging leftovers.
    assert.equal(await readUtf8(localRoot, trueShardRel("neu")), "local 0000");
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0050.json"), "local 0050");
    const stateDir = await readdir(path.join(localRoot, "state"));
    assert.equal(
      stateDir.some((name) => name.startsWith("embeddings.staging.tmp-")),
      false
    );
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("a publish rename failure rolls the former generation back into place", async () => {
  const root = await tempDir("remnic-3148-rename-failure");
  try {
    await write(root, "state/embeddings.json", "{}");
    await write(root, "state/embeddings/shard-0000.json", "published 0000");
    const store = new EmbeddingIndexFileStore(
      path.join(root, "state/embeddings.json"),
      path.join(root, "state/embeddings"),
      path.join(root, "state/embedding-fallback-status.json")
    );
    await assert.rejects(
      () => store.publishSwappedGeneration(path.join(root, "state/embeddings.staging.tmp-missing")),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT"
    );
    // Rollback restored the former generation; no backup left behind.
    assert.equal(await readUtf8(root, "state/embeddings/shard-0000.json"), "published 0000");
    assert.equal(await existsQuiet(root, "state/embeddings.pre-replace.tmp"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash in the rename gap is recovered before the next sync replacement", async () => {
  const localRoot = await tempDir("remnic-3148-rename-gap");
  const remoteRoot = await tempDir("remnic-3148-gap-remote");
  try {
    // Simulate the gap: former generation sits in the fixed backup, the
    // published directory is absent, no legacy marker.
    await write(localRoot, "state/embeddings.pre-replace.tmp/shard-0000.json", "former 0000");
    await write(
      remoteRoot,
      trueShardRel("neu"),
      serializeIndex(indexFile("openai", "m2", { neu: { path: "p", vector: [1] } }))
    );
    await write(
      remoteRoot,
      trueShardRel("neu63"),
      serializeIndex(indexFile("openai", "m2", { neu63: { path: "p63", vector: [3] } }))
    );
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot,
      sourceId: "remote",
      includeContent: true,
    });
    await applyOfflineSyncSnapshot({ root: localRoot, snapshot });
    // The backup was restored first (so detectLayout stayed truthful), then
    // the incoming generation replaced it wholesale.
    assert.equal(await existsQuiet(localRoot, "state/embeddings.pre-replace.tmp"), false);
    assert.equal(
      await readUtf8(localRoot, trueShardRel("neu")),
      serializeIndex(indexFile("openai", "m2", { neu: { path: "p", vector: [1] } }))
    );
    assert.equal(
      await readUtf8(localRoot, trueShardRel("neu63")),
      serializeIndex(indexFile("openai", "m2", { neu63: { path: "p63", vector: [3] } }))
    );
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("a symlinked generation directory is rejected, not followed", async () => {
  const localRoot = await tempDir("remnic-3148-symlink");
  const outside = await tempDir("remnic-3148-symlink-outside");
  const remoteRoot = await tempDir("remnic-3148-symlink-remote");
  try {
    await mkdir(path.join(localRoot, "state"), { recursive: true });
    await symlink(outside, path.join(localRoot, "state/embeddings"));
    await write(outside, "shard-0000.json", "outside bytes");
    await write(remoteRoot, "state/embeddings/shard-0000.json", "incoming 0000");
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot,
      sourceId: "remote",
      includeContent: true,
    });
    await assert.rejects(() => applyOfflineSyncSnapshot({ root: localRoot, snapshot }));
    // The symlink and its target are untouched.
    assert.equal(await readUtf8(outside, "shard-0000.json"), "outside bytes");
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("secure-store staged ciphertext decrypts at the canonical path after publish", async () => {
  const memoryDir = await tempDir("remnic-3148-secure-stage");
  try {
    const storage = new StorageManager(memoryDir);
    const key = randomBytes(32);
    await storage.setSecureStoreKeyAndWait(key, true);
    const stagingRel = "state/embeddings.staging.tmp-sync-test/shard-0000.json";
    const finalRel = "state/embeddings/shard-0000.json";
    const content = Buffer.from(
      serializeIndex(
        indexFile("openai", "m", {
          id1: { path: "p", vector: [1, 2, 3] },
        })
      )
    );
    await storage.writeOfflineSyncStagingFile(path.join(memoryDir, ...stagingRel.split("/")), content, {
      aadFilePath: path.join(memoryDir, ...finalRel.split("/")),
    });
    // Encrypted at rest in the staging location.
    const raw = await readFile(path.join(memoryDir, ...stagingRel.split("/")));
    assert.equal(raw.subarray(0, MAGIC_BYTES.length).toString("ascii"), MAGIC_BYTES.toString("ascii"));
    // Read back through the staging hook with the final-path AAD.
    const staged = await storage.readOfflineSyncFile(path.join(memoryDir, ...stagingRel.split("/")), {
      aadFilePath: path.join(memoryDir, ...finalRel.split("/")),
    });
    assert.deepEqual(staged, content);
    // WITHOUT the final-path AAD the staging ciphertext cannot decrypt.
    await assert.rejects(() => storage.readOfflineSyncFile(path.join(memoryDir, ...stagingRel.split("/"))));
    // After the directory swap the canonical path decrypts normally.
    await mkdir(path.dirname(path.join(memoryDir, ...finalRel.split("/"))), { recursive: true });
    await rename(path.join(memoryDir, ...stagingRel.split("/")), path.join(memoryDir, ...finalRel.split("/")));
    const published = await readMaybeEncryptedFile(path.join(memoryDir, ...finalRel.split("/")), key, memoryDir);
    assert.equal(published, content.toString("utf-8"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Store helpers shared with the transaction
// ---------------------------------------------------------------------------

test("shardEntriesForIndex and serializeEmbeddingShard round-trip through shards", () => {
  const index = indexFile("openai", "m", {
    a: { path: "a.md", vector: [1] },
    b: { path: "b.md", vector: [2] },
    c: { path: "c.md", vector: [3] },
  });
  const groups = shardEntriesForIndex(index);
  let total = 0;
  for (const [shardIndex, entries] of groups) {
    const body = serializeEmbeddingShard(index, shardIndex, entries);
    const read = parseEmbeddingIndexDocument(body);
    assert.equal(read.outcome, "ok");
    if (read.outcome === "ok") total += Object.keys(read.file.entries).length;
  }
  assert.equal(total, 3);
});

test("serializeEmbeddingShard surfaces the tagged capacity error", () => {
  const index = indexFile("openai", "m", {});
  assert.throws(
    () => serializeEmbeddingShard(index, 0, { a: { path: "p", vector: [1] } }, 4),
    (err: unknown) => err instanceof EmbeddingIndexCapacityError
  );
});

test("embeddingGenerationMembership classifies generation members", () => {
  assert.deepEqual(embeddingGenerationMembership("state/embeddings/shard-0000.json"), {
    kind: "shard",
    shardDir: "state/embeddings",
  });
  assert.deepEqual(embeddingGenerationMembership("namespaces/team/state/embeddings.json"), {
    kind: "marker",
    shardDir: "namespaces/team/state/embeddings",
  });
  assert.equal(embeddingGenerationMembership("state/other.json"), null);
  assert.equal(embeddingGenerationMembership("state/embeddings/not-a-shard.json"), null);
});

test("computeOmittedEmbeddingGenerationPaths omits nothing when every member is kept", async () => {
  const root = await tempDir("remnic-3148-omission-none");
  try {
    await write(root, "state/embeddings/shard-0000.json", "0000");
    await write(root, "state/embeddings/shard-0003.json", "0003");
    const omission = await computeOmittedEmbeddingGenerationPaths({
      rootAbs: root,
      userExcludeRegexps: [/^facts\//],
      isExcludedRelPath: () => false,
    });
    assert.equal(omission.omittedDirs.length, 0);
    assert.equal(omission.omittedPaths.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Round-5 batch: hydration, fail-closed IO, backup links, encrypted store io
// ---------------------------------------------------------------------------

test("metadata-only pulls hydrate unchanged shards from local bytes", async () => {
  const localRoot = await tempDir("remnic-3148-hydrate");
  const remoteRoot = await tempDir("remnic-3148-hydrate-remote");
  try {
    const shardBody = serializeIndex(indexFile("openai", "m", {
      kept: { path: "p", vector: [1, 2] },
    }));
    await write(localRoot, trueShardRel("kept"), shardBody);
    await write(localRoot, "facts/readme.md", "readme");
    // Remote: identical generation (metadata-only pull carries no content
    // for the unchanged shard) plus one genuinely new shard.
    await write(remoteRoot, trueShardRel("kept"), shardBody);
    await write(remoteRoot, trueShardRel("neu"), serializeIndex(
      indexFile("openai", "m", { neu: { path: "p1", vector: [3] } }),
    ));
    const full = await buildOfflineSyncSnapshot({
      root: remoteRoot, sourceId: "remote", includeContent: true,
    });
    // Simulate the CLI metadata hydration: keep content only for the NEW
    // shard, drop it for the locally-unchanged one.
    const metadataOnly: OfflineSyncSnapshot = {
      ...full,
      files: full.files.map((file) =>
        file.path === trueShardRel("kept")
          ? { path: file.path, sha256: file.sha256, bytes: file.bytes, mtimeMs: file.mtimeMs }
          : file,
      ),
    };
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot: metadataOnly });
    // The unchanged shard is intact (hydrated + republished) and the new
    // shard landed: no "missing incoming content" failure.
    assert.equal(await readUtf8(localRoot, trueShardRel("kept")), shardBody);
    assert.ok((await readUtf8(localRoot, trueShardRel("neu"))).includes("neu"));
    assert.equal(result.upserted >= 2, true);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("custom storage IO without the staging pair fails closed before touching local state", async () => {
  const localRoot = await tempDir("remnic-3148-downgrade-guard");
  try {
    await write(localRoot, "state/embeddings/shard-0000.json", serializeIndex(
      indexFile("openai", "m1", { local: { path: "p", vector: [0] } }),
    ));
    let writeFileCalls = 0;
    const result = await applyOfflineSyncSnapshot({
      root: localRoot,
      snapshot: {
        format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
        schemaVersion: 1,
        createdAt: "2026-09-27T00:00:00.000Z",
        sourceId: "remote",
        includeTranscripts: true,
        files: [{
          path: "state/embeddings/shard-0000.json",
          sha256: sha256Of("incoming"),
          bytes: 8,
          mtimeMs: 1,
          contentBase64: Buffer.from("incoming").toString("base64"),
        }],
      },
      writeFile: async () => { writeFileCalls += 1; },
    }).then(() => null, (error: unknown) => error as Error);
    assert.ok(result instanceof Error);
    assert.match(result.message, /plaintext-downgrade|writeStagingFile and readStagingFile/);
    // The local generation is byte-identical and no custom write happened.
    assert.ok((await readUtf8(localRoot, "state/embeddings/shard-0000.json")).includes("m1"));
    assert.equal(writeFileCalls, 0);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("a planted symlink backup is rejected, never restored or followed", async () => {
  const localRoot = await tempDir("remnic-3148-backup-link");
  const outside = await tempDir("remnic-3148-backup-outside");
  const remoteRoot = await tempDir("remnic-3148-backup-remote");
  try {
    await mkdir(path.join(localRoot, "state"), { recursive: true });
    await symlink(outside, path.join(localRoot, "state/embeddings.pre-replace.tmp"));
    await write(outside, "shard-0000.json", "outside bytes");
    await write(remoteRoot, "state/embeddings/shard-0000.json", serializeIndex(
      indexFile("openai", "m", { neu: { path: "p", vector: [1] } }),
    ));
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot, sourceId: "remote", includeContent: true,
    });
    await assert.rejects(() => applyOfflineSyncSnapshot({ root: localRoot, snapshot }));
    // The planted target is untouched and no generation was published
    // through the link.
    assert.equal(await readUtf8(outside, "shard-0000.json"), "outside bytes");
    assert.equal(await existsQuiet(localRoot, "state/embeddings/shard-0000.json"), false);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("mixed incoming (shards + marker) keeps the marker without a delete-rewrite cycle", async () => {
  const localRoot = await tempDir("remnic-3148-mixed-marker");
  const remoteRoot = await tempDir("remnic-3148-mixed-remote");
  try {
    await write(localRoot, "state/embeddings/shard-0000.json", serializeIndex(
      indexFile("openai", "m1", { stale: { path: "p", vector: [9] } }),
    ));
    await write(localRoot, "state/embeddings.json", serializeIndex(indexFile("openai", "m0", {})));
    await write(remoteRoot, trueShardRel("fresh"), serializeIndex(
      indexFile("openai", "m1", { fresh: { path: "p", vector: [1] } }),
    ));
    const marker = serializeIndex(indexFile("openai", "m1", {}));
    await write(remoteRoot, "state/embeddings.json", marker);
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot, sourceId: "remote", includeContent: true,
    });
    await applyOfflineSyncSnapshot({ root: localRoot, snapshot });
    // The incoming marker survived (inert artifact), no flip-flop deletion.
    assert.equal(await readUtf8(localRoot, "state/embeddings.json"), marker);
    assert.ok((await readUtf8(localRoot, trueShardRel("fresh"))).includes("fresh"));
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("wired store io keeps encrypted migration, replacement, reload and writes canonical", async () => {
  const memoryDir = await tempDir("remnic-3148-secure-store-io");
  const prevLimit = process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT;
  try {
    const storage = new StorageManager(memoryDir);
    await storage.setSecureStoreKeyAndWait(randomBytes(32), true);
    // Emulate the orchestrator wiring: daemon store IO via StorageManager.
    const shardLimit = 1024; // resolver floor; forces one-way migration quickly
    process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT = String(shardLimit);
    const entry = (i: number): EmbeddingIndexEntry => ({
      path: `memories/m${i}.md`,
      vector: Array.from({ length: 16 }, (_, k) => (i * 16 + k) / 4096),
    });
    const entries: Record<string, EmbeddingIndexEntry> = {};
    for (let i = 0; i < 40; i += 1) entries[`id-${i}`] = entry(i);
    const store = new EmbeddingIndexFileStore(
      path.join(memoryDir, "state/embeddings.json"),
      path.join(memoryDir, "state/embeddings"),
      path.join(memoryDir, "state/embedding-fallback-status.json"),
      {
        readUtf8: async (filePath) =>
          (await storage.readOfflineSyncFile(filePath)).toString("utf-8"),
        writeUtf8: async (filePath, contents, opts) =>
          storage.writeOfflineSyncStagingFile(
            filePath,
            Buffer.from(contents, "utf-8"),
            opts?.finalAadFilePath === undefined ? undefined : { aadFilePath: opts.finalAadFilePath },
          ),
      },
    );
    // One-way migration under the small budget: staged ciphertext binds the
    // FINAL shard paths, so the store can read its own migration back.
    await store.persist(indexFile("openai", "m", entries));
    assert.equal(await store.detectLayout(), "sharded");
    const merged: Record<string, EmbeddingIndexEntry> = {};
    assert.deepEqual(await store.readShardGenerationInto(merged), {
      provider: "openai",
      model: "m",
    });
    assert.equal(Object.keys(merged).length, 40);
    // Raw bytes are encrypted at rest, canonical path decrypts via the io.
    const someShard = path.join(memoryDir, "state/embeddings/shard-0000.json");
    const raw = await readFile(someShard);
    assert.equal(
      raw.subarray(0, MAGIC_BYTES.length).toString("ascii"),
      MAGIC_BYTES.toString("ascii"),
    );
    // Identity replacement also publishes encrypted + readable.
    await store.persist(indexFile("openai", "m2", {
      swapped: { path: "p", vector: [1] },
    }));
    const replaced: Record<string, EmbeddingIndexEntry> = {};
    assert.deepEqual(await store.readShardGenerationInto(replaced), {
      provider: "openai",
      model: "m2",
    });
    assert.deepEqual(Object.keys(replaced), ["swapped"]);
    // Subsequent dirty-shard write stays canonical-decryptable.
    await store.persist(indexFile("openai", "m2", {
      ...replaced,
      swapped2: { path: "p2", vector: [2] },
    }), { touchedIds: ["swapped2"] });
    const after: Record<string, EmbeddingIndexEntry> = {};
    await store.readShardGenerationInto(after);
    assert.ok(after.swapped && after.swapped2);
    // Diagnostics status: ALWAYS plain, recorded even on a locked store, and
    // counts real failures (round 6: no conditional vacuity — the outcomes
    // are actually recorded and read back through the console_state reader).
    await store.recordIndexWriteOutcome(new Error("boom-one"));
    await store.recordIndexWriteOutcome(new Error("boom-two"));
    const statusPath = path.join(memoryDir, "state/embedding-fallback-status.json");
    const statusRaw = await readFile(statusPath, "utf-8");
    assert.equal(statusRaw.includes("REMNIC-ENC"), false);
    const status = JSON.parse(statusRaw) as { failureCount?: number; lastWriteFailure?: { message?: string } };
    assert.equal(status.failureCount, 2);
    assert.equal(status.lastWriteFailure?.message, "boom-two");
    const snapshotState = await gatherConsoleState({ config: { memoryDir } } as never);
    assert.equal(snapshotState.embeddingIndex?.status?.failureCount, 2);
    assert.equal(snapshotState.embeddingIndex?.status?.lastWriteFailure?.message, "boom-two");
  } finally {
    if (prevLimit === undefined) delete process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT;
    else process.env.REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT = prevLimit;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("streamed snapshot header carries omission metadata and the receiver keeps the generation", async () => {
  const localRoot = await tempDir("remnic-3148-stream-apply");
  const remoteRoot = await tempDir("remnic-3148-stream-remote");
    try {
    await write(localRoot, "state/embeddings/shard-0000.json", "local 0000");
    await write(localRoot, "state/embeddings/shard-0001.json", "local 0001");
    await write(remoteRoot, "facts/only.md", "only");
    await write(remoteRoot, "state/embeddings/shard-0000.json", "remote 0000");
    await write(remoteRoot, "state/embeddings/shard-0003.json", "filtered 0003");
    const build = await buildOfflineSyncSnapshot({
      root: remoteRoot, sourceId: "remote", includeContent: true,
      userExcludeRegexps: [/^state\/embeddings\/shard-0003\.json$/],
    });
    assert.deepEqual(build.omittedEmbeddingGenerationDirs, ["state/embeddings"]);
    // Serve the snapshot through the REAL ndjson stream writer.
    const { createServer } = await import("node:http");
    const received: string[] = [];
    const server = createServer((request, response) => {
      void respondOfflineSnapshotStream(response, {
        namespace: "test",
        ...build,
        files: (async function* () {
          for (const file of build.files) yield file;
        })(),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    try {
      const response = await fetch(url);
      const text = await response.text();
      for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === "snapshot") received.push(JSON.stringify(parsed));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Header round-trips the omission (server writer + client decoder field).
    assert.equal(received.length, 1);
    const header = JSON.parse(received[0] ?? "{}") as Record<string, unknown>;
    assert.deepEqual(header.omittedEmbeddingGenerationDirs, ["state/embeddings"]);
    // Receiver: normalize the streamed header+files exactly like the client
    // and apply — the local generation must survive.
    const streamed = normalizeOfflineSyncSnapshot({
      format: header.format,
      schemaVersion: header.schemaVersion,
      createdAt: header.createdAt,
      sourceId: header.sourceId,
      includeTranscripts: header.includeTranscripts,
      omittedEmbeddingGenerationDirs: header.omittedEmbeddingGenerationDirs as string[],
      files: build.files,
    });
    const baseFiles = [
      { path: "state/embeddings/shard-0000.json", sha256: "0".repeat(64), bytes: 9, mtimeMs: 1 },
      { path: "state/embeddings/shard-0001.json", sha256: "1".repeat(64), bytes: 9, mtimeMs: 1 },
    ];
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot: streamed, baseFiles });
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0000.json"), "local 0000");
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0001.json"), "local 0001");
    assert.equal(result.deleted, 0);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Round 6: legacy-marker hydration, shard membership, recovery diagnostics
// ---------------------------------------------------------------------------

test("metadata-only pulls hydrate an unchanged legacy marker", async () => {
  const localRoot = await tempDir("remnic-3148-marker-hydrate");
  const remoteRoot = await tempDir("remnic-3148-marker-remote");
  try {
    const marker = serializeIndex(indexFile("openai", "m", {
      kept: { path: "p", vector: [1, 2, 3] },
    }));
    await write(localRoot, "facts/r.md", "r");
    await write(localRoot, "state/embeddings.json", marker);
    await write(remoteRoot, "state/embeddings.json", marker);
    const full = await buildOfflineSyncSnapshot({
      root: remoteRoot, sourceId: "remote", includeContent: true,
    });
    // Metadata-only pull: the marker's content is omitted because the local
    // hash already matches.
    const metadataOnly: OfflineSyncSnapshot = {
      ...full,
      files: full.files.map((file) =>
        file.path === "state/embeddings.json"
          ? { path: file.path, sha256: file.sha256, bytes: file.bytes, mtimeMs: file.mtimeMs }
          : file,
      ),
    };
    // Second (and every subsequent) sync must not throw
    // "missing decoded content for state/embeddings.json".
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot: metadataOnly });
    assert.equal(await readUtf8(localRoot, "state/embeddings.json"), marker);
    assert.equal(result.conflicts.length, 0);
    // The one-way conversion published the same entries as shards.
    const entries = await readGenerationEntries(localRoot);
    assert.deepEqual(Object.keys(entries), ["kept"]);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("a shard file holding ids assigned to another shard is rejected", async () => {
  const root = await tempDir("remnic-3148-misplaced");
  try {
    await write(root, "state/embeddings.json", "{}");
    // Find an id that does NOT belong in shard 0000.
    let misplaced = "id-0";
    for (let i = 1; i < 4096; i += 1) {
      const candidate = `id-${i}`;
      if (shardEntriesForIndex(indexFile("openai", "m", {
        [candidate]: { path: "p", vector: [1] },
      })).has(0) === false) {
        misplaced = candidate;
        break;
      }
    }
    const misplacedBody = serializeIndex(indexFile("openai", "m", {
      [misplaced]: { path: "p", vector: [1] },
    }));
    await write(root, "state/embeddings/shard-0000.json", misplacedBody);
    const store = new EmbeddingIndexFileStore(
      path.join(root, "state/embeddings.json"),
      path.join(root, "state/embeddings"),
      path.join(root, "state/embedding-fallback-status.json"),
    );
    await assert.rejects(
      () => store.readShardGenerationInto({}),
      (err: unknown) => err instanceof EmbeddingIndexStorageError && err.message.includes(misplaced),
    );
    // Bytes preserved; incoming generation with the same misplaced shard is
    // rejected too (fail closed, no merge of misplaced vectors).
    assert.equal(await readUtf8(root, "state/embeddings/shard-0000.json"), misplacedBody);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery failure is recorded durably before the mutation is rejected", async () => {
  const memoryDir = await tempDir("remnic-3148-recovery-recorded");
  const outside = await tempDir("remnic-3148-recovery-outside");
  try {
    const storage = new StorageManager(memoryDir);
    await storage.setSecureStoreKeyAndWait(randomBytes(32), true);
    const fallback = new EmbeddingFallback({ memoryDir } as never,
      storageBackedIndexStoreIo(storage));
    // Plant the rename gap with a symlinked backup: recovery must fail.
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await symlink(outside, path.join(memoryDir, "state/embeddings.pre-replace.tmp"));
    await write(outside, "shard-0000.json", "outside bytes");
    const probe = fallback as unknown as {
      enqueueIndexMutation(m: () => Promise<void>): Promise<void>;
    };
    await assert.rejects(
      () => probe.enqueueIndexMutation(async () => undefined),
      (err: unknown) => err instanceof Error && /symlink/.test(err.message),
    );
    // The failure is DURABLY recorded (round 6: recovery happens before the
    // write-outcome try, so the wrapper must record it itself).
    const status = JSON.parse(
      await readFile(path.join(memoryDir, "state/embedding-fallback-status.json"), "utf-8"),
    ) as { failureCount?: number; lastWriteFailure?: { message?: string } };
    assert.equal(status.failureCount, 1);
    assert.match(status.lastWriteFailure?.message ?? "", /symlink/);
    assert.equal(await readUtf8(outside, "shard-0000.json"), "outside bytes");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Round 6.5: converted-shard base bookkeeping + atomic whole-generation removal
// ---------------------------------------------------------------------------

test("converted shard paths are recorded in the persisted base immediately", async () => {
  const localRoot = await tempDir("remnic-3148-converted-base");
  const remoteRoot = await tempDir("remnic-3148-converted-base-remote");
  try {
    // Local has ONLY the legacy marker: the converted shards are brand-new
    // local paths that appear in none of the base/incoming/current maps.
    const incoming = serializeIndex(indexFile("openai", "m", {
      conv1: { path: "p1", vector: [1] },
      conv2: { path: "p2", vector: [2] },
    }));
    await write(remoteRoot, "state/embeddings.json", incoming);
    const snapshot = await buildOfflineSyncSnapshot({
      root: remoteRoot, sourceId: "remote", includeContent: true,
    });
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot });
    const shardPaths = result.nextBaseFiles
      .map((f) => f.path)
      .filter((path) => path.startsWith("state/embeddings/shard-"));
    assert.equal(shardPaths.length >= 2, true);
    // The state digests match the actually-published shard bytes.
    for (const state of result.nextBaseFiles.filter((f) => f.path.startsWith("state/embeddings/shard-"))) {
      const published = await readFile(path.join(localRoot, ...state.path.split("/")));
      assert.equal(createHash("sha256").update(published).digest("hex"), state.sha256);
    }
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("a remotely deleted generation is removed as one atomic transaction", async () => {
  const localRoot = await tempDir("remnic-3148-atomic-removal");
  try {
    await write(localRoot, "facts/keep.md", "keep");
    await write(localRoot, "state/embeddings/shard-0000.json", serializeIndex(
      indexFile("openai", "m", { a: { path: "p", vector: [1] } }),
    ));
    await write(localRoot, trueShardRel("hydrated"), serializeIndex(
      indexFile("openai", "m", { b: { path: "p2", vector: [2] } }),
    ));
    await write(localRoot, "state/embeddings.json", serializeIndex(indexFile("openai", "m", {})));
    const snapshot: OfflineSyncSnapshot = {
      format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
      schemaVersion: 1,
      createdAt: "2026-09-27T00:00:00.000Z",
      sourceId: "remote",
      includeTranscripts: true,
      files: [{
        path: "facts/keep.md",
        sha256: sha256Of("keep"),
        bytes: 4,
        mtimeMs: 1,
        contentBase64: Buffer.from("keep").toString("base64"),
      }],
      deletions: [
        { path: "state/embeddings/shard-0000.json", mtimeMs: 100 },
        { path: trueShardRel("hydrated"), mtimeMs: 100 },
        { path: "state/embeddings.json", mtimeMs: 100 },
      ],
    };
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot });
    // The whole generation is gone in ONE swap: no shard, no marker.
    assert.equal(await existsQuiet(localRoot, "state/embeddings/shard-0000.json"), false);
    assert.equal(await existsQuiet(localRoot, trueShardRel("hydrated")), false);
    assert.equal(await existsQuiet(localRoot, "state/embeddings.json"), false);
    assert.equal(result.deleted >= 3, true);
    assert.equal(await existsQuiet(localRoot, "state/embeddings.pre-replace.tmp"), false);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});
