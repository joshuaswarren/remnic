import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyOfflineSyncFileContentChunk,
  applyOfflineSyncChangeset,
  applyOfflineSyncSnapshot,
  buildOfflineSyncChangeset,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotForPaths,
  readOfflineSyncFileContentChunk,
  summarizeOfflineSyncPendingChanges,
} from "./offline-sync.js";
import { isEncryptedFile } from "./secure-store/secure-fs.js";
import { StorageManager } from "./storage.js";

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

test("offline snapshot captures source-of-truth files and excludes private/internal paths", async () => {
  const root = await tempDir("remnic-offline-snapshot");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "facts/fact-hashes.txt", "user-authored memory file");
    await write(root, "transcripts/session.jsonl", "turn");
    await write(root, "assets/blob.bin", Buffer.from([0, 1, 2, 255]));
    await write(root, ".secure-store/header.json", "secret");
    await write(root, ".offline-sync/state/local.json", "state");
    await write(root, "state/fact-hashes.txt", "derived");
    await write(root, "state/fact-hashes.ready", "v1");
    await write(root, "state/last_graph_recall.json", "{}");
    await write(root, "state/last_intent.json", "{}");
    await write(root, "state/last_qmd_recall.json", "{}");
    await write(root, "state/last_recall.json", "{}");
    await write(root, "state/lcm.sqlite", "live db");
    await write(root, "state/lcm.sqlite-shm", "live shm");
    await write(root, "state/lcm.sqlite-wal", "live wal");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      [
        "assets/blob.bin",
        "facts/a.md",
        "facts/fact-hashes.txt",
        "state/fact-hashes.ready",
        "state/fact-hashes.txt",
        "state/last_graph_recall.json",
        "state/last_intent.json",
        "state/last_qmd_recall.json",
        "state/last_recall.json",
        "state/lcm.sqlite",
        "state/lcm.sqlite-shm",
        "state/lcm.sqlite-wal",
        "transcripts/session.jsonl",
      ],
    );
    const binary = snapshot.files.find((file) => file.path === "assets/blob.bin");
    assert.equal(Buffer.from(binary?.contentBase64 ?? "", "base64")[3], 255);

    const withoutTranscripts = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
      includeTranscripts: false,
    });
    assert.deepEqual(
      withoutTranscripts.files.map((file) => file.path),
      [
        "assets/blob.bin",
        "facts/a.md",
        "facts/fact-hashes.txt",
        "state/fact-hashes.ready",
        "state/fact-hashes.txt",
        "state/last_graph_recall.json",
        "state/last_intent.json",
        "state/last_qmd_recall.json",
        "state/last_recall.json",
        "state/lcm.sqlite",
        "state/lcm.sqlite-shm",
        "state/lcm.sqlite-wal",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync includes retrieval debug snapshots for full-fidelity offline recall", async () => {
  const root = await tempDir("remnic-offline-debug-snapshots");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "state/last_graph_recall.json", "graph");
    await write(root, "state/last_intent.json", "intent");
    await write(root, "state/last_qmd_recall.json", "qmd");
    await write(root, "state/last_recall.json", "recall");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    assert.deepEqual(snapshot.files.map((file) => file.path), [
      "facts/a.md",
      "state/last_graph_recall.json",
      "state/last_intent.json",
      "state/last_qmd_recall.json",
      "state/last_recall.json",
    ]);
    const focused = await buildOfflineSyncSnapshotForPaths({
      root,
      sourceId: "remote",
      paths: ["state/last_graph_recall.json"],
      includeContent: true,
    });
    assert.deepEqual(focused.files.map((file) => file.path), ["state/last_graph_recall.json"]);
    const chunk = await readOfflineSyncFileContentChunk({
      root,
      path: "state/last_graph_recall.json",
    });
    assert.equal(chunk.content.toString("utf-8"), "graph");

    const oldGraph = Buffer.from("old graph");
    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot,
      baseFiles: [{
        path: "state/last_graph_recall.json",
        sha256: createHash("sha256").update(oldGraph).digest("hex"),
        bytes: oldGraph.byteLength,
        mtimeMs: 0,
      }],
    });

    assert.equal(pull.skipped, 5);
    assert.equal(await readUtf8(root, "state/last_graph_recall.json"), "graph");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync includes live LCM sqlite artifacts for full-fidelity offline mode", async () => {
  const root = await tempDir("remnic-offline-lcm-sqlite");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "state/lcm.sqlite", "live db");
    await write(root, "state/lcm.sqlite-shm", "live shm");
    await write(root, "state/lcm.sqlite-wal", "live wal");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    assert.deepEqual(snapshot.files.map((file) => file.path), [
      "facts/a.md",
      "state/lcm.sqlite",
      "state/lcm.sqlite-shm",
      "state/lcm.sqlite-wal",
    ]);
    const focused = await buildOfflineSyncSnapshotForPaths({
      root,
      sourceId: "remote",
      paths: ["state/lcm.sqlite"],
      includeContent: true,
    });
    assert.deepEqual(focused.files.map((file) => file.path), ["state/lcm.sqlite"]);

    const oldDb = Buffer.from("old live db");
    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot,
      baseFiles: [{
        path: "state/lcm.sqlite",
        sha256: createHash("sha256").update(oldDb).digest("hex"),
        bytes: oldDb.byteLength,
        mtimeMs: 0,
      }],
    });

    assert.equal(pull.skipped, 4);
    assert.equal(await readUtf8(root, "state/lcm.sqlite"), "live db");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync includes durable runtime state and excludes only transient sync temp files", async () => {
  const root = await tempDir("remnic-offline-runtime-state");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "assets/state/fact-hashes.txt", "durable asset");
    await write(root, "state/buffer-surprise-ledger.jsonl", "surprise");
    await write(root, "state/buffer.json", "buffer");
    await write(root, "state/buffer.json.tmp-123-456", "tmp");
    await write(root, "state/embeddings.json", "embeddings");
    await write(root, "state/entity-mention-index.json", "entities");
    await write(root, "state/index_tags.json", "tags");
    await write(root, "state/index_time.json", "time");
    await write(root, "state/memory-lifecycle-ledger.jsonl", "ledger");
    await write(root, "state/.artifact-write-version.log", "version");
    await write(root, "state/.memory-status-version.log", "version");
    await write(root, "state/memory-projection.sqlite", "projection");
    await write(root, "state/memory-projection.sqlite-shm", "projection-shm");
    await write(root, "state/memory-projection.sqlite-wal", "projection-wal");
    await write(root, "state/recall_impressions.jsonl", "impressions");
    await write(root, "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json", "intent");
    await write(root, "namespaces/generalist-project-origin-6ebeaa54/state/entity-mention-index.json", "entities");
    await write(root, "namespaces/generalist-project-origin-6ebeaa54/state/.memory-status-version.log", "version");

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    assert.deepEqual(snapshot.files.map((file) => file.path), [
      "assets/state/fact-hashes.txt",
      "facts/a.md",
      "namespaces/generalist-project-origin-6ebeaa54/state/.memory-status-version.log",
      "namespaces/generalist-project-origin-6ebeaa54/state/entity-mention-index.json",
      "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json",
      "state/.artifact-write-version.log",
      "state/.memory-status-version.log",
      "state/buffer-surprise-ledger.jsonl",
      "state/buffer.json",
      "state/embeddings.json",
      "state/entity-mention-index.json",
      "state/index_tags.json",
      "state/index_time.json",
      "state/memory-lifecycle-ledger.jsonl",
      "state/memory-projection.sqlite",
      "state/memory-projection.sqlite-shm",
      "state/memory-projection.sqlite-wal",
      "state/recall_impressions.jsonl",
    ]);
    const focused = await buildOfflineSyncSnapshotForPaths({
      root,
      sourceId: "remote",
      paths: ["state/memory-lifecycle-ledger.jsonl"],
      includeContent: true,
    });
    assert.deepEqual(focused.files.map((file) => file.path), ["state/memory-lifecycle-ledger.jsonl"]);
    await assert.rejects(
      () =>
        readOfflineSyncFileContentChunk({
          root,
          path: "state/buffer.json.tmp-123-456",
        }),
      /offline sync file content path is excluded: state\/buffer\.json\.tmp-123-456/,
    );
    const namespaced = await buildOfflineSyncSnapshotForPaths({
      root,
      sourceId: "remote",
      paths: ["namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json"],
      includeContent: true,
    });
    assert.deepEqual(namespaced.files.map((file) => file.path), [
      "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json",
    ]);

    const oldLedger = Buffer.from("old ledger");
    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot,
      baseFiles: [{
        path: "state/memory-lifecycle-ledger.jsonl",
        sha256: createHash("sha256").update(oldLedger).digest("hex"),
        bytes: oldLedger.byteLength,
        mtimeMs: 0,
      }],
    });

    assert.equal(pull.skipped, 18);
    assert.equal(await readUtf8(root, "state/memory-lifecycle-ledger.jsonl"), "ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync accepts durable runtime records from older peers", async () => {
  const root = await tempDir("remnic-offline-legacy-runtime-state");
  try {
    const fact = Buffer.from("alpha");
    const runtime = Buffer.from("legacy runtime");
    const asset = Buffer.from("durable asset");
    const runtimeSha = createHash("sha256").update(runtime).digest("hex");
    const factSha = createHash("sha256").update(fact).digest("hex");
    const assetSha = createHash("sha256").update(asset).digest("hex");

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "old-remote",
        includeTranscripts: true,
        files: [
          {
            path: "state/buffer.json",
            sha256: runtimeSha,
            bytes: runtime.byteLength,
            mtimeMs: 0,
            contentBase64: runtime.toString("base64"),
          },
          {
            path: "state/buffer.json.tmp-123-456",
            sha256: runtimeSha,
            bytes: runtime.byteLength,
            mtimeMs: 0,
            contentBase64: runtime.toString("base64"),
          },
          {
            path: "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json",
            sha256: runtimeSha,
            bytes: runtime.byteLength,
            mtimeMs: 0,
            contentBase64: runtime.toString("base64"),
          },
          {
            path: "facts/a.md",
            sha256: factSha,
            bytes: fact.byteLength,
            mtimeMs: 0,
            contentBase64: fact.toString("base64"),
          },
          {
            path: "assets/state/fact-hashes.txt",
            sha256: assetSha,
            bytes: asset.byteLength,
            mtimeMs: 0,
            contentBase64: asset.toString("base64"),
          },
        ],
      },
    });

    assert.equal(pull.upserted, 4);
    assert.equal(await readUtf8(root, "facts/a.md"), "alpha");
    assert.equal(await readUtf8(root, "assets/state/fact-hashes.txt"), "durable asset");
    assert.equal(await readUtf8(root, "state/buffer.json"), "legacy runtime");
    assert.equal(
      await readUtf8(root, "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json"),
      "legacy runtime",
    );
    await assert.rejects(
      () => readFile(path.join(root, "state", "buffer.json.tmp-123-456")),
      /ENOENT/,
    );

    const remote = await tempDir("remnic-offline-legacy-runtime-remote");
    try {
      const push = await applyOfflineSyncChangeset({
        root: remote,
        changeset: {
          format: "remnic.offline-sync.changeset.v1",
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          sourceId: "old-laptop",
          includeTranscripts: true,
          changes: [
            {
              type: "upsert",
              path: "state/memory-lifecycle-ledger.jsonl",
              file: {
                path: "state/memory-lifecycle-ledger.jsonl",
                sha256: runtimeSha,
                bytes: runtime.byteLength,
                mtimeMs: 0,
                contentBase64: runtime.toString("base64"),
              },
            },
            {
              type: "upsert",
              path: "state/buffer.json.tmp-123-456",
              file: {
                path: "state/buffer.json.tmp-123-456",
                sha256: runtimeSha,
                bytes: runtime.byteLength,
                mtimeMs: 0,
                contentBase64: runtime.toString("base64"),
              },
            },
            {
              type: "upsert",
              path: "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json",
              file: {
                path: "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json",
                sha256: runtimeSha,
                bytes: runtime.byteLength,
                mtimeMs: 0,
                contentBase64: runtime.toString("base64"),
              },
            },
            {
              type: "upsert",
              path: "facts/a.md",
              file: {
                path: "facts/a.md",
                sha256: factSha,
                bytes: fact.byteLength,
                mtimeMs: 0,
                contentBase64: fact.toString("base64"),
              },
            },
            {
              type: "upsert",
              path: "assets/state/fact-hashes.txt",
              file: {
                path: "assets/state/fact-hashes.txt",
                sha256: assetSha,
                bytes: asset.byteLength,
                mtimeMs: 0,
                contentBase64: asset.toString("base64"),
              },
            },
          ],
        },
      });

      assert.equal(push.appliedUpserts, 4);
      assert.equal(await readUtf8(remote, "facts/a.md"), "alpha");
      assert.equal(await readUtf8(remote, "assets/state/fact-hashes.txt"), "durable asset");
      assert.equal(
        await readUtf8(remote, "state/memory-lifecycle-ledger.jsonl"),
        "legacy runtime",
      );
      assert.equal(
        await readUtf8(remote, "namespaces/generalist-project-origin-6ebeaa54/state/last_intent.json"),
        "legacy runtime",
      );
      await assert.rejects(
        () => readFile(path.join(remote, "state", "buffer.json.tmp-123-456")),
        /ENOENT/,
      );
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync pending summary returns counts without materializing changed content", async () => {
  const root = await tempDir("remnic-offline-pending-summary");
  try {
    await write(root, "facts/a.md", "updated");
    await write(root, "facts/b.md", "new");
    const baseA = createHash("sha256").update("old").digest("hex");
    const baseDeleted = createHash("sha256").update("deleted").digest("hex");

    const summary = await summarizeOfflineSyncPendingChanges({
      root,
      sourceId: "local",
      baseFiles: [
        { path: "facts/a.md", sha256: baseA, bytes: 3, mtimeMs: 0 },
        { path: "facts/deleted.md", sha256: baseDeleted, bytes: 7, mtimeMs: 0 },
      ],
    });

    assert.deepEqual(summary, { upserts: 2, deletes: 1, total: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync reads bounded file content chunks with metadata", async () => {
  const root = await tempDir("remnic-offline-file-content");
  try {
    await write(root, "artifacts/large.txt", "alpha\nbeta\ngamma\n");
    await write(root, "state/lcm.sqlite", "live db");

    const chunk = await readOfflineSyncFileContentChunk({
      root,
      path: "artifacts/large.txt",
      offset: 6,
      length: 5,
    });

    assert.equal(chunk.path, "artifacts/large.txt");
    assert.equal(chunk.offset, 6);
    assert.equal(chunk.chunkBytes, 5);
    assert.equal(chunk.content.toString("utf-8"), "beta\n");
    assert.equal(chunk.bytes, Buffer.byteLength("alpha\nbeta\ngamma\n"));

    const lcm = await readOfflineSyncFileContentChunk({
      root,
      path: "state/lcm.sqlite",
    });
    assert.equal(lcm.content.toString("utf-8"), "live db");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync applies chunked file content with base conflict checks", async () => {
  const root = await tempDir("remnic-offline-file-content-apply");
  try {
    await write(root, "state/lcm.sqlite", "old");
    const oldSha = createHash("sha256").update("old").digest("hex");
    const next = Buffer.from("new durable sqlite content");
    const nextSha = createHash("sha256").update(next).digest("hex");

    const first = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 123,
      offset: 0,
      baseSha256: oldSha,
      content: next.subarray(0, 8),
    });
    assert.equal(first.done, false);

    const second = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 123,
      offset: 8,
      baseSha256: oldSha,
      content: next.subarray(8),
    });
    assert.equal(second.done, true);
    assert.equal(second.applied, true);
    assert.equal(await readUtf8(root, "state/lcm.sqlite"), "new durable sqlite content");

    const conflictContent = Buffer.from("conflicting local sqlite");
    const conflictSha = createHash("sha256").update(conflictContent).digest("hex");
    const conflict = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: conflictSha,
      bytes: conflictContent.byteLength,
      mtimeMs: 456,
      offset: 0,
      baseSha256: oldSha,
      content: conflictContent,
    });
    assert.equal(conflict.done, true);
    assert.equal(conflict.applied, false);
    assert.equal(conflict.conflict?.reason, "remote_changed_for_local_update");
    assert.equal(await readUtf8(root, "state/lcm.sqlite"), "new durable sqlite content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync stages chunked uploads through storage hooks", async () => {
  const root = await tempDir("remnic-offline-file-content-hooks");
  const encode = (content: Buffer) => Buffer.from(`ENC:${content.toString("base64")}`);
  const decode = (content: Buffer) => {
    const text = content.toString("utf-8");
    return text.startsWith("ENC:") ? Buffer.from(text.slice(4), "base64") : content;
  };
  const readHook = async ({ filePath }: { filePath: string }) => decode(await readFile(filePath));
  let stagingWrites = 0;
  let mutationWrites = 0;
  const writeStagingHook = async ({ filePath, content }: { filePath: string; content: Buffer }) => {
    stagingWrites += 1;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, encode(content));
  };
  const writeHook = async ({ filePath, content }: { filePath: string; content: Buffer }) => {
    mutationWrites += 1;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, encode(content));
  };
  const writeChunksHook = async ({
    filePath,
    chunks,
  }: {
    filePath: string;
    chunks: AsyncIterable<Buffer>;
  }) => {
    const content: Buffer[] = [];
    for await (const chunk of chunks) content.push(chunk);
    await writeHook({ filePath, content: Buffer.concat(content) });
  };

  try {
    await write(root, "state/lcm.sqlite", "old");
    const oldSha = createHash("sha256").update("old").digest("hex");
    const next = Buffer.from("new durable sqlite content");
    const nextSha = createHash("sha256").update(next).digest("hex");

    const first = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 123,
      offset: 0,
      baseSha256: oldSha,
      content: next.subarray(0, 8),
      readFile: readHook,
      writeFile: writeHook,
      writeStagingFile: writeStagingHook,
      writeFileChunks: writeChunksHook,
    });
    assert.equal(first.done, false);
    assert.equal(stagingWrites, 1);
    assert.equal(mutationWrites, 0);
    const uploadEntries = await readdir(path.join(root, ".offline-sync", "uploads"));
    assert.equal(uploadEntries.length, 1);
    const uploadChunkEntries = await readdir(path.join(root, ".offline-sync", "uploads", uploadEntries[0]));
    assert.deepEqual(uploadChunkEntries, ["00000000000000000000.part"]);
    const rawUpload = await readFile(path.join(
      root,
      ".offline-sync",
      "uploads",
      uploadEntries[0],
      uploadChunkEntries[0],
    ));
    assert.match(rawUpload.toString("utf-8"), /^ENC:/);
    assert.equal(rawUpload.includes(next.subarray(0, 8)), false);

    const second = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 123,
      offset: 8,
      baseSha256: oldSha,
      content: next.subarray(8),
      readFile: readHook,
      writeFile: writeHook,
      writeStagingFile: writeStagingHook,
      writeFileChunks: writeChunksHook,
    });
    assert.equal(second.applied, true);
    assert.equal(stagingWrites, 2);
    assert.equal(mutationWrites, 1);
    assert.equal((await readdir(path.join(root, ".offline-sync", "uploads"))).length, 0);
    const rawTarget = await readFile(path.join(root, "state/lcm.sqlite"));
    assert.match(rawTarget.toString("utf-8"), /^ENC:/);
    assert.equal(decode(rawTarget).toString("utf-8"), "new durable sqlite content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync prunes stale staged uploads when starting a new upload", async () => {
  const root = await tempDir("remnic-offline-file-content-prune");
  try {
    const staleKey = `${"a".repeat(64)}.part`;
    const staleDir = path.join(root, ".offline-sync", "uploads", staleKey);
    await mkdir(staleDir, { recursive: true });
    await writeFile(path.join(staleDir, "00000000000000000000.part"), "abandoned");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(path.join(staleDir, "00000000000000000000.part"), staleTime, staleTime);
    await utimes(staleDir, staleTime, staleTime);

    const next = Buffer.from("new durable sqlite content");
    const nextSha = createHash("sha256").update(next).digest("hex");
    const first = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 123,
      offset: 0,
      content: next.subarray(0, 8),
    });

    assert.equal(first.done, false);
    const uploadEntries = await readdir(path.join(root, ".offline-sync", "uploads"));
    assert.equal(uploadEntries.includes(staleKey), false);
    assert.equal(uploadEntries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset pushes local edits when the remote is still at the shared base", async () => {
  const remote = await tempDir("remnic-offline-remote");
  const local = await tempDir("remnic-offline-local");
  try {
    await write(remote, "facts/base.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const pull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "facts/base.md", "base plus local");
    await write(local, "facts/local-only.md", "new local fact");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: pull.nextBaseFiles,
    });

    assert.equal(changeset.changes.length, 2);
    const push = await applyOfflineSyncChangeset({
      root: remote,
      changeset,
    });

    assert.equal(push.appliedUpserts, 2);
    assert.equal(push.conflicts.length, 0);
    assert.equal(await readUtf8(remote, "facts/base.md"), "base plus local");
    assert.equal(await readUtf8(remote, "facts/local-only.md"), "new local fact");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline changeset only carries content for changed local files", async () => {
  const local = await tempDir("remnic-offline-changeset-content");
  try {
    await write(local, "facts/unchanged.md", "same");
    await write(local, "facts/changed.md", "before");
    const base = await buildOfflineSyncSnapshot({
      root: local,
      sourceId: "remote",
      includeContent: false,
    });

    await write(local, "facts/changed.md", "after");
    await write(local, "facts/empty.md", "");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: base.files,
    });

    assert.deepEqual(
      changeset.changes.map((change) => change.path),
      ["facts/changed.md", "facts/empty.md"],
    );
    const empty = changeset.changes.find((change) => change.path === "facts/empty.md");
    assert.equal(empty?.type, "upsert");
    if (empty?.type === "upsert") {
      assert.equal(empty.file.contentBase64, "");
    }
    assert.equal(JSON.stringify(changeset).includes("same"), false);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("offline changeset can exclude directly pushed large files without reading their content", async () => {
  const local = await tempDir("remnic-offline-changeset-exclude");
  try {
    await write(local, "state/lcm.sqlite", "before");
    await write(local, "facts/small.md", "before");
    const base = await buildOfflineSyncSnapshot({
      root: local,
      sourceId: "remote",
      includeContent: false,
    });

    await write(local, "state/lcm.sqlite", "after large");
    await write(local, "facts/small.md", "after small");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: base.files,
      excludePaths: ["state/lcm.sqlite"],
    });

    assert.deepEqual(changeset.changes.map((change) => change.path), ["facts/small.md"]);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull accepts metadata-only snapshots when files are unchanged", async () => {
  const remote = await tempDir("remnic-offline-metadata-remote");
  const local = await tempDir("remnic-offline-metadata-local");
  try {
    await write(remote, "facts/shared.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });
    const metadataOnly = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: false,
    });

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: metadataOnly,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.conflicts.length, 0);
    assert.equal(secondPull.upserted, 0);
    assert.equal(secondPull.skipped, 1);
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull applies snapshots with content only for remote-changed files", async () => {
  const remote = await tempDir("remnic-offline-partial-remote");
  const local = await tempDir("remnic-offline-partial-local");
  try {
    await write(remote, "facts/shared.md", "base");
    await write(remote, "facts/stable.md", "unchanged");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(remote, "facts/shared.md", "remote edit");
    const metadataOnly = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: false,
    });
    const changedContent = await buildOfflineSyncSnapshotForPaths({
      root: remote,
      sourceId: "remote",
      paths: ["facts/shared.md"],
      includeContent: true,
    });
    const contentByPath = new Map(
      changedContent.files.map((file) => [file.path, file.contentBase64]),
    );
    const hydrated = {
      ...metadataOnly,
      files: metadataOnly.files.map((file) => {
        const contentBase64 = contentByPath.get(file.path);
        return contentBase64 === undefined ? file : { ...file, contentBase64 };
      }),
    };

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: hydrated,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.upserted, 1);
    assert.equal(secondPull.conflicts.length, 0);
    assert.equal(await readUtf8(local, "facts/shared.md"), "remote edit");
    assert.equal(await readUtf8(local, "facts/stable.md"), "unchanged");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull preserves local edits when both sides changed since the base", async () => {
  const remote = await tempDir("remnic-offline-conflict-remote");
  const local = await tempDir("remnic-offline-conflict-local");
  try {
    await write(remote, "facts/shared.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "facts/shared.md", "local edit");
    await write(remote, "facts/shared.md", "remote edit");
    const remoteSnapshot = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: remoteSnapshot,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.conflicts.length, 1);
    assert.equal(secondPull.conflicts[0]?.reason, "both_modified");
    assert.equal(await readUtf8(local, "facts/shared.md"), "local edit");
    const conflictPath = secondPull.conflicts[0]?.conflictPath;
    assert.ok(conflictPath);
    assert.equal(await readUtf8(local, conflictPath), "remote edit");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline push preserves remote edits when both sides changed since the base", async () => {
  const remote = await tempDir("remnic-offline-push-conflict-remote");
  const local = await tempDir("remnic-offline-push-conflict-local");
  try {
    await write(remote, "facts/shared.md", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "facts/shared.md", "local edit");
    await write(remote, "facts/shared.md", "remote edit");
    const changeset = await buildOfflineSyncChangeset({
      root: local,
      sourceId: "laptop",
      baseFiles: firstPull.nextBaseFiles,
    });

    const push = await applyOfflineSyncChangeset({
      root: remote,
      changeset,
    });

    assert.equal(push.appliedUpserts, 0);
    assert.equal(push.conflicts.length, 1);
    assert.equal(push.conflicts[0]?.reason, "remote_changed_for_local_update");
    assert.equal(await readUtf8(remote, "facts/shared.md"), "remote edit");
    const conflictPath = push.conflicts[0]?.conflictPath;
    assert.ok(conflictPath);
    assert.equal(await readUtf8(remote, conflictPath), "local edit");
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline pull applies remote deletion when the local file is unchanged", async () => {
  const remote = await tempDir("remnic-offline-delete-remote");
  const local = await tempDir("remnic-offline-delete-local");
  try {
    await write(remote, "facts/deleted.md", "soon gone");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await rm(path.join(remote, "facts/deleted.md"), { force: true });
    const remoteSnapshot = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: remoteSnapshot,
      baseFiles: firstPull.nextBaseFiles,
    });

    assert.equal(secondPull.deleted, 1);
    await assert.rejects(
      () => readFile(path.join(local, "facts/deleted.md")),
      /ENOENT/,
    );
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  }
});

test("offline changeset does not delete transcript baselines when transcripts are excluded", async () => {
  const root = await tempDir("remnic-offline-transcript-mode");
  try {
    await write(root, "facts/a.md", "alpha");
    await write(root, "transcripts/session.jsonl", "turn");
    const base = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
    });

    await rm(path.join(root, "transcripts"), { recursive: true, force: true });
    const changeset = await buildOfflineSyncChangeset({
      root,
      sourceId: "laptop",
      baseFiles: base.files,
      includeTranscripts: false,
    });

    assert.deepEqual(changeset.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset rejects transcript changes when transcripts are excluded", async () => {
  const root = await tempDir("remnic-offline-transcript-invalid");
  try {
    await write(root, "facts/a.md", "alpha");
    const transcript = Buffer.from("turn");
    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: false,
            changes: [{
              type: "upsert",
              path: "transcripts/session.jsonl",
              file: {
                path: "transcripts/session.jsonl",
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                bytes: transcript.byteLength,
                mtimeMs: 0,
                contentBase64: transcript.toString("base64"),
              },
            }],
          },
        }),
      /offline sync changeset includeTranscripts is false but contains transcript path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot rejects transcript records when transcripts are excluded", async () => {
  const root = await tempDir("remnic-offline-snapshot-transcript-invalid");
  try {
    const transcript = Buffer.from("turn");
    await assert.rejects(
      () =>
        applyOfflineSyncSnapshot({
          root,
          snapshot: {
            format: "remnic.offline-sync.snapshot.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remote",
            includeTranscripts: false,
            files: [{
              path: "transcripts/session.jsonl",
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              bytes: transcript.byteLength,
              mtimeMs: 0,
              contentBase64: transcript.toString("base64"),
            }],
          },
        }),
      /offline sync snapshot includeTranscripts is false but contains transcript path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline payloads require explicit includeTranscripts booleans", async () => {
  const root = await tempDir("remnic-offline-include-transcripts-invalid");
  try {
    await assert.rejects(
      () =>
        applyOfflineSyncSnapshot({
          root,
          snapshot: {
            format: "remnic.offline-sync.snapshot.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remote",
            files: [],
          },
        }),
      /includeTranscripts must be a boolean/,
    );

    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: "false",
            changes: [],
          },
        }),
      /includeTranscripts must be a boolean/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline payloads reject excluded internal paths", async () => {
  const root = await tempDir("remnic-offline-internal-path-invalid");
  try {
    const header = Buffer.from("secret");
    await assert.rejects(
      () =>
        applyOfflineSyncSnapshot({
          root,
          snapshot: {
            format: "remnic.offline-sync.snapshot.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "remote",
            includeTranscripts: true,
            files: [{
              path: ".secure-store/header.json",
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              bytes: header.byteLength,
              mtimeMs: 0,
              contentBase64: header.toString("base64"),
            }],
          },
        }),
      /offline sync snapshot contains excluded path: \.secure-store\/header\.json/,
    );

    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: true,
            changes: [{
              type: "upsert",
              path: ".secure-store/header.json",
              file: {
                path: ".secure-store/header.json",
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                bytes: header.byteLength,
                mtimeMs: 0,
                contentBase64: header.toString("base64"),
              },
            }],
          },
        }),
      /offline sync changeset contains excluded path: \.secure-store\/header\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync applies and snapshots through secure storage hooks", async () => {
  const root = await tempDir("remnic-offline-secure-store");
  const source = await tempDir("remnic-offline-secure-source");
  try {
    await write(source, "facts/secure.md", "secret fact");
    const changeset = await buildOfflineSyncChangeset({
      root: source,
      sourceId: "laptop",
    });
    const storage = new StorageManager(root);
    storage.setSecureStoreKey(Buffer.alloc(32, 7));
    storage.setSecureStoreRequired(true);

    const apply = await applyOfflineSyncChangeset({
      root,
      changeset,
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
      writeFile: async ({ filePath, content }) => storage.writeOfflineSyncFile(filePath, content),
      deleteFile: async ({ filePath }) => storage.deleteOfflineSyncFile(filePath),
    });

    assert.equal(apply.appliedUpserts, 1);
    const raw = await readFile(path.join(root, "facts", "secure.md"));
    assert.equal(isEncryptedFile(raw), true);
    assert.equal(
      (await storage.readOfflineSyncFile(path.join(root, "facts", "secure.md"))).toString("utf8"),
      "secret fact",
    );

    const snapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: true,
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
    });
    assert.equal(
      Buffer.from(snapshot.files[0]?.contentBase64 ?? "", "base64").toString("utf8"),
      "secret fact",
    );
    assert.equal(snapshot.files[0]?.bytes, Buffer.byteLength("secret fact"));

    const sqlite = Buffer.from("streamed durable sqlite content");
    const sqliteSha = createHash("sha256").update(sqlite).digest("hex");
    const first = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: sqliteSha,
      bytes: sqlite.byteLength,
      mtimeMs: 321,
      offset: 0,
      content: sqlite.subarray(0, 8),
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
      writeFile: async ({ filePath, content }) => storage.writeOfflineSyncFile(filePath, content),
      writeStagingFile: async ({ filePath, content }) => storage.writeOfflineSyncStagingFile(filePath, content),
      writeFileChunks: async ({ filePath, chunks }) => storage.writeOfflineSyncFileChunks(filePath, chunks),
    });
    assert.equal(first.done, false);
    const second = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: sqliteSha,
      bytes: sqlite.byteLength,
      mtimeMs: 321,
      offset: 8,
      content: sqlite.subarray(8),
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
      writeFile: async ({ filePath, content }) => storage.writeOfflineSyncFile(filePath, content),
      writeStagingFile: async ({ filePath, content }) => storage.writeOfflineSyncStagingFile(filePath, content),
      writeFileChunks: async ({ filePath, chunks }) => storage.writeOfflineSyncFileChunks(filePath, chunks),
    });
    assert.equal(second.applied, true);
    const rawSqlite = await readFile(path.join(root, "state", "lcm.sqlite"));
    assert.equal(isEncryptedFile(rawSqlite), true);
    assert.equal(
      (await storage.readOfflineSyncFile(path.join(root, "state", "lcm.sqlite"))).toString("utf8"),
      "streamed durable sqlite content",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("offline storage writes invalidate fact hash readiness for rebuild", async () => {
  const root = await tempDir("remnic-offline-hash-index-local");
  const source = await tempDir("remnic-offline-hash-index-source");
  try {
    const localStorage = new StorageManager(root);
    await localStorage.writeMemory("fact", "alpha fact");
    assert.equal(await localStorage.hasFactContentHash("alpha fact"), true);
    assert.equal(await localStorage.hasFactContentHash("beta fact"), false);

    const sourceStorage = new StorageManager(source);
    await sourceStorage.writeMemory("fact", "beta fact");
    const sourceChangeset = await buildOfflineSyncChangeset({
      root: source,
      sourceId: "remote",
    });

    assert.equal(
      sourceChangeset.changes.some((change) => change.path.startsWith("state/fact-hashes")),
      true,
    );

    const factChangeset = {
      ...sourceChangeset,
      changes: sourceChangeset.changes.filter((change) => change.path.startsWith("facts/")),
    };
    const apply = await applyOfflineSyncChangeset({
      root,
      changeset: factChangeset,
      readFile: async ({ filePath }) => localStorage.readOfflineSyncFile(filePath),
      writeFile: async ({ filePath, content }) => localStorage.writeOfflineSyncFile(filePath, content),
      deleteFile: async ({ filePath }) => localStorage.deleteOfflineSyncFile(filePath),
    });

    assert.equal(apply.conflicts.length, 0);
    assert.equal(await localStorage.hasFactContentHash("beta fact"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("offline changeset validation reports client input errors with an offline sync prefix", async () => {
  const root = await tempDir("remnic-offline-invalid-changeset");
  try {
    await assert.rejects(
      () =>
        applyOfflineSyncChangeset({
          root,
          changeset: {
            format: "remnic.offline-sync.changeset.v1",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceId: "laptop",
            includeTranscripts: true,
            changes: [{ type: "delete", path: "../escape", baseSha256: "nope" }],
          },
        }),
      /offline sync changeset invalid:/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
