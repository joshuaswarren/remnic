// Regression suite for issue #3150: offline-sync CHANGESET pushes must be
// embedding-generation atomic, mirroring the snapshot-side guarantees from
// PR #3148 (issue #3146):
//   1. sender changesets carry a complete post-change membership manifest
//      (`embeddingGenerations`) for every touched generation;
//   2. the receiver routes manifested generation changes through the shared
//      locked atomic transaction — changed members publish, unchanged members
//      carry over from local bytes (hash-verified against the manifest),
//      removed members sweep — never a per-file mixed generation;
//   3. delete-only changes shrink through the manifest (survivors carried),
//      while a manifest-less whole-generation tombstone removes atomically;
//   4. legacy changesets without a manifest DEFER shard upserts and surface
//      CONFLICTS (never silent skips) so the push-side base cannot advance
//      past an unapplied generation;
//   5. divergence under the lock (daemon rewrote a member, remote-only
//      member) defers the WHOLE generation as conflicts, disk untouched;
//   6. secure staging hooks are required (fail closed) exactly like the
//      snapshot path — no plaintext-downgrade of staged generations;
//   7. partially filtered generations are omitted whole (filter-to-omit).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type EmbeddingIndexEntry,
  type EmbeddingIndexFile,
  EmbeddingIndexStorageError,
  parseEmbeddingIndexDocument,
} from "./embedding-index-storage.js";
import {
  applyOfflineSyncChangeset,
  buildOfflineSyncChangesetFromSnapshot,
  normalizeOfflineSyncChangeset,
  type OfflineSyncChangeset,
  type OfflineSyncChangesetGeneration,
  type OfflineSyncChange,
  type OfflineSyncFileState,
} from "./offline-sync.js";
import { buildChangesetGenerationManifest } from "./offline-sync-changeset-generations.js";

const SHARD_COUNT = 64; // embedding-index-storage internal; ids below pre-hashed

/** Ids pre-hashed with shardIndexOf(id, 64): m8→shard 0, m10→1, m86→2, m45→3. */
const SHARD_IDS = ["m8", "m10", "m86", "m45"] as const;

function shardRel(index: number): string {
  return `state/embeddings/shard-${String(index).padStart(4, "0")}.json`;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function shardDoc(entries: Record<string, EmbeddingIndexEntry>): Buffer {
  const file: EmbeddingIndexFile = {
    version: 1,
    provider: "openai",
    model: "text-embedding-3-small",
    entries,
  };
  return Buffer.from(JSON.stringify(file), "utf-8");
}

async function tempDir(name: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function write(root: string, relPath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.join(root, path.dirname(relPath)), { recursive: true });
  await writeFile(path.join(root, relPath), content);
}

async function readAll(root: string, relPath: string): Promise<Buffer> {
  return readFile(path.join(root, relPath));
}

async function shardNames(root: string, shardDirRel = "state/embeddings"): Promise<string[]> {
  try {
    const names = await readdir(path.join(root, ...shardDirRel.split("/")));
    return names.filter((n) => /^shard-\d{4}\.json$/.test(n)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function diskGeneration(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await shardNames(root)) {
    const rel = `state/embeddings/${name}`;
    out.set(rel, sha256(await readAll(root, rel)));
  }
  return out;
}

function upsertChange(
  relPath: string,
  content: Buffer,
  mtimeMs: number,
  baseSha256?: string,
): OfflineSyncChange {
  return {
    type: "upsert",
    path: relPath,
    ...(baseSha256 ? { baseSha256 } : {}),
    file: {
      path: relPath,
      sha256: sha256(content),
      bytes: content.length,
      mtimeMs,
      contentBase64: content.toString("base64"),
    },
  };
}

function deleteChange(relPath: string, baseSha256: string, mtimeMs?: number): OfflineSyncChange {
  return { type: "delete", path: relPath, baseSha256, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
}

function member(relPath: string, content: Buffer): { path: string; sha256: string; bytes: number } {
  return { path: relPath, sha256: sha256(content), bytes: content.length };
}

function baseChangeset(changes: OfflineSyncChange[], embeddingGenerations?: OfflineSyncChangesetGeneration[]): OfflineSyncChangeset {
  return {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: "2026-09-27T00:00:00.000Z",
    sourceId: "test-sender",
    includeTranscripts: true,
    changes,
    ...(embeddingGenerations === undefined ? {} : { embeddingGenerations }),
  };
}

/** Secure-IO spies: real filesystem effects + call recording. */
function makeIo(root: string) {
  const calls = { stagingWrites: [] as string[], stagingReads: [] as string[], plainWrites: [] as string[], deletes: [] as string[], deleteMtimes: [] as (number | undefined)[] };
  return {
    calls,
    io: {
      readFile: async (target: { path: string }) => readAll(root, target.path),
      readFileDigest: async (target: { path: string }) => {
        const content = await readAll(root, target.path);
        return { sha256: sha256(content), bytes: content.length };
      },
      writeFile: async (target: { path: string; content: Buffer }) => {
        calls.plainWrites.push(target.path);
        await write(root, target.path, target.content);
      },
      writeStagingFile: async (target: { path: string; content: Buffer }) => {
        calls.stagingWrites.push(target.path);
        await write(root, target.path, target.content);
      },
      readStagingFile: async (target: { path: string }) => {
        calls.stagingReads.push(target.path);
        return readAll(root, target.path);
      },
      deleteFile: async (target: { path: string; mtimeMs?: number }) => {
        calls.deletes.push(target.path);
        calls.deleteMtimes.push(target.mtimeMs);
        await rm(path.join(root, target.path), { force: true });
      },
    },
  };
}

/** Local generation on disk: shards 0..count-1 with one entry each. */
async function seedLocalGeneration(root: string, count: number): Promise<Map<string, Buffer>> {
  const local = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const content = shardDoc({ [SHARD_IDS[i]]: { path: `memories/${SHARD_IDS[i]}.md`, vector: [i, 1] } });
    local.set(shardRel(i), content);
    await write(root, shardRel(i), content);
  }
  return local;
}

// ---------------------------------------------------------------------------
// Receiver — manifested changesets apply through the atomic transaction
// ---------------------------------------------------------------------------

test("manifested changeset replaces changed shards and carries unchanged members atomically", async () => {
  const root = await tempDir("remnic-3150-apply");
  try {
    const local = await seedLocalGeneration(root, 3);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const new1 = shardDoc({ [SHARD_IDS[1]]: { path: `memories/${SHARD_IDS[1]}.md`, vector: [8, 8] } });
    const changeset = baseChangeset(
      [
        upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!)),
        upsertChange(shardRel(1), new1, 100, sha256(local.get(shardRel(1))!)),
      ],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), new0),
        member(shardRel(1), new1),
        member(shardRel(2), local.get(shardRel(2))!),
      ] }],
    );
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0);
    assert.ok(result.appliedUpserts >= 2, `changed shards must apply: ${JSON.stringify(result)}`);
    // Changed members published; unchanged member carried over byte-for-byte.
    assert.deepEqual(await readAll(root, shardRel(0)), new0);
    assert.deepEqual(await readAll(root, shardRel(1)), new1);
    assert.deepEqual(await readAll(root, shardRel(2)), local.get(shardRel(2))!);
    // Atomic route: staged ciphertext for EVERY member, no per-file writes.
    assert.ok(calls.stagingWrites.length >= 3, `all members must stage: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls.plainWrites, [], "generation members must never take the per-file write path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete-only manifested changeset shrinks the generation instead of removing the dir", async () => {
  const root = await tempDir("remnic-3150-shrink");
  try {
    const local = await seedLocalGeneration(root, 3);
    const changeset = baseChangeset(
      [deleteChange(shardRel(2), sha256(local.get(shardRel(2))!))],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(await shardNames(root), [shardRel(0).split("/")[2], shardRel(1).split("/")[2]]);
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0))!);
    assert.deepEqual(await readAll(root, shardRel(1)), local.get(shardRel(1))!);
    assert.ok(result.appliedDeletes >= 1, `removed shard must count: ${JSON.stringify(result)}`);
    assert.ok(calls.stagingWrites.length >= 2, "survivors must stage through the atomic swap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest-less whole-generation deletions remove atomically with tombstones", async () => {
  const root = await tempDir("remnic-3150-removal");
  try {
    await seedLocalGeneration(root, 2);
    const before = await diskGeneration(root);
    const changeset = baseChangeset([
      deleteChange(shardRel(0), before.get(shardRel(0))!),
      deleteChange(shardRel(1), before.get(shardRel(1))!),
    ]);
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(await shardNames(root), [], "whole generation must be removed");
    assert.deepEqual(calls.deletes.sort(), [shardRel(0), shardRel(1)].sort(), "tombstones recorded per member");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest-less partial generation deletions defer as conflicts and preserve the generation", async () => {
  const root = await tempDir("remnic-3150-partial-tombstone");
  try {
    const local = await seedLocalGeneration(root, 3);
    const changeset = baseChangeset([
      deleteChange(shardRel(1), sha256(local.get(shardRel(1))!)),
    ]);
    const { io } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    // Incomplete deletion evidence cannot break the generation apart: the
    // complete published generation survives and the deletes conflict, so
    // the push side cannot advance its base past them.
    assert.deepEqual(await shardNames(root), ["shard-0000.json", "shard-0001.json", "shard-0002.json"]);
    const expected = new Map<string, string>();
    for (const i of [0, 1, 2]) expected.set(shardRel(i), sha256(local.get(shardRel(i))!));
    assert.deepEqual(await diskGeneration(root), expected);
    assert.ok(
      result.conflicts.some((c) => c.path === shardRel(1) && c.reason === "embedding_generation_manifest_required"),
      `partial deletion must conflict: ${JSON.stringify(result.conflicts)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Receiver — deferrals surface as conflicts, never silent skips
// ---------------------------------------------------------------------------

test("legacy changeset without a manifest defers shard upserts as conflicts", async () => {
  const root = await tempDir("remnic-3150-legacy");
  try {
    const local = await seedLocalGeneration(root, 2);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [7, 7] } });
    const changeset = baseChangeset([
      upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!)),
    ]);
    const { io } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.ok(
      result.conflicts.some((c) => c.path === shardRel(0) && c.reason === "embedding_generation_manifest_required"),
      `deferred member must conflict: ${JSON.stringify(result.conflicts)}`,
    );
    // Nothing written: the local generation is byte-identical to before.
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0))!);
    assert.deepEqual(await readAll(root, shardRel(1)), local.get(shardRel(1))!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy marker-only upsert still replaces cross-layout through the transaction", async () => {
  const root = await tempDir("remnic-3150-legacy-marker");
  try {
    await seedLocalGeneration(root, 2);
    const marker = Buffer.from(JSON.stringify({
      version: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      entries: { [SHARD_IDS[2]]: { path: `memories/${SHARD_IDS[2]}.md`, vector: [1, 2] } },
    } satisfies EmbeddingIndexFile), "utf-8");
    const changeset = baseChangeset([upsertChange("state/embeddings.json", marker, 100)]);
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0, `marker migration must apply: ${JSON.stringify(result.conflicts)}`);
    const names = await shardNames(root);
    assert.ok(names.length > 0, "marker must convert to the sharded layout");
    const converted = names.find((name) => name === "shard-0002.json");
    assert.ok(converted, `marker entry must land in its shard: ${JSON.stringify(names)}`);
    const read = parseEmbeddingIndexDocument((await readAll(root, `state/embeddings/${converted}`)).toString("utf-8"));
    assert.equal(read.outcome, "ok");
    if (read.outcome === "ok") assert.ok(read.file.entries[SHARD_IDS[2]]);
    assert.ok(calls.stagingWrites.length > 0, "marker migration must stage through the swap");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("under-lock divergence defers the whole generation as conflicts, disk untouched", async () => {
  const root = await tempDir("remnic-3150-diverged");
  try {
    const local = await seedLocalGeneration(root, 3);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    // Daemon rewrote shard 1 AFTER the shared base was captured.
    const drifted = shardDoc({ [SHARD_IDS[1]]: { path: `memories/${SHARD_IDS[1]}.md`, vector: [5, 5] } });
    await write(root, shardRel(1), drifted);
    const changeset = baseChangeset(
      [upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!))],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), new0),
        member(shardRel(1), local.get(shardRel(1))!),
        member(shardRel(2), local.get(shardRel(2))!),
      ] }],
    );
    const { io } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.ok(
      result.conflicts.some((c) => c.path === shardRel(0) && c.reason === "embedding_generation_diverged"),
      `diverged generation must conflict: ${JSON.stringify(result.conflicts)}`,
    );
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0))!);
    assert.deepEqual(await readAll(root, shardRel(1)), drifted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a remote-only local member (not in base or manifest) conflicts the whole generation", async () => {
  const root = await tempDir("remnic-3150-remote-only");
  try {
    const local = await seedLocalGeneration(root, 2);
    const extra = shardDoc({ [SHARD_IDS[3]]: { path: `memories/${SHARD_IDS[3]}.md`, vector: [3, 3] } });
    await write(root, shardRel(3), extra);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const changeset = baseChangeset(
      [upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!))],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), new0),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const { io } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.ok(
      result.conflicts.some((c) => c.reason === "embedding_generation_diverged"),
      `unexpected local member must conflict the generation: ${JSON.stringify(result.conflicts)}`,
    );
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0))!);
    assert.deepEqual(await readAll(root, shardRel(3)), extra);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Receiver — fail-closed staging and crash safety
// ---------------------------------------------------------------------------

test("custom IO without staging hooks refuses generation changesets before any write", async () => {
  const root = await tempDir("remnic-3150-no-staging");
  try {
    const local = await seedLocalGeneration(root, 1);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const changeset = baseChangeset(
      [upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!))],
      [{ shardDir: "state/embeddings", members: [member(shardRel(0), new0)] }],
    );
    let plainWrite = false;
    await assert.rejects(
      applyOfflineSyncChangeset({
        root,
        changeset,
        returnCurrentFiles: false,
        readFile: async (target) => readAll(root, target.path),
        writeFile: async (target) => {
          plainWrite = true;
          await write(root, target.path, target.content);
        },
      }),
      (error: unknown) => error instanceof EmbeddingIndexStorageError,
    );
    assert.equal(plainWrite, false, "refusal must happen before any publication");
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0))!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed mid-generation stage leaves the local generation byte-identical", async () => {
  const root = await tempDir("remnic-3150-stage-crash");
  try {
    const local = await seedLocalGeneration(root, 2);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const changeset = baseChangeset(
      [upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!))],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), new0),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    let staged = 0;
    await assert.rejects(
      applyOfflineSyncChangeset({
        root,
        changeset,
        returnCurrentFiles: false,
        readFile: async (target) => readAll(root, target.path),
        // Fail on the second staged member: a crash mid-generation stage.
        writeStagingFile: async (target) => {
          staged += 1;
          if (staged > 1) throw new Error("simulated stage failure");
          await write(root, target.path, target.content);
        },
        readStagingFile: async (target) => readAll(root, target.path),
      }),
      /simulated stage failure/,
    );
    assert.ok(staged >= 1, "at least one member must have staged before the failure");
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0))!);
    assert.deepEqual(await readAll(root, shardRel(1)), local.get(shardRel(1))!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent changeset applies serialize into one complete generation", async () => {
  const root = await tempDir("remnic-3150-concurrent");
  try {
    const local = await seedLocalGeneration(root, 2);
    const build = (vector: number) => {
      const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [vector, vector] } });
      return baseChangeset(
        [upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!))],
        [{ shardDir: "state/embeddings", members: [
          member(shardRel(0), new0),
          member(shardRel(1), local.get(shardRel(1))!),
        ] }],
      );
    };
    const { io } = makeIo(root);
    await Promise.all([
      applyOfflineSyncChangeset({ root, changeset: build(7), returnCurrentFiles: false, ...io }),
      applyOfflineSyncChangeset({ root, changeset: build(9), returnCurrentFiles: false, ...io }),
    ]);
    // Whichever transaction wins the lock, the disk must hold ONE complete
    // generation — never a mix of both.
    const census = await diskGeneration(root);
    const winner7 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [7, 7] } });
    const winner9 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const matches7 = census.get(shardRel(0)) === sha256(winner7);
    const matches9 = census.get(shardRel(0)) === sha256(winner9);
    assert.ok(
      (matches7 || matches9) && census.get(shardRel(1)) === sha256(local.get(shardRel(1))!),
      "the published generation must be exactly one of the concurrent incoming sets",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-applying an already-applied manifested changeset stays idempotent", async () => {
  const root = await tempDir("remnic-3150-idempotent");
  try {
    const local = await seedLocalGeneration(root, 1);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const build = () => baseChangeset(
      [upsertChange(shardRel(0), new0, 100, sha256(local.get(shardRel(0))!))],
      [{ shardDir: "state/embeddings", members: [member(shardRel(0), new0)] }],
    );
    const { io } = makeIo(root);
    await applyOfflineSyncChangeset({ root, changeset: build(), returnCurrentFiles: false, ...io });
    const retry = await applyOfflineSyncChangeset({ root, changeset: build(), returnCurrentFiles: false, ...io });
    assert.equal(retry.conflicts.length, 0, `retry must not conflict: ${JSON.stringify(retry.conflicts)}`);
    assert.deepEqual(await readAll(root, shardRel(0)), new0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unbased manifested creation defers instead of overwriting an independent local generation", async () => {
  const root = await tempDir("remnic-3150-unbased-create");
  try {
    const local = await seedLocalGeneration(root, 2);
    // Fresh sender creation: base-less upserts, no shared base evidence.
    const incoming0 = shardDoc({ [SHARD_IDS[2]]: { path: `memories/${SHARD_IDS[2]}.md`, vector: [7, 7] } });
    const incoming1 = shardDoc({ [SHARD_IDS[3]]: { path: `memories/${SHARD_IDS[3]}.md`, vector: [6, 6] } });
    const changeset = baseChangeset(
      [upsertChange(shardRel(0), incoming0, 100), upsertChange(shardRel(1), incoming1, 100)],
      [{ shardDir: "state/embeddings", members: [member(shardRel(0), incoming0), member(shardRel(1), incoming1)] }],
    );
    const { io } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.ok(
      result.conflicts.some((c) => c.reason === "embedding_generation_diverged"),
      `unbased creation over an existing generation must defer: ${JSON.stringify(result.conflicts)}`,
    );
    assert.deepEqual(await readAll(root, shardRel(0)), local.get(shardRel(0)), "local generation must be untouched");
    assert.deepEqual(await readAll(root, shardRel(1)), local.get(shardRel(1)), "local generation must be untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unbased manifested creation applies to an empty receiver and to an exactly matching one", async () => {
  const fresh = await tempDir("remnic-3150-unbased-fresh");
  const matching = await tempDir("remnic-3150-unbased-match");
  try {
    const incoming0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [1, 1] } });
    const incoming1 = shardDoc({ [SHARD_IDS[1]]: { path: `memories/${SHARD_IDS[1]}.md`, vector: [2, 2] } });
    const build = () => baseChangeset(
      [upsertChange(shardRel(0), incoming0, 100), upsertChange(shardRel(1), incoming1, 100)],
      [{ shardDir: "state/embeddings", members: [member(shardRel(0), incoming0), member(shardRel(1), incoming1)] }],
    );
    const freshIo = makeIo(fresh);
    const freshResult = await applyOfflineSyncChangeset({ root: fresh, changeset: build(), returnCurrentFiles: false, ...freshIo.io });
    assert.equal(freshResult.conflicts.length, 0, `fresh create must apply: ${JSON.stringify(freshResult.conflicts)}`);
    assert.deepEqual((await shardNames(fresh)).length, 2);

    // Identical content already on disk: re-applying the same unbased create is idempotent, not divergent.
    await write(matching, shardRel(0), incoming0);
    await write(matching, shardRel(1), incoming1);
    const matchingIo = makeIo(matching);
    const matchResult = await applyOfflineSyncChangeset({ root: matching, changeset: build(), returnCurrentFiles: false, ...matchingIo.io });
    assert.equal(matchResult.conflicts.length, 0, `identical unbased create must re-apply: ${JSON.stringify(matchResult.conflicts)}`);
    assert.deepEqual(await readAll(matching, shardRel(0)), incoming0);
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(matching, { recursive: true, force: true });
  }
});

test("retrying a manifested shrink after response loss stays idempotent", async () => {
  const root = await tempDir("remnic-3150-shrink-retry");
  try {
    const local = await seedLocalGeneration(root, 3);
    const build = () => baseChangeset(
      [deleteChange(shardRel(2), sha256(local.get(shardRel(2))!))],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const { io } = makeIo(root);
    await applyOfflineSyncChangeset({ root, changeset: build(), returnCurrentFiles: false, ...io });
    const retry = await applyOfflineSyncChangeset({ root, changeset: build(), returnCurrentFiles: false, ...io });
    assert.equal(retry.conflicts.length, 0, `shrink retry must not diverge: ${JSON.stringify(retry.conflicts)}`);
    assert.deepEqual(await shardNames(root), ["shard-0000.json", "shard-0001.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifested shrink records deletion revisions for swept members", async () => {
  const root = await tempDir("remnic-3150-shrink-tombstone");
  try {
    const local = await seedLocalGeneration(root, 3);
    const DELETION_MTIME = 555555;
    const changeset = baseChangeset(
      [deleteChange(shardRel(2), sha256(local.get(shardRel(2))!), DELETION_MTIME)],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0, `shrink must apply: ${JSON.stringify(result.conflicts)}`);
    assert.deepEqual(await shardNames(root), ["shard-0000.json", "shard-0001.json"]);
    assert.deepEqual(calls.deletes, [shardRel(2)], "swept shard must be tombstoned through the delete hook");
    assert.deepEqual(calls.deleteMtimes, [DELETION_MTIME], "the supplied deletion timestamp must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing delete hook fails the manifested shrink after recording every tombstone", async () => {
  const root = await tempDir("remnic-3150-shrink-tombstone-fail");
  try {
    const local = await seedLocalGeneration(root, 3);
    const changeset = baseChangeset(
      [deleteChange(shardRel(2), sha256(local.get(shardRel(2))!), 555555)],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const io = makeIo(root);
    let hookCalls = 0;
    await assert.rejects(
      applyOfflineSyncChangeset({
        root,
        changeset,
        returnCurrentFiles: false,
        ...io.io,
        deleteFile: async () => {
          hookCalls += 1;
          throw new Error("hook down");
        },
      }),
      /hook down/,
    );
    assert.equal(hookCalls, 1, "every swept member must get a tombstone attempt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a daemon rewrite of a to-be-deleted shard still defers the shrink", async () => {
  const root = await tempDir("remnic-3150-shrink-drift");
  try {
    const local = await seedLocalGeneration(root, 3);
    const drifted = shardDoc({ [SHARD_IDS[2]]: { path: `memories/${SHARD_IDS[2]}.md`, vector: [4, 4] } });
    await write(root, shardRel(2), drifted);
    const changeset = baseChangeset(
      [deleteChange(shardRel(2), sha256(local.get(shardRel(2))!), 555555)],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const { io } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.ok(
      result.conflicts.some((c) => c.reason === "embedding_generation_diverged"),
      `a drifted to-be-deleted shard must defer, not be swept: ${JSON.stringify(result.conflicts)}`,
    );
    assert.deepEqual(await readAll(root, shardRel(2)), drifted, "the daemon rewrite must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrying a manifested addition after response loss stays idempotent", async () => {
  const root = await tempDir("remnic-3150-add-retry");
  try {
    const local = await seedLocalGeneration(root, 2);
    const added = shardDoc({ [SHARD_IDS[2]]: { path: `memories/${SHARD_IDS[2]}.md`, vector: [7, 7] } });
    const build = () => baseChangeset(
      [upsertChange(shardRel(2), added, 100)],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
        member(shardRel(2), added),
      ] }],
    );
    const { io } = makeIo(root);
    await applyOfflineSyncChangeset({ root, changeset: build(), returnCurrentFiles: false, ...io });
    const retry = await applyOfflineSyncChangeset({ root, changeset: build(), returnCurrentFiles: false, ...io });
    assert.equal(retry.conflicts.length, 0, `addition retry must not diverge: ${JSON.stringify(retry.conflicts)}`);
    assert.deepEqual(await readAll(root, shardRel(2)), added);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifested shrink records tombstones even when deletes omit mtimeMs", async () => {
  const root = await tempDir("remnic-3150-shrink-nomtime");
  try {
    const local = await seedLocalGeneration(root, 3);
    const changeset = baseChangeset(
      [deleteChange(shardRel(2), sha256(local.get(shardRel(2))!))],
      [{ shardDir: "state/embeddings", members: [
        member(shardRel(0), local.get(shardRel(0))!),
        member(shardRel(1), local.get(shardRel(1))!),
      ] }],
    );
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0, `shrink must apply: ${JSON.stringify(result.conflicts)}`);
    assert.deepEqual(calls.deletes, [shardRel(2)], "swept shard must be tombstoned even without a supplied mtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marker-only conversion consumes the marker change so the per-file loop never rewrites it", async () => {
  const root = await tempDir("remnic-3150-marker-handled");
  try {
    await seedLocalGeneration(root, 2);
    const marker = Buffer.from(JSON.stringify({
      version: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      entries: { [SHARD_IDS[2]]: { path: `memories/${SHARD_IDS[2]}.md`, vector: [1, 2] } },
    } satisfies EmbeddingIndexFile), "utf-8");
    const changeset = baseChangeset([upsertChange("state/embeddings.json", marker, 100)]);
    const { io, calls } = makeIo(root);
    const result = await applyOfflineSyncChangeset({ root, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0, `marker conversion must apply: ${JSON.stringify(result.conflicts)}`);
    const names = await shardNames(root);
    assert.ok(names.includes("shard-0002.json"), `marker entry must convert into its shard: ${JSON.stringify(names)}`);
    await assert.rejects(
      readAll(root, "state/embeddings.json"),
      /ENOENT/,
      "the marker change is consumed by the conversion — the per-file loop must not rewrite the legacy marker",
    );
    assert.deepEqual(calls.plainWrites, [], "the marker must never take the per-file write path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sender — complete manifests, whole-generation omission, validation
// ---------------------------------------------------------------------------

test("manifest builder emits complete post-change membership and omits filtered generations", async () => {
  const root = await tempDir("remnic-3150-manifest");
  try {
    const base = await seedLocalGeneration(root, 3);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    const currentFiles: OfflineSyncFileState[] = [
      { path: shardRel(0), sha256: sha256(new0), bytes: new0.length, mtimeMs: 100 },
      { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
      { path: shardRel(2), sha256: sha256(base.get(shardRel(2))!), bytes: base.get(shardRel(2))!.length, mtimeMs: 1 },
    ];
    const baseFiles: OfflineSyncFileState[] = (await Promise.all(
      [0, 1, 2].map(async (i) => ({
        path: shardRel(i),
        sha256: sha256(base.get(shardRel(i))!),
        bytes: base.get(shardRel(i))!.length,
        mtimeMs: 1,
      })),
    ));
    const changes = [
      upsertChange(shardRel(0), new0, 100, sha256(base.get(shardRel(0))!)),
      upsertChange("notes/a.md", Buffer.from("note"), 1),
    ];
    const generations = buildChangesetGenerationManifest({
      changes,
      currentFiles,
      baseFiles,
      isExcluded: () => false,
    });
    assert.deepEqual(generations, [{
      shardDir: "state/embeddings",
      members: [
        member(shardRel(0), new0),
        member(shardRel(1), base.get(shardRel(1))!),
        member(shardRel(2), base.get(shardRel(2))!),
      ],
    }]);
    // Filter-to-omit: one excluded member omits the whole generation.
    const omitted = buildChangesetGenerationManifest({
      changes,
      currentFiles,
      baseFiles,
      isExcluded: (relPath) => relPath === shardRel(2),
    });
    assert.deepEqual(omitted, [], "a partially filtered generation must not travel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI changeset builder still push-filters runtime state (#1786)", async () => {
  const root = await tempDir("remnic-3150-builder-filter");
  try {
    const base = await seedLocalGeneration(root, 2);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    await write(root, shardRel(0), new0);
    const changeset = await buildOfflineSyncChangesetFromSnapshot({
      root,
      sourceId: "sender",
      currentFiles: [
        { path: shardRel(0), sha256: sha256(new0), bytes: new0.length, mtimeMs: 100 },
        { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
      ],
      baseFiles: [
        { path: shardRel(0), sha256: sha256(base.get(shardRel(0))!), bytes: base.get(shardRel(0))!.length, mtimeMs: 1 },
        { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
      ],
      readFile: async (target) => readAll(root, target.path),
    });
    // Node pushes are pull-restored for runtime state: shards never ride the
    // inline changeset from this builder, so it carries no generation
    // protocol fields at all (no unnecessary sender logic).
    assert.deepEqual(changeset.changes, []);
    assert.equal(changeset.embeddingGenerations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI changeset builder never announces a partially filtered generation", async () => {
  const root = await tempDir("remnic-3150-filtered-builder");
  try {
    const base = await seedLocalGeneration(root, 3);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    await write(root, shardRel(0), new0);
    // Guard-rail for the builder itself: even if the #1786 runtime filter
    // ever lifts, the builder must not emit changes for a generation whose
    // membership the push filters would split (filter-to-omit, #3148).
    const generations = buildChangesetGenerationManifest({
      changes: [upsertChange(shardRel(0), new0, 100, sha256(base.get(shardRel(0))!))],
      currentFiles: [
        { path: shardRel(0), sha256: sha256(new0), bytes: new0.length, mtimeMs: 100 },
        { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
        { path: shardRel(2), sha256: sha256(base.get(shardRel(2))!), bytes: base.get(shardRel(2))!.length, mtimeMs: 1 },
      ],
      baseFiles: [
        { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
      ],
      isExcluded: (relPath) => relPath === shardRel(2),
    });
    assert.deepEqual(generations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partially filtered generation is omitted whole from the changeset", async () => {
  const root = await tempDir("remnic-3150-filtered");
  try {
    const base = await seedLocalGeneration(root, 3);
    const new0 = shardDoc({ [SHARD_IDS[0]]: { path: `memories/${SHARD_IDS[0]}.md`, vector: [9, 9] } });
    await write(root, shardRel(0), new0);
    const changeset = await buildOfflineSyncChangesetFromSnapshot({
      root,
      sourceId: "sender",
      currentFiles: [
        { path: shardRel(0), sha256: sha256(new0), bytes: new0.length, mtimeMs: 100 },
        { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
        { path: shardRel(2), sha256: sha256(base.get(shardRel(2))!), bytes: base.get(shardRel(2))!.length, mtimeMs: 1 },
      ],
      baseFiles: [
        { path: shardRel(0), sha256: sha256(base.get(shardRel(0))!), bytes: base.get(shardRel(0))!.length, mtimeMs: 1 },
        { path: shardRel(1), sha256: sha256(base.get(shardRel(1))!), bytes: base.get(shardRel(1))!.length, mtimeMs: 1 },
        { path: shardRel(2), sha256: sha256(base.get(shardRel(2))!), bytes: base.get(shardRel(2))!.length, mtimeMs: 1 },
      ],
      userExcludeRegexps: [/shard-0002\.json$/],
      readFile: async (target) => readAll(root, target.path),
    });
    assert.deepEqual(
      changeset.changes.filter((change) => change.path.startsWith("state/embeddings")),
      [],
      "no member of a partially filtered generation may travel",
    );
    assert.equal(changeset.embeddingGenerations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalize rejects incoherent manifests before any apply", async () => {
  const local = shardDoc({ [SHARD_IDS[0]]: { path: "memories/m8.md", vector: [1, 1] } });
  const changed = shardDoc({ [SHARD_IDS[0]]: { path: "memories/m8.md", vector: [2, 2] } });
  const upsert = upsertChange(shardRel(0), changed, 1, sha256(local));
  const generation = (members: ReturnType<typeof member>[]) =>
    baseChangeset([upsert], [{ shardDir: "state/embeddings", members }]);

  // Duplicate member paths.
  assert.throws(
    () => normalizeOfflineSyncChangeset(generation([member(shardRel(0), changed), member(shardRel(0), changed)])),
    /duplicate/,
  );
  // Noncanonical dir.
  assert.throws(
    () => normalizeOfflineSyncChangeset(baseChangeset([upsert], [{ shardDir: "state/other", members: [member(shardRel(0), changed)] }])),
    /canonical|embedding/,
  );
  // Member outside its dir.
  assert.throws(
    () => normalizeOfflineSyncChangeset(generation([member("state/other/shard-0000.json", changed)])),
    /member/,
  );
  // Upserted shard missing from the manifest (protocol violation for manifest-bearing senders).
  assert.throws(
    () => normalizeOfflineSyncChangeset(generation([member(shardRel(1), changed)])),
    /manifest/,
  );
  // Legacy changesets (field absent) keep normalizing.
  const legacy = baseChangeset([upsert]) as OfflineSyncChangeset & { embeddingGenerations?: unknown };
  assert.equal(legacy.embeddingGenerations, undefined);
  assert.equal(normalizeOfflineSyncChangeset(baseChangeset([upsert])).changes.length, 1);
});

// ---------------------------------------------------------------------------
// Integration — sender changeset reproduces the receiver's generation exactly
// ---------------------------------------------------------------------------

test("end-to-end: receiver census equals sender census after a manifested changeset", async () => {
  const senderRoot = await tempDir("remnic-3150-e2e-sender");
  const receiverRoot = await tempDir("remnic-3150-e2e-receiver");
  try {
    const base = await seedLocalGeneration(senderRoot, 4);
    await seedLocalGeneration(receiverRoot, 4);
    const new1 = shardDoc({ [SHARD_IDS[1]]: { path: `memories/${SHARD_IDS[1]}.md`, vector: [8, 8] } });
    await write(senderRoot, shardRel(1), new1);
    await rm(path.join(senderRoot, shardRel(3)), { force: true }); // shrink 4 → 3

    const currentFiles: OfflineSyncFileState[] = [
      { path: shardRel(0), sha256: sha256(base.get(shardRel(0))!), bytes: base.get(shardRel(0))!.length, mtimeMs: 1 },
      { path: shardRel(1), sha256: sha256(new1), bytes: new1.length, mtimeMs: 100 },
      { path: shardRel(2), sha256: sha256(base.get(shardRel(2))!), bytes: base.get(shardRel(2))!.length, mtimeMs: 1 },
    ];
    const baseFiles: OfflineSyncFileState[] = [0, 1, 2, 3].map((i) => ({
      path: shardRel(i),
      sha256: sha256(base.get(shardRel(i))!),
      bytes: base.get(shardRel(i))!.length,
      mtimeMs: 1,
    }));
    const changes = [
      upsertChange(shardRel(1), new1, 100, sha256(base.get(shardRel(1))!)),
      deleteChange(shardRel(3), sha256(base.get(shardRel(3))!)),
    ];
    const changeset = baseChangeset(changes, buildChangesetGenerationManifest({
      changes,
      currentFiles,
      baseFiles,
      isExcluded: () => false,
    }));
    const { io } = makeIo(receiverRoot);
    const result = await applyOfflineSyncChangeset({ root: receiverRoot, changeset, returnCurrentFiles: false, ...io });
    assert.equal(result.conflicts.length, 0, `no conflicts expected: ${JSON.stringify(result.conflicts)}`);
    assert.deepEqual(await diskGeneration(receiverRoot), await diskGeneration(senderRoot));
  } finally {
    await rm(senderRoot, { recursive: true, force: true });
    await rm(receiverRoot, { recursive: true, force: true });
  }
});
