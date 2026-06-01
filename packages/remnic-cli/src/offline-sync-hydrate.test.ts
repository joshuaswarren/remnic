import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  type OfflineSyncFileRecord,
  type OfflineSyncFileState,
  type OfflineSyncSnapshot,
} from "@remnic/core";
import {
  directHydrateLargeOfflineFiles,
  OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES,
  OFFLINE_SYNC_SNAPSHOT_BASE_POST_MAX_FILES,
  fetchOfflineSnapshot,
  hydrateOfflineSnapshotContent,
  isOfflineMissingContentDeferrablePath,
  isOfflineSnapshotPostFallbackError,
  resolveOptionalOfflineRemoteUrl,
} from "./index.js";

function fileState(relPath: string, content: string, mtimeMs = 1): OfflineSyncFileState {
  return fileStateFromBuffer(relPath, Buffer.from(content), mtimeMs);
}

function fileStateFromBuffer(relPath: string, buffer: Buffer, mtimeMs = 1): OfflineSyncFileState {
  return {
    path: relPath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.byteLength,
    mtimeMs,
  };
}

function withContent(file: OfflineSyncFileState, content: string): OfflineSyncFileRecord & { contentBase64: string } {
  return {
    ...file,
    contentBase64: Buffer.from(content).toString("base64"),
  };
}

function snapshot(files: readonly OfflineSyncFileRecord[]): OfflineSyncSnapshot & { namespace: string } {
  return {
    namespace: "generalist",
    format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    createdAt: new Date(0).toISOString(),
    sourceId: "remote",
    includeTranscripts: true,
    files: [...files],
  };
}

test("hydrateOfflineSnapshotContent retries omitted changed file content", async () => {
  const remoteFile = fileState("state/buffer.json", "remote-buffer");
  let calls = 0;

  const hydrated = await hydrateOfflineSnapshotContent({
    remoteUrl: "http://example.invalid",
    token: "token",
    namespace: "generalist",
    includeTranscripts: true,
    snapshot: snapshot([remoteFile]),
    baseFiles: [],
    currentFiles: [],
    missingContentRetryMax: 1,
    missingContentRetryDelayMs: 0,
    fetchFiles: async ({ paths }) => {
      calls += 1;
      assert.deepEqual(paths, ["state/buffer.json"]);
      return calls === 1
        ? snapshot([])
        : snapshot([withContent(remoteFile, "remote-buffer")]);
    },
  });

  assert.equal(calls, 2);
  assert.equal(hydrated.files[0]?.contentBase64, Buffer.from("remote-buffer").toString("base64"));
});

test("hydrateOfflineSnapshotContent reports omitted paths after retry budget", async () => {
  const remoteFile = fileState("state/buffer.json", "remote-buffer");
  let calls = 0;

  await assert.rejects(
    hydrateOfflineSnapshotContent({
      remoteUrl: "http://example.invalid",
      token: "token",
      namespace: "generalist",
      includeTranscripts: true,
      snapshot: snapshot([remoteFile]),
      baseFiles: [],
      currentFiles: [],
      missingContentRetryMax: 1,
      missingContentRetryDelayMs: 0,
      fetchFiles: async ({ paths }) => {
        calls += 1;
        assert.deepEqual(paths, ["state/buffer.json"]);
        return snapshot([]);
      },
    }),
    /remote offline content response omitted 1 changed file: state\/buffer\.json; retry sync/,
  );
  assert.equal(calls, 2);
});

test("hydrateOfflineSnapshotContent defers missing live profiling content", async () => {
  const remoteFile = fileState("profiling/recall-live.jsonl", "profile-row");
  const deferredPaths = new Set<string>();

  const hydrated = await hydrateOfflineSnapshotContent({
    remoteUrl: "http://example.invalid",
    token: "token",
    namespace: "generalist",
    includeTranscripts: true,
    snapshot: snapshot([remoteFile]),
    baseFiles: [],
    currentFiles: [],
    missingContentDeferredPaths: deferredPaths,
    missingContentRetryMax: 1,
    missingContentRetryDelayMs: 0,
    fetchFiles: async ({ paths }) => {
      assert.deepEqual(paths, ["profiling/recall-live.jsonl"]);
      return snapshot([]);
    },
  });

  assert.deepEqual([...deferredPaths], ["profiling/recall-live.jsonl"]);
  assert.equal(hydrated.files[0]?.contentBase64, undefined);
});

test("isOfflineMissingContentDeferrablePath recognizes namespace profiling logs", () => {
  assert.equal(isOfflineMissingContentDeferrablePath("profiling/recall-live.jsonl"), true);
  assert.equal(
    isOfflineMissingContentDeferrablePath("namespaces/generalist/profiling/recall-live.jsonl"),
    true,
  );
  assert.equal(isOfflineMissingContentDeferrablePath("facts/profile.md"), false);
});

test("direct hydration accepts append-only growth for remote-authoritative runtime files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-direct-hydrate-"));
  const originalFetch = globalThis.fetch;
  try {
    const original = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES + 128, "r");
    const appended = Buffer.concat([original, Buffer.from("\nappended-after-snapshot")]);
    const remoteFile = fileStateFromBuffer("state/recall_impressions.jsonl", original, 10);
    const remoteSnapshot = snapshot([remoteFile]);
    const writeBuffer = async (filePath: string, content: Buffer): Promise<void> => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    };

    globalThis.fetch = (async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/remnic/v1/offline-sync/file-content");
      const body = JSON.parse(String(init.body ?? "{}")) as {
        path?: string;
        offset?: number;
        length?: number;
      };
      assert.equal(body.path, remoteFile.path);
      const offset = body.offset ?? 0;
      const length = body.length ?? original.byteLength;
      const chunk = original.subarray(offset, Math.min(original.byteLength, offset + length));
      return new Response(new Uint8Array(chunk), {
        status: 200,
        headers: {
          "x-remnic-file-path": encodeURIComponent(remoteFile.path),
          "x-remnic-file-bytes": String(appended.byteLength),
          "x-remnic-file-mtime-ms": "11",
          "x-remnic-chunk-offset": String(offset),
          "x-remnic-chunk-bytes": String(chunk.byteLength),
        },
      });
    }) as typeof fetch;

    const result = await directHydrateLargeOfflineFiles({
      remoteUrl: "http://example.invalid",
      token: "token",
      namespace: "generalist",
      includeTranscripts: true,
      snapshot: remoteSnapshot,
      baseFiles: [],
      currentFiles: [],
      memoryDir,
      readFile: async ({ filePath }) => readFile(filePath),
      writeFile: async ({ filePath, content }) => writeBuffer(filePath, content),
      writeStagingFile: async ({ filePath, content }) => writeBuffer(filePath, content),
      writeFileChunks: async ({ filePath, chunks }) => {
        const buffers: Buffer[] = [];
        for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
        await writeBuffer(filePath, Buffer.concat(buffers));
      },
    });

    assert.deepEqual([...result.hydratedPaths], [remoteFile.path]);
    assert.deepEqual([...result.deferredPaths], []);
    assert.deepEqual(await readFile(path.join(memoryDir, remoteFile.path)), original);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct hydration defers append-tolerant runtime files when the prefix changes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-direct-hydrate-"));
  const originalFetch = globalThis.fetch;
  try {
    const original = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES + 128, "r");
    const changedPrefix = Buffer.concat([
      Buffer.from("rewritten-prefix\n"),
      original.subarray("rewritten-prefix\n".length),
      Buffer.from("\nappended-after-snapshot"),
    ]);
    const remoteFile = fileStateFromBuffer("state/recall_impressions.jsonl", original, 10);
    const remoteSnapshot = snapshot([remoteFile]);

    globalThis.fetch = (async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/remnic/v1/offline-sync/file-content");
      const body = JSON.parse(String(init.body ?? "{}")) as {
        path?: string;
        offset?: number;
        length?: number;
      };
      assert.equal(body.path, remoteFile.path);
      const offset = body.offset ?? 0;
      const length = body.length ?? original.byteLength;
      const chunk = changedPrefix.subarray(offset, Math.min(changedPrefix.byteLength, offset + length));
      return new Response(new Uint8Array(chunk), {
        status: 200,
        headers: {
          "x-remnic-file-path": encodeURIComponent(remoteFile.path),
          "x-remnic-file-bytes": String(changedPrefix.byteLength),
          "x-remnic-file-mtime-ms": "11",
          "x-remnic-chunk-offset": String(offset),
          "x-remnic-chunk-bytes": String(chunk.byteLength),
        },
      });
    }) as typeof fetch;

    const result = await directHydrateLargeOfflineFiles({
      remoteUrl: "http://example.invalid",
      token: "token",
      namespace: "generalist",
      includeTranscripts: true,
      snapshot: remoteSnapshot,
      baseFiles: [],
      currentFiles: [],
      memoryDir,
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
        for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, Buffer.concat(buffers));
      },
    });

    assert.deepEqual([...result.hydratedPaths], []);
    assert.deepEqual([...result.deferredPaths], [remoteFile.path]);
    await assert.rejects(
      readFile(path.join(memoryDir, remoteFile.path)),
      /ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct hydration defers changed non-append runtime files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-direct-hydrate-"));
  const originalFetch = globalThis.fetch;
  try {
    const original = Buffer.alloc(OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES + 128, "b");
    const changed = Buffer.concat([Buffer.from("changed-after-snapshot\n"), original]);
    const remoteFile = fileStateFromBuffer("state/buffer.json", original, 10);
    const remoteSnapshot = snapshot([remoteFile]);

    globalThis.fetch = (async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/remnic/v1/offline-sync/file-content");
      const body = JSON.parse(String(init.body ?? "{}")) as {
        path?: string;
        offset?: number;
        length?: number;
      };
      assert.equal(body.path, remoteFile.path);
      const offset = body.offset ?? 0;
      const length = body.length ?? original.byteLength;
      const chunk = changed.subarray(offset, Math.min(changed.byteLength, offset + length));
      return new Response(new Uint8Array(chunk), {
        status: 200,
        headers: {
          "x-remnic-file-path": encodeURIComponent(remoteFile.path),
          "x-remnic-file-bytes": String(changed.byteLength),
          "x-remnic-file-mtime-ms": "11",
          "x-remnic-chunk-offset": String(offset),
          "x-remnic-chunk-bytes": String(chunk.byteLength),
        },
      });
    }) as typeof fetch;

    const result = await directHydrateLargeOfflineFiles({
      remoteUrl: "http://example.invalid",
      token: "token",
      namespace: "generalist",
      includeTranscripts: true,
      snapshot: remoteSnapshot,
      baseFiles: [],
      currentFiles: [],
      memoryDir,
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
        for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, Buffer.concat(buffers));
      },
    });

    assert.deepEqual([...result.hydratedPaths], []);
    assert.deepEqual([...result.deferredPaths], [remoteFile.path]);
    await assert.rejects(
      readFile(path.join(memoryDir, remoteFile.path)),
      /ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fetchOfflineSnapshot uses base-aware POST at the cached file cutoff", async () => {
  const originalFetch = globalThis.fetch;
  let requestedPath = "";
  try {
    const baseFiles = Array.from(
      { length: OFFLINE_SYNC_SNAPSHOT_BASE_POST_MAX_FILES },
      (_, index): OfflineSyncFileState => ({
        path: `facts/${index}.md`,
        sha256: "a".repeat(64),
        bytes: 1,
        mtimeMs: 1,
      }),
    );
    globalThis.fetch = (async (input, init = {}) => {
      const url = new URL(String(input));
      requestedPath = url.pathname;
      assert.equal(url.pathname, "/remnic/v1/offline-sync/snapshot");
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify(snapshot([])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await fetchOfflineSnapshot({
      remoteUrl: "http://example.invalid",
      token: "token",
      namespace: "generalist",
      includeTranscripts: true,
      includeContent: false,
      baseFiles,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestedPath, "/remnic/v1/offline-sync/snapshot");
});

test("base-aware snapshot POST transport failures can fall back to stream", () => {
  assert.equal(
    isOfflineSnapshotPostFallbackError(
      new Error("offline sync request failed before response: POST /remnic/v1/offline-sync/snapshot - fetch failed"),
    ),
    true,
  );
  assert.equal(
    isOfflineSnapshotPostFallbackError(
      new Error("offline sync request timed out after 420000ms: POST /remnic/v1/offline-sync/snapshot"),
    ),
    true,
  );
  assert.equal(
    isOfflineSnapshotPostFallbackError(
      new Error("offline sync request timed out after 420000ms: POST /api/remnic/v1/offline-sync/snapshot"),
    ),
    true,
  );
  assert.equal(
    isOfflineSnapshotPostFallbackError(
      new Error("offline sync request failed before response: POST /api/remnic/v1/offline-sync/snapshot - fetch failed"),
    ),
    true,
  );
});

test("offline remote URL accepts --remote as an alias", () => {
  assert.equal(
    resolveOptionalOfflineRemoteUrl(["--remote", "http://example.invalid/remnic/"]),
    "http://example.invalid/remnic",
  );
  assert.equal(
    resolveOptionalOfflineRemoteUrl([
      "--remote-url",
      "http://primary.example.invalid",
      "--remote",
      "http://alias.example.invalid",
    ]),
    "http://primary.example.invalid",
  );
});
