import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  type OfflineSyncFileRecord,
  type OfflineSyncFileState,
  type OfflineSyncSnapshot,
} from "@remnic/core";
import {
  OFFLINE_SYNC_SNAPSHOT_BASE_POST_MAX_FILES,
  fetchOfflineSnapshot,
  hydrateOfflineSnapshotContent,
  isOfflineMissingContentDeferrablePath,
  isOfflineSnapshotPostFallbackError,
  resolveOptionalOfflineRemoteUrl,
} from "./index.js";

function fileState(relPath: string, content: string, mtimeMs = 1): OfflineSyncFileState {
  const buffer = Buffer.from(content);
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
