import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OFFLINE_SYNC_APPLY_MAX_BODY_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES,
  defaultOfflineSyncStatePath,
  readOfflineSyncState,
  writeOfflineSyncState,
} from "@remnic/core";
import {
  OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
  OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES,
  OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
  OFFLINE_SYNC_REQUEST_TIMEOUT_DEFAULT_MS,
  OFFLINE_SYNC_SNAPSHOT_BASE_POST_PREFERRED_MAX_BODY_BYTES,
  advanceOfflineBaseFilesForSuccessfulPush,
  chunkOfflineChangesetApplyBatches,
  chunkOfflineFileContentBatches,
  directHydrateLargeOfflineFiles,
  fetchOfflineSnapshot,
  formatOfflineRequestForError,
  formatOfflineLargeFilePushFailureMessage,
  isOfflineSnapshotPostFallbackError,
  offlinePartialHydrationForPaths,
  offlineSnapshotBasePostBody,
  offlineSnapshotBasePostBodyFits,
  offlineSnapshotContentFilesForApply,
  parseOfflineSyncRequestTimeoutMs,
  pushOfflineFileContent,
  pushOfflineFileContentFromChunkReader,
  runOfflineSyncOnce,
  shouldDirectHydrateOfflineFile,
} from "../packages/remnic-cli/src/index.js";
import type { OfflineSyncChangeset, OfflineSyncFileState } from "@remnic/core";

function file(path: string, bytes: number, fill = "0"): OfflineSyncFileState {
  return {
    path,
    bytes,
    sha256: fill.repeat(64),
    mtimeMs: 0,
  };
}

function contentFile(path: string, content: Buffer | string, mtimeMs = 0): OfflineSyncFileState {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    path,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    mtimeMs,
  };
}

test("offline sync file content batches are bounded by expected bytes", () => {
  const batches = chunkOfflineFileContentBatches([
    file("facts/a.md", 5 * 1024 * 1024),
    file("facts/b.md", 4 * 1024 * 1024),
    file("facts/c.md", 1024),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((entry) => entry.path)),
    [["facts/a.md"], ["facts/b.md", "facts/c.md"]],
  );
});

test("offline sync file content batches keep oversized single files fetchable", () => {
  const batches = chunkOfflineFileContentBatches([
    file("facts/large.md", 12 * 1024 * 1024),
    file("facts/small.md", 1024),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((entry) => entry.path)),
    [["facts/large.md"], ["facts/small.md"]],
  );
});

test("offline sync hydration skips oversized conflict copies", () => {
  const base = [
    file("state/lcm.sqlite", 727 * 1024 * 1024, "a"),
    file("facts/update.md", 100, "b"),
  ];
  const current = [
    file("state/lcm.sqlite", 727 * 1024 * 1024, "c"),
    file("facts/update.md", 100, "b"),
  ];
  const snapshot = {
    format: "remnic.offline-sync.snapshot.v1" as const,
    schemaVersion: 1 as const,
    createdAt: "2026-05-31T00:00:00.000Z",
    sourceId: "remote",
    includeTranscripts: true,
    files: [
      file("facts/new.md", 100, "f"),
      file("facts/update.md", 100, "e"),
      file("state/lcm.sqlite", 727 * 1024 * 1024, "d"),
    ],
  };

  const needed = offlineSnapshotContentFilesForApply({
    snapshot,
    baseFiles: base,
    currentFiles: current,
    conflictContentMaxBytes: 8 * 1024 * 1024,
  });

  assert.deepEqual(
    needed.map((entry) => entry.path),
    ["facts/new.md", "facts/update.md"],
  );
});

test("offline sync hydration skips deferred volatile remote files", () => {
  const base = [
    file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "a"),
    file("facts/update.md", 100, "b"),
  ];
  const current = [
    file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "a"),
    file("facts/update.md", 100, "b"),
  ];
  const snapshot = {
    format: "remnic.offline-sync.snapshot.v1" as const,
    schemaVersion: 1 as const,
    createdAt: "2026-05-31T00:00:00.000Z",
    sourceId: "remote",
    includeTranscripts: true,
    files: [
      file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "c"),
      file("facts/update.md", 100, "e"),
    ],
  };

  const needed = offlineSnapshotContentFilesForApply({
    snapshot,
    baseFiles: base,
    currentFiles: current,
    deferredPaths: ["state/memory-lifecycle-ledger.jsonl"],
  });

  assert.deepEqual(
    needed.map((entry) => entry.path),
    ["facts/update.md"],
  );
});

test("offline sync directly hydrates remote-authoritative runtime conflicts", () => {
  assert.equal(
    shouldDirectHydrateOfflineFile({
      incoming: file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "c"),
      base: file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "a"),
      current: file("state/memory-lifecycle-ledger.jsonl", 32 * 1024 * 1024, "b"),
    }),
    true,
  );

  const needed = offlineSnapshotContentFilesForApply({
    snapshot: {
      format: "remnic.offline-sync.snapshot.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "remote",
      includeTranscripts: true,
      files: [file("state/buffer.json", 1024, "c")],
    },
    baseFiles: [file("state/buffer.json", 1024, "a")],
    currentFiles: [file("state/buffer.json", 1024, "b")],
    conflictContentMaxBytes: 1,
  });

  assert.deepEqual(needed.map((entry) => entry.path), ["state/buffer.json"]);

  const restoreDeleted = offlineSnapshotContentFilesForApply({
    snapshot: {
      format: "remnic.offline-sync.snapshot.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "remote",
      includeTranscripts: true,
      files: [file("state/buffer.json", 1024, "a")],
    },
    baseFiles: [file("state/buffer.json", 1024, "a")],
    currentFiles: [],
  });

  assert.deepEqual(restoreDeleted.map((entry) => entry.path), ["state/buffer.json"]);

  const unchangedRemote = offlineSnapshotContentFilesForApply({
    snapshot: {
      format: "remnic.offline-sync.snapshot.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "remote",
      includeTranscripts: true,
      files: [file("state/buffer.json", 1024, "a")],
    },
    baseFiles: [file("state/buffer.json", 1024, "a")],
    currentFiles: [file("state/buffer.json", 1024, "b")],
  });

  assert.deepEqual(unchangedRemote.map((entry) => entry.path), []);
});

test("offline sync request diagnostics validate timeout env and include endpoint", () => {
  assert.equal(parseOfflineSyncRequestTimeoutMs(undefined), OFFLINE_SYNC_REQUEST_TIMEOUT_DEFAULT_MS);
  assert.equal(parseOfflineSyncRequestTimeoutMs("1500"), 1500);
  assert.throws(
    () => parseOfflineSyncRequestTimeoutMs("999"),
    /REMNIC_OFFLINE_REQUEST_TIMEOUT_MS must be an integer >= 1000/,
  );
  assert.equal(
    formatOfflineRequestForError("http://localhost:4318/remnic/v1/offline-sync/files?namespace=generalist", {
      method: "post",
    }),
    "POST /remnic/v1/offline-sync/files?namespace=generalist",
  );
});

test("offline sync snapshot post falls back when base payload is too large", () => {
  const smallBody = offlineSnapshotBasePostBody({
    namespace: "generalist",
    includeTranscripts: true,
    baseFiles: [file("facts/a.md", 1)],
  });
  assert.equal(offlineSnapshotBasePostBodyFits(smallBody), true);

  const hugeButServerAcceptedBody = JSON.stringify({
    baseFiles: "x".repeat(OFFLINE_SYNC_SNAPSHOT_BASE_POST_PREFERRED_MAX_BODY_BYTES),
  });
  assert.equal(offlineSnapshotBasePostBodyFits(hugeButServerAcceptedBody), false);

  const largeBody = JSON.stringify({
    baseFiles: "x".repeat(OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES),
  });
  assert.equal(offlineSnapshotBasePostBodyFits(largeBody), false);

  assert.equal(
    isOfflineSnapshotPostFallbackError(
      new Error("offline sync request failed: POST /remnic/v1/offline-sync/snapshot returned 413 Payload Too Large"),
    ),
    true,
  );
  assert.equal(
    isOfflineSnapshotPostFallbackError(
      new Error("offline sync request failed: POST /remnic/v1/offline-sync/snapshot returned 500 Internal Server Error"),
    ),
    false,
  );
});

test("offline sync uses snapshot stream when fast-base payload is too large", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const baseFiles = Array.from({ length: 150_000 }, (_, index) =>
      file(`facts/${String(index).padStart(6, "0")}.md`, index + 1));
    const remoteFile = file("facts/remote.md", 42, "b");
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      assert.equal(url.pathname, "/remnic/v1/offline-sync/snapshot-stream");
      const body = [
        JSON.stringify({
          type: "snapshot",
          namespace: "generalist",
          format: "remnic.offline-sync.snapshot.v1",
          schemaVersion: 1,
          createdAt: "2026-05-31T00:01:00.000Z",
          sourceId: "remote",
          includeTranscripts: true,
        }),
        JSON.stringify({ type: "file", file: remoteFile }),
      ].join("\n");
      return new Response(`${body}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }) as typeof fetch;

    const snapshot = await fetchOfflineSnapshot({
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      includeContent: false,
      baseFiles,
    });

    assert.equal(snapshot.namespace, "generalist");
    assert.deepEqual(snapshot.files, [remoteFile]);
    assert.deepEqual(calls, [
      "/remnic/v1/offline-sync/snapshot-stream?namespace=generalist&include_transcripts=true&content=false",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline sync large-file push failures are explicit", () => {
  assert.equal(
    formatOfflineLargeFilePushFailureMessage([
      { path: "state/lcm.sqlite", error: "offline sync request failed: 500" },
    ]),
    "offline sync large-file push failed for 1 file: state/lcm.sqlite: offline sync request failed: 500",
  );
});

test("offline sync verifies local chunks before accepting idempotent direct-push skips", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-direct-push-skip-"));
  const originalFetch = globalThis.fetch;
  try {
    const relPath = "state/large.bin";
    const filePath = path.join(root, relPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from("abcdef"));
    const fileStat = await stat(filePath);
    const expected = Buffer.from("abcdef");
    const stale = Buffer.from("abcXYZ");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        path: relPath,
        sha256: createHash("sha256").update(expected).digest("hex"),
        bytes: expected.byteLength,
        mtimeMs: fileStat.mtimeMs,
        offset: 0,
        chunkBytes: 0,
        done: true,
        applied: false,
        skipped: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await assert.rejects(
      pushOfflineFileContentFromChunkReader({
        remoteUrl: "http://remnic.test",
        token: "test-token",
        includeTranscripts: true,
        memoryDir: root,
        sourceId: "laptop",
        file: {
          path: relPath,
          sha256: createHash("sha256").update(expected).digest("hex"),
          bytes: expected.byteLength,
          mtimeMs: fileStat.mtimeMs,
        },
        readFileChunks: async function* () {
          yield stale.subarray(0, 3);
          yield stale.subarray(3);
        },
      }),
      /local file changed while pushing offline content/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync fallback uploader verifies local content before accepting idempotent skips", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-direct-push-fallback-skip-"));
  const originalFetch = globalThis.fetch;
  try {
    const relPath = "state/large.bin";
    const filePath = path.join(root, relPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const expected = Buffer.from("abcdef");
    const stale = Buffer.from("abcXYZ");
    await writeFile(filePath, expected);
    const fileStat = await stat(filePath);
    await writeFile(filePath, stale);
    await utimes(filePath, fileStat.atime, fileStat.mtime);
    const changedStat = await stat(filePath);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        path: relPath,
        sha256: createHash("sha256").update(expected).digest("hex"),
        bytes: expected.byteLength,
        mtimeMs: changedStat.mtimeMs,
        offset: 0,
        chunkBytes: 0,
        done: true,
        applied: false,
        skipped: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await assert.rejects(
      pushOfflineFileContent({
        remoteUrl: "http://remnic.test",
        token: "test-token",
        includeTranscripts: true,
        memoryDir: root,
        sourceId: "laptop",
        file: {
          path: relPath,
          sha256: createHash("sha256").update(expected).digest("hex"),
          bytes: expected.byteLength,
          mtimeMs: changedStat.mtimeMs,
        },
      }),
      /local file changed while pushing offline content/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync large-file upload chunks stay below the protocol maximum", () => {
  assert.equal(
    OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  );
  assert.equal(
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
    8 * 1024 * 1024,
  );
  assert.ok(
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES < OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  );
});

test("offline sync apply changesets are split below the daemon JSON body budget", () => {
  const changeset: OfflineSyncChangeset = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: "2026-05-23T00:00:00.000Z",
    sourceId: "test",
    includeTranscripts: true,
    changes: Array.from({ length: 5 }, (_, index) => {
      const content = Buffer.alloc(24 * 1024, index + 1);
      return {
        type: "upsert",
        path: `facts/${index}.md`,
        file: {
          path: `facts/${index}.md`,
          sha256: "0".repeat(64),
          bytes: content.length,
          mtimeMs: index,
          contentBase64: content.toString("base64"),
        },
      };
    }),
  };

  const batches = chunkOfflineChangesetApplyBatches(changeset, "generalist");

  assert.equal(batches.length, 1);
  assert.ok(OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES < OFFLINE_SYNC_APPLY_MAX_BODY_BYTES);
  const tightBatches = chunkOfflineChangesetApplyBatches(changeset, "generalist", 96 * 1024);
  assert.ok(tightBatches.length > 1);
  assert.equal(
    tightBatches.reduce((total, batch) => total + batch.changes.length, 0),
    changeset.changes.length,
  );
  for (const batch of tightBatches) {
    assert.ok(
      Buffer.byteLength(JSON.stringify({
        namespace: "generalist",
        changeset: batch,
      }), "utf-8") <= 96 * 1024,
    );
  }
});

test("offline sync direct push threshold avoids an inline body-size gap", () => {
  assert.ok(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES < 16 * 1024 * 1024);
  assert.equal(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES);
  const inlineBytes = OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES - 1;
  const content = Buffer.alloc(inlineBytes, 1);
  const changeset: OfflineSyncChangeset = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: "2026-05-23T00:00:00.000Z",
    sourceId: "test",
    includeTranscripts: true,
    changes: [
      {
        type: "upsert",
        path: "state/mid-size.bin",
        file: {
          path: "state/mid-size.bin",
          sha256: "0".repeat(64),
          bytes: content.length,
          mtimeMs: 1,
          contentBase64: content.toString("base64"),
        },
      },
    ],
  };

  const batches = chunkOfflineChangesetApplyBatches(changeset, "generalist");

  assert.equal(batches.length, 1);
  assert.ok(
    Buffer.byteLength(JSON.stringify({
      namespace: "generalist",
      changeset: batches[0],
    }), "utf-8") <= OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
  );
});

test("offline sync direct hydration covers remote mid-size files", () => {
  const incoming = file("state/remote-mid-size.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES);

  assert.equal(
    shouldDirectHydrateOfflineFile({ incoming }),
    true,
  );
  assert.equal(
    shouldDirectHydrateOfflineFile({
      incoming,
      current: { ...incoming },
    }),
    false,
  );
  assert.equal(
    shouldDirectHydrateOfflineFile({
      incoming: file("state/inline.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES - 1),
    }),
    false,
  );
  assert.equal(
    shouldDirectHydrateOfflineFile({
      incoming: file("namespaces/team/state/embeddings.json", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, "b"),
      base: file("namespaces/team/state/embeddings.json", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, "b"),
    }),
    true,
  );
});

test("offline sync direct hydration defers apply conflicts from stale local snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-direct-hydrate-conflict-"));
  const originalFetch = globalThis.fetch;
  try {
    const relPath = "state/remote-large.bin";
    const filePath = path.join(root, relPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const baseContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, 1);
    const localEdit = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, 2);
    const remoteContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, 3);
    await writeFile(filePath, localEdit);
    const incoming: OfflineSyncFileState = {
      path: relPath,
      sha256: createHash("sha256").update(remoteContent).digest("hex"),
      bytes: remoteContent.byteLength,
      mtimeMs: 123,
    };
    const baseFile: OfflineSyncFileState = {
      path: relPath,
      sha256: createHash("sha256").update(baseContent).digest("hex"),
      bytes: baseContent.byteLength,
      mtimeMs: 100,
    };

    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as { offset?: number; length?: number };
      const offset = request.offset ?? 0;
      const length = request.length ?? remoteContent.byteLength;
      const content = remoteContent.subarray(offset, Math.min(remoteContent.byteLength, offset + length));
      return new Response(content, {
        status: 200,
        headers: {
          "x-remnic-file-path": encodeURIComponent(relPath),
          "x-remnic-file-sha256": incoming.sha256,
          "x-remnic-file-bytes": String(incoming.bytes),
          "x-remnic-file-mtime-ms": String(incoming.mtimeMs),
          "x-remnic-chunk-offset": String(offset),
          "x-remnic-chunk-bytes": String(content.length),
        },
      });
    }) as typeof fetch;

    const result = await directHydrateLargeOfflineFiles({
      remoteUrl: "http://remnic.test",
      token: "test-token",
      includeTranscripts: true,
      snapshot: {
        format: "remnic.offline-sync.snapshot.v1",
        schemaVersion: 1,
        createdAt: "2026-05-31T00:00:00.000Z",
        sourceId: "remote",
        includeTranscripts: true,
        files: [incoming],
      },
      baseFiles: [baseFile],
      currentFiles: [baseFile],
      memoryDir: root,
      readFile: async ({ filePath }) => readFile(filePath),
      writeFile: async ({ filePath, content }) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content);
      },
      writeStagingFile: async ({ filePath, content }) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content);
      },
      writeFileChunks: async ({ filePath, chunks }) => {
        const buffers: Buffer[] = [];
        for await (const chunk of chunks) buffers.push(chunk);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, Buffer.concat(buffers));
      },
    });

    assert.deepEqual([...result.hydratedPaths], []);
    assert.deepEqual([...result.deferredPaths], [relPath]);
    assert.deepEqual(await readFile(filePath), localEdit);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync re-snapshots local files after push before applying pull", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-resnapshot-pull-"));
  const originalFetch = globalThis.fetch;
  try {
    const targetPath = "facts/target.md";
    const pushPath = "facts/push.md";
    const baseTarget = "base target";
    const basePush = "base push";
    const localPush = "local push";
    const lateLocalTarget = "late local target";
    const remoteTarget = "remote target";

    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, targetPath), baseTarget);
    await writeFile(path.join(root, pushPath), localPush);

    const baseFiles = [
      contentFile(pushPath, basePush, 1),
      contentFile(targetPath, baseTarget, 1),
    ];
    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles,
    });

    const remoteTargetFile = contentFile(targetPath, remoteTarget, 2);
    const remotePushFile = contentFile(pushPath, localPush, 2);
    const remoteSnapshot = {
      format: "remnic.offline-sync.snapshot.v1" as const,
      schemaVersion: 1 as const,
      createdAt: "2026-05-31T00:01:00.000Z",
      sourceId: "remote",
      namespace: "generalist",
      includeTranscripts: true,
      files: [remotePushFile, remoteTargetFile],
    };

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        await writeFile(path.join(root, targetPath), lateLocalTarget);
        return new Response(JSON.stringify({
          namespace: "generalist",
          appliedUpserts: 1,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(remoteSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/files")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { paths?: string[] };
        const files = (request.paths ?? []).map((relPath) => {
          if (relPath === targetPath) {
            return {
              ...remoteTargetFile,
              contentBase64: Buffer.from(remoteTarget).toString("base64"),
            };
          }
          if (relPath === pushPath) {
            return {
              ...remotePushFile,
              contentBase64: Buffer.from(localPush).toString("base64"),
            };
          }
          throw new Error(`unexpected offline file request: ${relPath}`);
        });
        return new Response(JSON.stringify({
          ...remoteSnapshot,
          files,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
    });

    assert.equal(result.pushed?.appliedUpserts, 1);
    assert.deepEqual(result.pull?.conflicts.map((conflict) => conflict.path), [targetPath]);
    assert.equal(await readFile(path.join(root, targetPath), "utf-8"), lateLocalTarget);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync re-snapshots local files after hydrating pull content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-resnapshot-hydrate-"));
  const originalFetch = globalThis.fetch;
  try {
    const targetPath = "facts/target.md";
    const baseTarget = "base target";
    const lateLocalTarget = "late local target";
    const remoteTarget = "remote target";

    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, targetPath), baseTarget);

    const baseFiles = [contentFile(targetPath, baseTarget, 1)];
    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles,
    });

    const remoteTargetFile = contentFile(targetPath, remoteTarget, 2);
    const remoteSnapshot = {
      format: "remnic.offline-sync.snapshot.v1" as const,
      schemaVersion: 1 as const,
      createdAt: "2026-05-31T00:01:00.000Z",
      sourceId: "remote",
      namespace: "generalist",
      includeTranscripts: true,
      files: [remoteTargetFile],
    };

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(remoteSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/files")) {
        await writeFile(path.join(root, targetPath), lateLocalTarget);
        const request = JSON.parse(String(init?.body ?? "{}")) as { paths?: string[] };
        assert.deepEqual(request.paths, [targetPath]);
        return new Response(JSON.stringify({
          ...remoteSnapshot,
          files: [{
            ...remoteTargetFile,
            contentBase64: Buffer.from(remoteTarget).toString("base64"),
          }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
    });

    assert.deepEqual(result.pull?.conflicts.map((conflict) => conflict.path), [targetPath]);
    assert.equal(await readFile(path.join(root, targetPath), "utf-8"), lateLocalTarget);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync re-snapshots inline changes after direct pushes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-resnapshot-inline-"));
  const originalFetch = globalThis.fetch;
  try {
    const largePath = "facts/large.bin";
    const inlinePath = "facts/inline.md";
    const inlineBase = "inline base";
    const inlineBefore = "inline before";
    const inlineAfter = "inline after direct push";
    const largeContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, 65);

    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, largePath), largeContent);
    await writeFile(path.join(root, inlinePath), inlineBefore);

    const baseFiles = [
      file(largePath, OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, "b"),
      contentFile(inlinePath, inlineBase, 1),
    ];
    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles,
    });

    const remoteLargeFile = contentFile(largePath, largeContent, 2);
    const remoteInlineFile = contentFile(inlinePath, inlineAfter, 2);
    const remoteSnapshot = {
      format: "remnic.offline-sync.snapshot.v1" as const,
      schemaVersion: 1 as const,
      createdAt: "2026-05-31T00:01:00.000Z",
      sourceId: "remote",
      namespace: "generalist",
      includeTranscripts: true,
      files: [remoteLargeFile, remoteInlineFile],
    };

    let pushedLargeFile = false;
    let pushedInlineAfter = false;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply-file-content")) {
        pushedLargeFile = true;
        await writeFile(path.join(root, inlinePath), inlineAfter);
        const headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          path: headers["x-remnic-file-path"],
          sha256: headers["x-remnic-file-sha256"],
          bytes: Number(headers["x-remnic-file-bytes"]),
          mtimeMs: Number(headers["x-remnic-file-mtime-ms"]),
          offset: Number(headers["x-remnic-chunk-offset"]),
          chunkBytes: OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
          done: true,
          applied: true,
          skipped: false,
          namespace: "generalist",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { changeset?: OfflineSyncChangeset };
        const changes = request.changeset?.changes ?? [];
        assert.equal(changes.length, 1);
        const change = changes[0];
        assert.equal(change?.type, "upsert");
        assert.equal(change?.path, inlinePath);
        if (change?.type === "upsert") {
          assert.equal(Buffer.from(change.file.contentBase64, "base64").toString("utf-8"), inlineAfter);
        }
        pushedInlineAfter = true;
        return new Response(JSON.stringify({
          namespace: "generalist",
          appliedUpserts: 1,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(remoteSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
    });

    assert.equal(pushedLargeFile, true);
    assert.equal(pushedInlineAfter, true);
    assert.equal(result.pushed?.appliedUpserts, 2);
    assert.deepEqual(result.deferred.localChangedDuringPush, []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync can advance pushed-path baselines when pull is deferred", () => {
  const base = [
    file("facts/old.md", 100, "a"),
    file("facts/delete.md", 100, "b"),
    file("state/direct.bin", OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, "c"),
    file("facts/conflict.md", 100, "d"),
  ];
  const current = [
    file("facts/old.md", 120, "e"),
    file("state/direct.bin", OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, "f"),
    file("facts/conflict.md", 130, "g"),
  ];
  const next = advanceOfflineBaseFilesForSuccessfulPush({
    baseFiles: base,
    currentFiles: current,
    directPushedPaths: ["state/direct.bin"],
    changeset: {
      format: "remnic.offline-sync.changeset.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "laptop",
      includeTranscripts: true,
      changes: [
        {
          type: "upsert",
          path: "facts/old.md",
          baseSha256: base[0]!.sha256,
          file: {
            ...current[0]!,
            contentBase64: Buffer.from("updated").toString("base64"),
          },
        },
        {
          type: "delete",
          path: "facts/delete.md",
          baseSha256: base[1]!.sha256,
        },
        {
          type: "upsert",
          path: "facts/conflict.md",
          baseSha256: base[3]!.sha256,
          file: {
            ...current[2]!,
            contentBase64: Buffer.from("conflict").toString("base64"),
          },
        },
      ],
    },
    conflicts: [{ path: "facts/conflict.md" }],
  });

  assert.deepEqual(
    next.map((entry) => [entry.path, entry.sha256]),
    [
      ["facts/conflict.md", "d".repeat(64)],
      ["facts/old.md", "e".repeat(64)],
      ["state/direct.bin", "f".repeat(64)],
    ],
  );
});

test("offline sync partial checkpoints preserve directly hydrated files", () => {
  const base = [
    file("facts/local.md", 100, "a"),
  ];
  const current = [
    file("facts/local.md", 110, "b"),
  ];
  const hydrated = file("state/remote-large.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, "c");

  const next = advanceOfflineBaseFilesForSuccessfulPush({
    baseFiles: base,
    currentFiles: current,
    hydratedFiles: [hydrated],
    changeset: {
      format: "remnic.offline-sync.changeset.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "laptop",
      includeTranscripts: true,
      changes: [
        {
          type: "upsert",
          path: "facts/local.md",
          baseSha256: base[0]!.sha256,
          file: {
            ...current[0]!,
            contentBase64: Buffer.from("updated").toString("base64"),
          },
        },
      ],
    },
  });

  assert.deepEqual(
    next.map((entry) => [entry.path, entry.sha256]),
    [
      ["facts/local.md", "b".repeat(64)],
      ["state/remote-large.bin", "c".repeat(64)],
    ],
  );
});

test("offline sync partial checkpoints preserve hydration progress after aborts", () => {
  const hydrated = file("state/remote-large-a.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, "a");
  const deferred = file("state/remote-large-b.bin", OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, "b");
  const partial = offlinePartialHydrationForPaths({
    files: [deferred, hydrated],
    hydratedPaths: new Set([hydrated.path]),
    deferredPaths: new Set([deferred.path]),
  });

  assert.deepEqual(
    partial.hydratedFiles.map((entry) => entry.path),
    [hydrated.path],
  );
  assert.deepEqual(partial.remoteDeferredPaths, [deferred.path]);

  const next = advanceOfflineBaseFilesForSuccessfulPush({
    baseFiles: [],
    currentFiles: [],
    hydratedFiles: partial.hydratedFiles,
    changeset: {
      format: "remnic.offline-sync.changeset.v1",
      schemaVersion: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      sourceId: "laptop",
      includeTranscripts: true,
      changes: [],
    },
  });

  assert.deepEqual(
    next.map((entry) => [entry.path, entry.sha256]),
    [[hydrated.path, hydrated.sha256]],
  );
});

test("offline sync partial push checkpoints resolve namespace like successful sync", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-partial-push-namespace-"));
  const originalFetch = globalThis.fetch;
  const remoteUrl = "http://remnic.test";
  const namespace = "generalist";
  const statePath = defaultOfflineSyncStatePath(root, remoteUrl, namespace);
  try {
    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, "facts/large.bin"), Buffer.alloc(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, 65));

    let pushedLargeFile = false;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/remnic/v1/offline-sync/apply-file-content") {
        pushedLargeFile = true;
        return new Response(JSON.stringify({
          path: "facts/large.bin",
          sha256: "a".repeat(64),
          bytes: OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
          mtimeMs: 0,
          offset: 0,
          chunkBytes: OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
          done: true,
          applied: true,
          skipped: false,
          namespace: "   ",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/remnic/v1/offline-sync/snapshot") {
        return new Response("temporary snapshot outage", { status: 503, statusText: "Service Unavailable" });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl,
      token: "test-token",
      namespace,
      includeTranscripts: true,
      statePath,
      statePathExplicit: false,
    });

    assert.equal(pushedLargeFile, true);
    assert.equal(result.partial, true);
    assert.equal(result.namespace, namespace);
    assert.equal(result.statePath, statePath);
    const state = await readOfflineSyncState(statePath);
    assert.equal(state?.namespace, namespace);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync checkpoints successful direct pushes before later upload failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-partial-direct-push-failure-"));
  const originalFetch = globalThis.fetch;
  const remoteUrl = "http://remnic.test";
  const namespace = "generalist";
  const statePath = defaultOfflineSyncStatePath(root, remoteUrl, namespace);
  try {
    const firstPath = "facts/a-large.bin";
    const secondPath = "facts/b-large.bin";
    const firstContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, 65);
    const secondContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, 66);
    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, firstPath), firstContent);
    await writeFile(path.join(root, secondPath), secondContent);
    const firstFile = contentFile(firstPath, firstContent);

    const pushedPaths: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/remnic/v1/offline-sync/apply-file-content") {
        const headers = new Headers(init?.headers);
        const targetPath = decodeURIComponent(headers.get("x-remnic-file-path") ?? "");
        pushedPaths.push(targetPath);
        if (targetPath === secondPath) {
          return new Response("temporary upload outage", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return new Response(JSON.stringify({
          path: targetPath,
          sha256: headers.get("x-remnic-file-sha256"),
          bytes: Number(headers.get("x-remnic-file-bytes")),
          mtimeMs: Number(headers.get("x-remnic-file-mtime-ms")),
          offset: Number(headers.get("x-remnic-chunk-offset")),
          chunkBytes: Number(headers.get("x-remnic-file-bytes")),
          done: true,
          applied: true,
          skipped: false,
          namespace,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl,
      token: "test-token",
      namespace,
      includeTranscripts: true,
      statePath,
      statePathExplicit: false,
    });

    assert.deepEqual(pushedPaths, [firstPath, secondPath]);
    assert.equal(result.partial, true);
    assert.equal(result.pushed?.appliedUpserts, 1);
    assert.match(result.pullError ?? "", /offline sync large-file push failed.*facts\/b-large\.bin/);
    const state = await readOfflineSyncState(statePath);
    assert.deepEqual(state?.baseFiles.map((entry) => entry.path), [firstPath]);
    assert.equal(state?.baseFiles[0]?.sha256, firstFile.sha256);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync checkpoints successful inline batches before later apply failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-partial-inline-apply-failure-"));
  const originalFetch = globalThis.fetch;
  const remoteUrl = "http://remnic.test";
  const namespace = "generalist";
  const statePath = defaultOfflineSyncStatePath(root, remoteUrl, namespace);
  try {
    const firstPath = "facts/a-inline.bin";
    const secondPath = "facts/b-inline.bin";
    const firstContent = Buffer.alloc(4 * 1024 * 1024, 65);
    const secondContent = Buffer.alloc(4 * 1024 * 1024, 66);
    assert.ok(firstContent.byteLength < OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES);
    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, firstPath), firstContent);
    await writeFile(path.join(root, secondPath), secondContent);
    const firstFile = contentFile(firstPath, firstContent);

    const appliedBatches: string[][] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/remnic/v1/offline-sync/apply") {
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          changeset?: { changes?: Array<{ path: string }> };
        };
        const paths = request.changeset?.changes?.map((change) => change.path) ?? [];
        appliedBatches.push(paths);
        assert.ok(
          Buffer.byteLength(String(init?.body ?? ""), "utf-8") <= OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
        );
        if (paths.includes(secondPath)) {
          return new Response("temporary apply outage", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return new Response(JSON.stringify({
          namespace,
          appliedUpserts: paths.length,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl,
      token: "test-token",
      namespace,
      includeTranscripts: true,
      statePath,
      statePathExplicit: false,
    });

    assert.deepEqual(appliedBatches, [[firstPath], [secondPath]]);
    assert.equal(result.partial, true);
    assert.equal(result.pushed?.appliedUpserts, 1);
    assert.match(result.pullError ?? "", /offline-sync\/apply returned 503/);
    const state = await readOfflineSyncState(statePath);
    assert.deepEqual(state?.baseFiles.map((entry) => entry.path), [firstPath]);
    assert.equal(state?.baseFiles[0]?.sha256, firstFile.sha256);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync partial pull checkpoints directly hydrated files without a push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-partial-pull-hydrate-"));
  const originalFetch = globalThis.fetch;
  const remoteUrl = "http://remnic.test";
  const namespace = "generalist";
  const statePath = defaultOfflineSyncStatePath(root, remoteUrl, namespace);
  try {
    const largePath = "facts/large.bin";
    const smallPath = "facts/small.md";
    const largeContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, 76);
    const smallContent = Buffer.from("small remote");
    const remoteLargeFile = contentFile(largePath, largeContent, 2);
    const remoteSmallFile = contentFile(smallPath, smallContent, 2);
    const remoteSnapshot = {
      format: "remnic.offline-sync.snapshot.v1" as const,
      schemaVersion: 1 as const,
      createdAt: "2026-05-31T00:01:00.000Z",
      sourceId: "remote",
      namespace,
      includeTranscripts: true,
      files: [remoteLargeFile, remoteSmallFile],
    };

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/remnic/v1/offline-sync/snapshot") {
        return new Response(JSON.stringify(remoteSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/remnic/v1/offline-sync/file-content") {
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          path?: string;
          offset?: number;
          length?: number;
        };
        assert.equal(request.path, largePath);
        const offset = request.offset ?? 0;
        const length = request.length ?? largeContent.length;
        const chunk = largeContent.subarray(offset, offset + length);
        return new Response(chunk, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-remnic-file-path": encodeURIComponent(largePath),
            "x-remnic-file-sha256": remoteLargeFile.sha256,
            "x-remnic-file-bytes": String(remoteLargeFile.bytes),
            "x-remnic-file-mtime-ms": String(remoteLargeFile.mtimeMs),
            "x-remnic-chunk-offset": String(offset),
            "x-remnic-chunk-bytes": String(chunk.byteLength),
          },
        });
      }
      if (url.pathname === "/remnic/v1/offline-sync/files") {
        return new Response("temporary files outage", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl,
      token: "test-token",
      namespace,
      includeTranscripts: true,
      statePath,
      statePathExplicit: false,
    });

    assert.equal(result.partial, true);
    assert.equal(result.pushed, null);
    assert.equal(result.pull, null);
    assert.match(result.pullError ?? "", /offline-sync\/files returned 503/);
    assert.equal(result.namespace, namespace);
    assert.equal(result.remoteFileCount, 2);
    assert.equal((await readFile(path.join(root, largePath))).byteLength, largeContent.byteLength);
    const state = await readOfflineSyncState(statePath);
    assert.deepEqual(state?.baseFiles.map((entry) => entry.path), [largePath]);
    assert.equal(state?.baseFiles[0]?.sha256, remoteLargeFile.sha256);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync re-snapshots after direct hydration before filtering content fetches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-resnapshot-after-hydrate-"));
  const originalFetch = globalThis.fetch;
  const remoteUrl = "http://remnic.test";
  const namespace = "generalist";
  const statePath = defaultOfflineSyncStatePath(root, remoteUrl, namespace);
  try {
    const largePath = "facts/large.bin";
    const smallPath = "facts/small.md";
    const largeContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES, 77);
    const smallRemote = Buffer.from("small remote");
    const remoteLargeFile = contentFile(largePath, largeContent, 2);
    const remoteSmallFile = contentFile(smallPath, smallRemote, 2);
    const remoteSnapshot = {
      format: "remnic.offline-sync.snapshot.v1" as const,
      schemaVersion: 1 as const,
      createdAt: "2026-05-31T00:01:00.000Z",
      sourceId: "remote",
      namespace,
      includeTranscripts: true,
      files: [remoteLargeFile, remoteSmallFile],
    };

    await mkdir(path.join(root, "facts"), { recursive: true });
    const smallBefore = "small local before hydrate";
    await writeFile(path.join(root, smallPath), smallBefore);
    const smallBeforeStat = await stat(path.join(root, smallPath));
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: remoteUrl,
      namespace,
      includeTranscripts: true,
      lastSyncedAt: new Date().toISOString(),
      baseFiles: [contentFile(smallPath, smallBefore, smallBeforeStat.mtimeMs)],
    });

    let filesEndpointCalled = false;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/remnic/v1/offline-sync/snapshot") {
        return new Response(JSON.stringify(remoteSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/remnic/v1/offline-sync/file-content") {
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          path?: string;
          offset?: number;
          length?: number;
        };
        assert.equal(request.path, largePath);
        const offset = request.offset ?? 0;
        const length = request.length ?? largeContent.length;
        const chunk = largeContent.subarray(offset, offset + length);
        if (offset + chunk.byteLength >= largeContent.byteLength) {
          await writeFile(path.join(root, smallPath), smallRemote);
        }
        return new Response(chunk, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-remnic-file-path": encodeURIComponent(largePath),
            "x-remnic-file-sha256": remoteLargeFile.sha256,
            "x-remnic-file-bytes": String(remoteLargeFile.bytes),
            "x-remnic-file-mtime-ms": String(remoteLargeFile.mtimeMs),
            "x-remnic-chunk-offset": String(offset),
            "x-remnic-chunk-bytes": String(chunk.byteLength),
          },
        });
      }
      if (url.pathname === "/remnic/v1/offline-sync/files") {
        filesEndpointCalled = true;
        return new Response("stale content filter requested files", {
          status: 500,
          statusText: "Unexpected Files Request",
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    const result = await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl,
      token: "test-token",
      namespace,
      includeTranscripts: true,
      statePath,
      statePathExplicit: false,
    });

    assert.equal(filesEndpointCalled, false);
    assert.equal(result.partial, false);
    assert.equal(result.pull?.conflicts.length, 0);
    assert.equal((await readFile(path.join(root, largePath))).byteLength, largeContent.byteLength);
    assert.equal(await readFile(path.join(root, smallPath), "utf-8"), smallRemote.toString("utf-8"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
