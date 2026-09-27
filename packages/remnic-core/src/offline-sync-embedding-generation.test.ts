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
import test from "node:test";

import {
  EmbeddingIndexCapacityError,
  type EmbeddingIndexEntry,
  type EmbeddingIndexFile,
  EmbeddingIndexFileStore,
  EmbeddingIndexStorageError,
  parseEmbeddingIndexDocument,
  serializeEmbeddingShard,
  shardEntriesForIndex,
} from "./embedding-index-storage.js";
import {
  applyEmbeddingGenerationTransaction,
  computeOmittedEmbeddingGenerationPaths,
  embeddingGenerationMembership,
} from "./offline-sync-embedding-generation.js";
import {
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  type OfflineSyncSnapshot,
  applyOfflineSyncSnapshot,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotFromBase,
  iterateOfflineSyncSnapshotFileRecords,
} from "./offline-sync.js";
import { MAGIC_BYTES, readMaybeEncryptedFile } from "./secure-store/secure-fs.js";
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
      "state/embeddings/shard-0007.json",
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
      "state/embeddings/shard-0000.json",
      serializeIndex(indexFile("openai", "m1", { old: { path: "p", vector: [0] } }))
    );
    await write(localRoot, "state/embeddings/shard-0050.json", "local only 0050");
    await write(
      remoteRoot,
      "state/embeddings/shard-0000.json",
      serializeIndex(indexFile("openai", "m2", { neu: { path: "p", vector: [1] } }))
    );
    await write(
      remoteRoot,
      "state/embeddings/shard-0001.json",
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
      deferredPaths: ["state/embeddings/shard-0001.json"],
    });
    assert.ok((await readUtf8(localRoot, "state/embeddings/shard-0000.json")).includes('"m1"'));
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0050.json"), "local only 0050");
    assert.equal(await existsQuiet(localRoot, "state/embeddings/shard-0001.json"), false);
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
    await write(localRoot, "state/embeddings/shard-0000.json", "local 0000");
    await write(localRoot, "state/embeddings/shard-0050.json", "local 0050");
    const incomingBuffers = new Map<string, Buffer>();
    const safeRoot: SafeArchiveRoot = await prepareSafeArchiveRoot(localRoot, "test", "root");
    incomingBuffers.set(
      "state/embeddings/shard-0000.json",
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
          incomingShardPaths: ["state/embeddings/shard-0000.json"],
          incomingMarker: null,
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
    assert.equal(await readUtf8(localRoot, "state/embeddings/shard-0000.json"), "local 0000");
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
      "state/embeddings/shard-0000.json",
      serializeIndex(indexFile("openai", "m2", { neu: { path: "p", vector: [1] } }))
    );
    await write(
      remoteRoot,
      "state/embeddings/shard-0063.json",
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
      await readUtf8(localRoot, "state/embeddings/shard-0000.json"),
      serializeIndex(indexFile("openai", "m2", { neu: { path: "p", vector: [1] } }))
    );
    assert.equal(
      await readUtf8(localRoot, "state/embeddings/shard-0063.json"),
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
      aadRelPath: finalRel,
    });
    // Encrypted at rest in the staging location.
    const raw = await readFile(path.join(memoryDir, ...stagingRel.split("/")));
    assert.equal(raw.subarray(0, MAGIC_BYTES.length).toString("ascii"), MAGIC_BYTES.toString("ascii"));
    // Read back through the staging hook with the final-path AAD.
    const staged = await storage.readOfflineSyncFile(path.join(memoryDir, ...stagingRel.split("/")), {
      aadRelPath: finalRel,
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
