import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyOfflineSyncFileContentChunk,
  applyOfflineSyncChangeset,
  applyOfflineSyncSnapshot,
  buildOfflineSyncChangeset,
  buildOfflineSyncChangesetFromSnapshot,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotFromBase,
  buildOfflineSyncSnapshotForPaths,
  OFFLINE_SYNC_MAX_MTIME_MS,
  readOfflineSyncFileContentChunk,
  shouldPreferIncomingOfflineRuntimeFile,
  summarizeOfflineSyncPendingChanges,
  summarizeOfflineSyncPendingFiles,
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

test("offline snapshot abort signal stops filesystem snapshot work", async () => {
  const root = await tempDir("remnic-offline-snapshot-abort");
  try {
    await write(root, "facts/a.md", "alpha");
    const controller = new AbortController();

    await assert.rejects(
      buildOfflineSyncSnapshot({
        root,
        sourceId: "remote",
        signal: controller.signal,
        readFileDigest: async () => {
          controller.abort();
          return {
            sha256: createHash("sha256").update("alpha").digest("hex"),
            bytes: Buffer.byteLength("alpha"),
          };
        },
      }),
      /offline sync request aborted/,
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
    assert.equal(shouldPreferIncomingOfflineRuntimeFile("state/lcm.sqlite-shm"), true);
    assert.equal(shouldPreferIncomingOfflineRuntimeFile("state/lcm.sqlite-wal"), true);
    assert.equal(shouldPreferIncomingOfflineRuntimeFile("state/last_qmd_recall.json"), true);
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

    await write(root, "state/lcm.sqlite-wal", "local wal churn");
    const changeset = await buildOfflineSyncChangeset({
      root,
      sourceId: "laptop",
      baseFiles: snapshot.files,
    });
    assert.deepEqual(changeset.changes.map((change) => change.path), []);
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

test("offline snapshot from base avoids rehashing unchanged files", async () => {
  const root = await tempDir("remnic-offline-fast-base");
  try {
    await write(root, "facts/a.md", "alpha");
    const baseSnapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
    });
    const baseCapturedAt = new Date();
    let readCount = 0;

    const unchanged = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: baseSnapshot.files,
      baseCapturedAt,
      includeContent: false,
      readFile: async () => {
        readCount += 1;
        throw new Error("unchanged file should not be read");
      },
    });

    assert.equal(readCount, 0);
    assert.deepEqual(unchanged.files, baseSnapshot.files);

    await write(root, "facts/b.md", "beta");
    const changed = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: baseSnapshot.files,
      baseCapturedAt,
      includeContent: false,
      readFile: async ({ filePath }) => {
        readCount += 1;
        return readFile(filePath);
      },
    });

    assert.equal(readCount, 1);
    assert.deepEqual(changed.files.map((file) => file.path), ["facts/a.md", "facts/b.md"]);

    let digestReadCount = 0;
    const digestSnapshot = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: baseSnapshot.files,
      baseCapturedAt,
      includeContent: false,
      readFile: async () => {
        throw new Error("digest hook should avoid buffered reads");
      },
      readFileDigest: async ({ filePath }) => {
        digestReadCount += 1;
        const bytes = await readFile(filePath);
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        };
      },
    });

    assert.equal(digestReadCount, 1);
    assert.deepEqual(digestSnapshot.files.map((file) => file.path), ["facts/a.md", "facts/b.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot from base rehashes same-size rewrites when mtime changes", async () => {
  const root = await tempDir("remnic-offline-fast-base-ctime");
  try {
    await write(root, "facts/a.md", "alpha");
    const filePath = path.join(root, "facts/a.md");
    const baseSnapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
    });
    const baseFile = baseSnapshot.files[0];
    assert.ok(baseFile);
    const baseCapturedAt = new Date();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await write(root, "facts/a.md", "bravo");
    const rewritten = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
    });
    const rewrittenFile = rewritten.files[0];
    assert.ok(rewrittenFile);
    if (Math.abs(rewrittenFile.mtimeMs - baseFile.mtimeMs) <= 1_000) {
      await utimes(filePath, (baseFile.mtimeMs + 2_000) / 1000, (baseFile.mtimeMs + 2_000) / 1000);
    }

    let readCount = 0;
    const snapshot = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: baseSnapshot.files,
      baseCapturedAt,
      includeContent: false,
      readFile: async ({ filePath }) => {
        readCount += 1;
        return readFile(filePath);
      },
    });

    assert.equal(readCount, 1);
    assert.equal(snapshot.files[0]?.path, "facts/a.md");
    assert.notEqual(snapshot.files[0]?.sha256, baseFile.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot from base trusts mtime precision drift without rehashing", async () => {
  const root = await tempDir("remnic-offline-fast-base-large");
  try {
    await write(root, "facts/a.md", "alpha");
    const baseSnapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
    });
    const baseFile = baseSnapshot.files.find((file) => file.path === "facts/a.md");
    assert.ok(baseFile);
    const driftedBase = { ...baseFile, mtimeMs: baseFile.mtimeMs + 500 };

    const reused = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: [driftedBase],
      baseCapturedAt: new Date(),
      includeContent: false,
      readFileDigest: async () => {
        throw new Error("unchanged file should reuse trusted mtime metadata");
      },
    });

    assert.deepEqual(reused.files, [driftedBase]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot from base rehashes metadata-only ctime churn", async () => {
  const root = await tempDir("remnic-offline-fast-base-ctime-only");
  try {
    await write(root, "facts/a.md", "alpha");
    const filePath = path.join(root, "facts/a.md");
    const baseSnapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
    });
    const baseFile = baseSnapshot.files.find((file) => file.path === "facts/a.md");
    assert.ok(baseFile);
    const baseCapturedAt = new Date();
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await chmod(filePath, 0o600);
    await chmod(filePath, 0o644);

    let digestReadCount = 0;
    const rehashed = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: baseSnapshot.files,
      baseCapturedAt,
      includeContent: false,
      readFileDigest: async ({ filePath }) => {
        digestReadCount += 1;
        const bytes = await readFile(filePath);
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        };
      },
    });

    assert.equal(digestReadCount, 1);
    assert.equal(rehashed.files[0]?.sha256, baseFile.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot from base rehashes preserved-mtime rewrites when ctime changed after capture", async () => {
  const root = await tempDir("remnic-offline-fast-base-preserved-mtime");
  try {
    await write(root, "facts/a.md", "alpha");
    const filePath = path.join(root, "facts/a.md");
    const baseSnapshot = await buildOfflineSyncSnapshot({
      root,
      sourceId: "remote",
      includeContent: false,
    });
    const baseFile = baseSnapshot.files[0];
    assert.ok(baseFile);
    const baseCapturedAt = new Date();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await write(root, "facts/a.md", "bravo");
    await utimes(filePath, baseFile.mtimeMs / 1000, baseFile.mtimeMs / 1000);

    let digestReadCount = 0;
    const snapshot = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: baseSnapshot.files,
      baseCapturedAt,
      includeContent: false,
      readFileDigest: async ({ filePath }) => {
        digestReadCount += 1;
        const bytes = await readFile(filePath);
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        };
      },
    });

    assert.equal(digestReadCount, 1);
    assert.equal(snapshot.files[0]?.path, "facts/a.md");
    assert.notEqual(snapshot.files[0]?.sha256, baseFile.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply preserves incoming mtime for future fast-base reuse", async () => {
  const root = await tempDir("remnic-offline-apply-mtime");
  try {
    const content = Buffer.from("remote fact");
    const remoteMtimeMs = 1_700_000_000_123;
    const capturedAtMs = Date.now() + 60_000;
    const snapshot = {
      format: "remnic.offline-sync.snapshot.v1",
      schemaVersion: 1,
      createdAt: new Date(capturedAtMs).toISOString(),
      sourceId: "remote",
      includeTranscripts: true,
      files: [{
        path: "facts/a.md",
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        mtimeMs: remoteMtimeMs,
        contentBase64: content.toString("base64"),
      }],
    } as const;

    const applied = await applyOfflineSyncSnapshot({
      root,
      snapshot,
      baseFiles: [],
    });
    assert.equal(applied.upserted, 1);
    const fileStat = await stat(path.join(root, "facts/a.md"));
    assert.ok(Math.abs(fileStat.mtimeMs - remoteMtimeMs) <= 1_000);

    const reused = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "local",
      baseFiles: applied.nextBaseFiles,
      baseCapturedAt: new Date(),
      includeContent: false,
      readFileDigest: async () => {
        throw new Error("applied file should reuse preserved mtime metadata");
      },
    });
    assert.deepEqual(reused.files, applied.nextBaseFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply does not checkpoint a vanished same-hash file", async () => {
  const root = await tempDir("remnic-offline-apply-mtime-vanished");
  try {
    const content = Buffer.from("remote fact");
    const file = {
      path: "facts/a.md",
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      mtimeMs: 1_700_000_000_123,
    };

    const applied = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [file],
      },
      baseFiles: [],
      currentFiles: [file],
    });

    assert.equal(applied.upserted, 0);
    assert.equal(applied.pendingLocal, 1);
    assert.equal(applied.skipped, 1);
    assert.deepEqual(applied.nextBaseFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset rewrites a same-hash file that vanished before mtime alignment", async () => {
  const root = await tempDir("remnic-offline-apply-changeset-mtime-vanished");
  try {
    const content = Buffer.from("remote fact");
    const file = {
      path: "facts/a.md",
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      mtimeMs: 1_700_000_000_123,
      contentBase64: content.toString("base64"),
    };

    const applied = await applyOfflineSyncChangeset({
      root,
      changeset: {
        format: "remnic.offline-sync.changeset.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "laptop",
        includeTranscripts: true,
        changes: [{
          type: "upsert",
          path: file.path,
          file,
        }],
      },
      currentFiles: [{
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
        mtimeMs: file.mtimeMs,
      }],
    });

    assert.equal(applied.appliedUpserts, 1);
    assert.equal(applied.skipped, 0);
    assert.equal(await readUtf8(root, file.path), content.toString("utf-8"));
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
    const appliedStat = await stat(path.join(root, "state/lcm.sqlite"));
    assert.ok(Math.abs(appliedStat.mtimeMs - 123) <= 1_000);

    const retry = await applyOfflineSyncFileContentChunk({
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
    assert.equal(retry.done, true);
    assert.equal(retry.skipped, true);
    assert.equal(retry.conflict, undefined);

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
    assert.equal(conflict.chunkBytes, 0);
    assert.equal(conflict.applied, false);
    assert.equal(conflict.conflict?.reason, "remote_changed_for_local_update");
    assert.equal(await readUtf8(root, "state/lcm.sqlite"), "new durable sqlite content");

    const partialConflictContent = Buffer.from("another conflicting sqlite payload");
    const partialConflictSha = createHash("sha256").update(partialConflictContent).digest("hex");
    const partialConflict = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: partialConflictSha,
      bytes: partialConflictContent.byteLength,
      mtimeMs: 789,
      offset: 0,
      baseSha256: oldSha,
      content: partialConflictContent.subarray(0, 8),
    });
    assert.equal(partialConflict.done, true);
    assert.equal(partialConflict.chunkBytes, 0);
    assert.equal(partialConflict.applied, false);
    assert.equal(partialConflict.conflict?.reason, "remote_changed_for_local_update");
    assert.equal(await readUtf8(root, "state/lcm.sqlite"), "new durable sqlite content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync chunked apply lets incoming runtime state replace local conflicts", async () => {
  const root = await tempDir("remnic-offline-file-content-runtime");
  try {
    const relPath = "state/memory-lifecycle-ledger.jsonl";
    await write(root, relPath, "local ledger\n");
    const baseSha = createHash("sha256").update("base ledger\n").digest("hex");
    const next = Buffer.from("remote ledger\n");
    const nextSha = createHash("sha256").update(next).digest("hex");

    const result = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "remote",
      path: relPath,
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 123,
      offset: 0,
      baseSha256: baseSha,
      content: next,
    });

    assert.equal(result.done, true);
    assert.equal(result.applied, true);
    assert.equal(result.conflict, undefined);
    assert.equal(await readUtf8(root, relPath), "remote ledger\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync chunked apply skips final conflict when target already matches incoming", async () => {
  const root = await tempDir("remnic-offline-file-content-final-skip");
  try {
    const relPath = "facts/chunked.md";
    await write(root, relPath, "old chunked content");
    const oldSha = createHash("sha256").update("old chunked content").digest("hex");
    const next = Buffer.from("new chunked content that arrives in pieces");
    const nextSha = createHash("sha256").update(next).digest("hex");

    const first = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: relPath,
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 456,
      offset: 0,
      baseSha256: oldSha,
      content: next.subarray(0, 8),
    });
    assert.equal(first.done, false);

    await write(root, relPath, next);
    const second = await applyOfflineSyncFileContentChunk({
      root,
      sourceId: "laptop",
      path: relPath,
      sha256: nextSha,
      bytes: next.byteLength,
      mtimeMs: 456,
      offset: 8,
      baseSha256: oldSha,
      content: next.subarray(8),
    });

    assert.equal(second.done, true);
    assert.equal(second.applied, false);
    assert.equal(second.skipped, true);
    assert.equal(second.conflict, undefined);
    assert.equal(await readUtf8(root, relPath), next.toString("utf-8"));
    assert.equal((await readdir(path.join(root, ".offline-sync", "uploads"))).length, 0);
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

test("offline snapshot apply follows remote deletions for remote-authoritative runtime state", async () => {
  const root = await tempDir("remnic-offline-runtime-delete");
  try {
    const relPath = "state/buffer.json";
    const baseContent = Buffer.from("{\"turns\":[]}");
    const localContent = Buffer.from("{\"turns\":[\"local\"]}");
    await write(root, relPath, localContent);

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [],
      },
      baseFiles: [{
        path: relPath,
        sha256: createHash("sha256").update(baseContent).digest("hex"),
        bytes: baseContent.byteLength,
        mtimeMs: 0,
      }],
    });

    assert.equal(pull.deleted, 1);
    assert.equal(pull.conflicts.length, 0);
    assert.deepEqual(pull.nextBaseFiles, []);
    await assert.rejects(
      () => readFile(path.join(root, relPath)),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply preserves new local runtime files without a base", async () => {
  const root = await tempDir("remnic-offline-runtime-local-create");
  try {
    const relPath = "state/buffer.json";
    const localContent = "{\"turns\":[\"local\"]}";
    await write(root, relPath, localContent);

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [],
      },
      baseFiles: [],
    });

    assert.equal(pull.deleted, 0);
    assert.equal(pull.pendingLocal, 1);
    assert.equal(pull.skipped, 1);
    assert.equal(pull.conflicts.length, 0);
    assert.deepEqual(pull.nextBaseFiles, []);
    assert.equal(await readUtf8(root, relPath), localContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply removes current-only sqlite sidecars when absent remotely", async () => {
  const root = await tempDir("remnic-offline-runtime-sidecar-local-create");
  try {
    await write(root, "state/lcm.sqlite-wal", "stale local wal");
    await write(root, "state/lcm.sqlite-shm", "stale local shm");

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [],
      },
      baseFiles: [],
    });

    assert.equal(pull.deleted, 2);
    assert.equal(pull.pendingLocal, 0);
    assert.equal(pull.skipped, 0);
    assert.equal(pull.conflicts.length, 0);
    assert.deepEqual(pull.nextBaseFiles, []);
    await assert.rejects(
      () => readFile(path.join(root, "state/lcm.sqlite-wal")),
      /ENOENT/,
    );
    await assert.rejects(
      () => readFile(path.join(root, "state/lcm.sqlite-shm")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply restores locally deleted remote-authoritative runtime files", async () => {
  const root = await tempDir("remnic-offline-runtime-local-delete-restore");
  try {
    const relPath = "state/buffer.json";
    const remoteContent = Buffer.from("{\"turns\":[]}");
    const remoteFile = {
      path: relPath,
      sha256: createHash("sha256").update(remoteContent).digest("hex"),
      bytes: remoteContent.byteLength,
      mtimeMs: 1,
      contentBase64: remoteContent.toString("base64"),
    };

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [remoteFile],
      },
      baseFiles: [{
        path: remoteFile.path,
        sha256: remoteFile.sha256,
        bytes: remoteFile.bytes,
        mtimeMs: remoteFile.mtimeMs,
      }],
    });

    assert.equal(pull.upserted, 1);
    assert.equal(pull.conflicts.length, 0);
    assert.equal(await readUtf8(root, relPath), remoteContent.toString("utf-8"));
    assert.deepEqual(pull.nextBaseFiles, [{
      path: remoteFile.path,
      sha256: remoteFile.sha256,
      bytes: remoteFile.bytes,
      mtimeMs: remoteFile.mtimeMs,
    }]);
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

test("offline changeset skips local edits to remote-authoritative runtime state", async () => {
  const local = await tempDir("remnic-offline-runtime-authoritative-push");
  try {
    const relPath = "state/buffer.json";
    const baseContent = Buffer.from("{\"turns\":[]}");
    const localContent = Buffer.from("{\"turns\":[\"local\"]}");
    await write(local, relPath, localContent);
    const baseFile = {
      path: relPath,
      sha256: createHash("sha256").update(baseContent).digest("hex"),
      bytes: baseContent.byteLength,
      mtimeMs: 1,
    };
    const currentFile = {
      path: relPath,
      sha256: createHash("sha256").update(localContent).digest("hex"),
      bytes: localContent.byteLength,
      mtimeMs: 2,
    };

    assert.equal(
      (await summarizeOfflineSyncPendingChanges({
        root: local,
        sourceId: "laptop",
        baseFiles: [baseFile],
      })).total,
      0,
    );

    const changeset = await buildOfflineSyncChangesetFromSnapshot({
      root: local,
      sourceId: "laptop",
      baseFiles: [baseFile],
      currentFiles: [currentFile],
      readFile: async () => {
        throw new Error("runtime state should not be read for push");
      },
    });
    assert.equal(changeset.changes.length, 0);

    assert.equal(
      summarizeOfflineSyncPendingFiles({
        baseFiles: [baseFile],
        currentFiles: [],
      }).total,
      0,
    );
    const deleteChangeset = await buildOfflineSyncChangesetFromSnapshot({
      root: local,
      sourceId: "laptop",
      baseFiles: [baseFile],
      currentFiles: [],
      readFile: async () => {
        throw new Error("deleted runtime state should not be read for push");
      },
    });
    assert.equal(deleteChangeset.changes.length, 0);
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

test("offline pull lets incoming runtime state replace local runtime conflicts", async () => {
  const root = await tempDir("remnic-offline-runtime-authoritative-pull");
  try {
    const relPath = "state/buffer.json";
    const baseContent = Buffer.from("{\"turns\":[]}");
    const localContent = Buffer.from("{\"turns\":[\"local\"]}");
    const remoteContent = Buffer.from("{\"turns\":[\"remote\"]}");
    await write(root, relPath, localContent);
    const baseFile = {
      path: relPath,
      sha256: createHash("sha256").update(baseContent).digest("hex"),
      bytes: baseContent.byteLength,
      mtimeMs: 1,
    };
    const incomingFile = {
      path: relPath,
      sha256: createHash("sha256").update(remoteContent).digest("hex"),
      bytes: remoteContent.byteLength,
      mtimeMs: 2,
      contentBase64: remoteContent.toString("base64"),
    };

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [incomingFile],
      },
      baseFiles: [baseFile],
    });

    assert.equal(pull.upserted, 1);
    assert.equal(pull.conflicts.length, 0);
    assert.equal(await readUtf8(root, relPath), remoteContent.toString("utf-8"));
    assert.deepEqual(pull.nextBaseFiles, [{
      path: relPath,
      sha256: incomingFile.sha256,
      bytes: incomingFile.bytes,
      mtimeMs: incomingFile.mtimeMs,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline pull skips local runtime drift when remote still matches base", async () => {
  const root = await tempDir("remnic-offline-runtime-authoritative-base");
  try {
    const relPath = "state/buffer.json";
    const baseContent = Buffer.from("{\"turns\":[]}");
    const localContent = Buffer.from("{\"turns\":[\"local\"]}");
    await write(root, relPath, localContent);
    const baseFile = {
      path: relPath,
      sha256: createHash("sha256").update(baseContent).digest("hex"),
      bytes: baseContent.byteLength,
      mtimeMs: 1,
    };

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [baseFile],
      },
      baseFiles: [baseFile],
    });

    assert.equal(pull.upserted, 0);
    assert.equal(pull.skipped, 1);
    assert.equal(pull.pendingLocal, 0);
    assert.equal(pull.conflicts.length, 0);
    assert.equal(await readUtf8(root, relPath), localContent.toString("utf-8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline pull treats last intent as remote-authoritative runtime state", async () => {
  const root = await tempDir("remnic-offline-runtime-last-intent");
  try {
    const relPath = "state/last_intent.json";
    const baseContent = Buffer.from("{\"intent\":\"base\"}");
    const localContent = Buffer.from("{\"intent\":\"local\"}");
    const remoteContent = Buffer.from("{\"intent\":\"remote\"}");
    await write(root, relPath, localContent);
    const baseFile = {
      path: relPath,
      sha256: createHash("sha256").update(baseContent).digest("hex"),
      bytes: baseContent.byteLength,
      mtimeMs: 1,
    };
    const incomingFile = {
      path: relPath,
      sha256: createHash("sha256").update(remoteContent).digest("hex"),
      bytes: remoteContent.byteLength,
      mtimeMs: 2,
      contentBase64: remoteContent.toString("base64"),
    };

    assert.equal(shouldPreferIncomingOfflineRuntimeFile(relPath), true);
    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [incomingFile],
      },
      baseFiles: [baseFile],
    });

    assert.equal(pull.upserted, 1);
    assert.equal(pull.conflicts.length, 0);
    assert.equal(await readUtf8(root, relPath), remoteContent.toString("utf-8"));
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("offline pull can record conflicts without hydrating oversized incoming content", async () => {
  const remote = await tempDir("remnic-offline-metadata-conflict-remote");
  const local = await tempDir("remnic-offline-metadata-conflict-local");
  try {
    await write(remote, "state/lcm.sqlite", "base");
    const initial = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: true,
    });
    const firstPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: initial,
    });

    await write(local, "state/lcm.sqlite", "local edit");
    await write(remote, "state/lcm.sqlite", "remote edit");
    const metadataOnly = await buildOfflineSyncSnapshot({
      root: remote,
      sourceId: "remote",
      includeContent: false,
    });

    const secondPull = await applyOfflineSyncSnapshot({
      root: local,
      snapshot: metadataOnly,
      baseFiles: firstPull.nextBaseFiles,
      allowMissingConflictContent: true,
    });

    assert.equal(secondPull.conflicts.length, 1);
    assert.equal(secondPull.conflicts[0]?.reason, "both_modified");
    assert.equal(secondPull.conflicts[0]?.conflictPath, undefined);
    assert.equal(await readUtf8(local, "state/lcm.sqlite"), "local edit");
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

test("offline payloads reject mtimes outside JavaScript Date range", async () => {
  const root = await tempDir("remnic-offline-invalid-mtime");
  try {
    const content = Buffer.from("remote");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const mtimeMs = OFFLINE_SYNC_MAX_MTIME_MS + 1;

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
              path: "facts/remote.md",
              sha256,
              bytes: content.byteLength,
              mtimeMs,
              contentBase64: content.toString("base64"),
            }],
          },
        }),
      /files\[0\]\.mtimeMs must be within JavaScript Date range/,
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
              path: "facts/remote.md",
              file: {
                path: "facts/remote.md",
                sha256,
                bytes: content.byteLength,
                mtimeMs,
                contentBase64: content.toString("base64"),
              },
            }],
          },
        }),
      /offline sync changeset invalid: changes\[0\]\.file\.mtimeMs must be within JavaScript Date range/,
    );

    await assert.rejects(
      () =>
        applyOfflineSyncFileContentChunk({
          root,
          sourceId: "remote",
          path: "facts/remote.md",
          sha256,
          bytes: content.byteLength,
          mtimeMs,
          offset: 0,
          content,
        }),
      /mtimeMs must be within JavaScript Date range/,
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
    assert.deepEqual(
      await storage.digestOfflineSyncFile(path.join(root, "facts", "secure.md")),
      {
        sha256: createHash("sha256").update("secret fact").digest("hex"),
        bytes: Buffer.byteLength("secret fact"),
      },
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
    const encryptedStat = await stat(path.join(root, "facts", "secure.md"));
    assert.notEqual(snapshot.files[0]?.bytes, encryptedStat.size);
    let digestReads = 0;
    const fastBase = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: snapshot.files,
      baseCapturedAt: new Date(),
      readFileDigest: async ({ filePath }) => {
        digestReads += 1;
        return storage.digestOfflineSyncFile(filePath);
      },
    });
    assert.equal(digestReads, 1);
    assert.deepEqual(fastBase.files, snapshot.files.map(({ contentBase64: _contentBase64, ...file }) => file));

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
      readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
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
      readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
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

test("offline storage digest cache avoids repeat reads and invalidates on ctime changes", async () => {
  const root = await tempDir("remnic-offline-digest-cache");
  const relPath = "facts/cache.md";
  const filePath = path.join(root, relPath);
  try {
    await write(root, relPath, "alpha");
    const storage = new StorageManager(root);
    const first = await storage.digestOfflineSyncFile(filePath);

    let headerProbes = 0;
    (storage as unknown as { offlineSyncFileIsEncrypted: () => Promise<boolean> }).offlineSyncFileIsEncrypted =
      async () => {
        headerProbes += 1;
        throw new Error("cache miss");
      };
    assert.deepEqual(await storage.digestOfflineSyncFile(filePath), first);
    assert.equal(headerProbes, 0);

    const before = await stat(filePath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(filePath, "bravo");
    await utimes(filePath, before.atime, before.mtime);

    (storage as unknown as { offlineSyncFileIsEncrypted: () => Promise<boolean> }).offlineSyncFileIsEncrypted =
      async () => {
        headerProbes += 1;
        return false;
      };
    const second = await storage.digestOfflineSyncFile(filePath);
    assert.equal(headerProbes, 1);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(second.bytes, first.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot fast-base does not probe file headers for trusted metadata", async () => {
  const root = await tempDir("remnic-offline-fast-base-no-header-probe");
  const relPath = "facts/same-size.md";
  const content = Buffer.from("fact");
  const filePath = path.join(root, relPath);
  try {
    await write(root, relPath, content);
    await chmod(filePath, 0o000);
    const st = await stat(filePath);
    let digestReads = 0;

    const snapshot = await buildOfflineSyncSnapshotFromBase({
      root,
      sourceId: "remote",
      baseFiles: [{
        path: relPath,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        mtimeMs: st.mtimeMs,
      }],
      baseCapturedAt: new Date(Date.now() + 60_000),
      readFileDigest: async ({ path: targetPath, filePath: targetFilePath }) => {
        assert.equal(targetPath, relPath);
        assert.equal(targetFilePath, filePath);
        digestReads += 1;
        throw new Error("trusted metadata should not read the file header or digest");
      },
    });

    assert.equal(digestReads, 0);
    assert.equal(snapshot.files[0]?.sha256, createHash("sha256").update(content).digest("hex"));
  } finally {
    await chmod(filePath, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
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

test("offline changeset apply fingerprints only changed paths when current files are omitted", async () => {
  const root = await tempDir("remnic-offline-apply-path-scoped");
  try {
    const oldContent = Buffer.from("old target");
    const newContent = Buffer.from("new target");
    await write(root, "facts/target.md", oldContent);
    await write(root, "facts/unrelated.md", "do not scan me");
    const digestPaths: string[] = [];

    const apply = await applyOfflineSyncChangeset({
      root,
      changeset: {
        format: "remnic.offline-sync.changeset.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "laptop",
        includeTranscripts: true,
        changes: [{
          type: "upsert",
          path: "facts/target.md",
          baseSha256: createHash("sha256").update(oldContent).digest("hex"),
          file: {
            path: "facts/target.md",
            sha256: createHash("sha256").update(newContent).digest("hex"),
            bytes: newContent.byteLength,
            mtimeMs: Date.now(),
            contentBase64: newContent.toString("base64"),
          },
        }],
      },
      returnCurrentFiles: false,
      readFileDigest: async ({ path: relPath, filePath }) => {
        digestPaths.push(relPath);
        if (relPath === "facts/unrelated.md") {
          throw new Error("apply scanned an unrelated file");
        }
        const content = await readFile(filePath);
        return {
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    });

    assert.equal(apply.appliedUpserts, 1);
    assert.equal(apply.conflicts.length, 0);
    assert.equal(apply.currentFilesComplete, false);
    assert.deepEqual(digestPaths, ["facts/target.md"]);
    assert.equal(await readUtf8(root, "facts/target.md"), "new target");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset apply returns full current files by default", async () => {
  const root = await tempDir("remnic-offline-apply-full-result");
  try {
    const oldContent = Buffer.from("old target");
    const newContent = Buffer.from("new target");
    await write(root, "facts/target.md", oldContent);
    await write(root, "facts/unrelated.md", "keep me");

    const apply = await applyOfflineSyncChangeset({
      root,
      changeset: {
        format: "remnic.offline-sync.changeset.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "laptop",
        includeTranscripts: true,
        changes: [{
          type: "upsert",
          path: "facts/target.md",
          baseSha256: createHash("sha256").update(oldContent).digest("hex"),
          file: {
            path: "facts/target.md",
            sha256: createHash("sha256").update(newContent).digest("hex"),
            bytes: newContent.byteLength,
            mtimeMs: Date.now(),
            contentBase64: newContent.toString("base64"),
          },
        }],
      },
    });

    assert.equal(apply.currentFilesComplete, undefined);
    assert.deepEqual(
      apply.currentFiles.map((entry) => entry.path),
      ["facts/target.md", "facts/unrelated.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline changeset apply refreshes full current files when caller supplied conflict snapshot", async () => {
  const root = await tempDir("remnic-offline-apply-supplied-current-result");
  try {
    const oldContent = Buffer.from("old target");
    const newContent = Buffer.from("new target");
    await write(root, "facts/target.md", oldContent);
    await write(root, "facts/unrelated.md", "keep me");

    const apply = await applyOfflineSyncChangeset({
      root,
      currentFiles: [{
        path: "facts/target.md",
        sha256: createHash("sha256").update(oldContent).digest("hex"),
        bytes: oldContent.byteLength,
        mtimeMs: 0,
      }],
      changeset: {
        format: "remnic.offline-sync.changeset.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "laptop",
        includeTranscripts: true,
        changes: [{
          type: "upsert",
          path: "facts/target.md",
          baseSha256: createHash("sha256").update(oldContent).digest("hex"),
          file: {
            path: "facts/target.md",
            sha256: createHash("sha256").update(newContent).digest("hex"),
            bytes: newContent.byteLength,
            mtimeMs: Date.now(),
            contentBase64: newContent.toString("base64"),
          },
        }],
      },
    });

    assert.equal(apply.currentFilesComplete, undefined);
    assert.deepEqual(
      apply.currentFiles.map((entry) => entry.path),
      ["facts/target.md", "facts/unrelated.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply defers volatile remote paths without changing local files", async () => {
  const root = await tempDir("remnic-offline-deferred-remote");
  try {
    const relPath = "state/memory-lifecycle-ledger.jsonl";
    const localContent = Buffer.from("base ledger\n");
    const remoteContent = Buffer.from("remote ledger changed during fetch\n");
    await write(root, relPath, localContent);
    const baseFile = {
      path: relPath,
      sha256: createHash("sha256").update(localContent).digest("hex"),
      bytes: localContent.byteLength,
      mtimeMs: 1,
    };
    const incomingFile = {
      path: relPath,
      sha256: createHash("sha256").update(remoteContent).digest("hex"),
      bytes: remoteContent.byteLength,
      mtimeMs: 2,
    };

    const pull = await applyOfflineSyncSnapshot({
      root,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [incomingFile],
      },
      baseFiles: [baseFile],
      deferredPaths: [relPath],
    });

    assert.equal(await readUtf8(root, relPath), localContent.toString("utf-8"));
    assert.equal(pull.upserted, 0);
    assert.equal(pull.deleted, 0);
    assert.equal(pull.skipped, 1);
    assert.equal(pull.conflicts.length, 0);
    assert.deepEqual(pull.nextBaseFiles, [baseFile]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline snapshot apply does not churn metadata for equivalent mtimes", async () => {
  const root = await tempDir("remnic-offline-equivalent-mtime");
  try {
    const relPath = "facts/unchanged.md";
    const content = Buffer.from("same content");
    await write(root, relPath, content);
    const filePath = path.join(root, relPath);
    const baseTime = new Date("2026-05-31T00:00:00.000Z");
    await utimes(filePath, baseTime, baseTime);
    const before = await stat(filePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const incomingMtimeMs = before.mtimeMs + 500;

    const pull = await applyOfflineSyncSnapshot({
      root,
      currentFiles: [{
        path: relPath,
        sha256,
        bytes: content.byteLength,
        mtimeMs: before.mtimeMs,
      }],
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "remote",
        includeTranscripts: true,
        files: [{
          path: relPath,
          sha256,
          bytes: content.byteLength,
          mtimeMs: incomingMtimeMs,
        }],
      },
      baseFiles: [],
    });

    const after = await stat(filePath);
    assert.equal(pull.upserted, 0);
    assert.equal(pull.deleted, 0);
    assert.equal(pull.skipped, 1);
    assert.deepEqual(pull.nextBaseFiles, [{
      path: relPath,
      sha256,
      bytes: content.byteLength,
      mtimeMs: incomingMtimeMs,
    }]);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
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
