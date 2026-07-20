import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES,
  runOfflineSyncOnce,
} from "./index.js";
import { writeOfflineSyncState } from "@remnic/core";
import type { OfflineSyncChangeset } from "@remnic/core";

const IMPRESSIONS_REL = "state/recall_impressions.jsonl";
const PENDING_DIR_REL = "state/recall_impressions.jsonl.pending.d";

// A remote snapshot with no files: the pull phase neither overwrites nor deletes
// the freshly folded local active file, so the fold stays observable after a run.
const EMPTY_REMOTE_SNAPSHOT = {
  format: "remnic.offline-sync.snapshot.v1",
  schemaVersion: 1,
  createdAt: "2026-05-31T00:01:00.000Z",
  sourceId: "remote",
  namespace: "generalist",
  includeTranscripts: true,
  files: [],
};

// Write one durable pending recall-impression spill exactly as
// LastRecallStore.spillImpression() does (#2033): a `<uuid>.jsonl` file inside
// the offline-sync-EXCLUDED pending dir. The unique nonce lets the assertions
// prove this specific row was folded rather than dropped by the exclude.
async function seedPendingImpression(root: string): Promise<string> {
  const nonce = randomUUID();
  const line = JSON.stringify({
    sessionKey: "session-1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    writeNonce: nonce,
    queryHash: "deadbeef",
    queryLen: 5,
    memoryIds: ["mem-1"],
  });
  const pendingDir = path.join(root, PENDING_DIR_REL);
  await mkdir(pendingDir, { recursive: true });
  await writeFile(path.join(pendingDir, `${randomUUID()}.jsonl`), line, "utf-8");
  return nonce;
}

// After a run, the drain must have folded every pending spill into the active
// file: the pending dir is empty and the synced active file carries the row.
async function assertImpressionFolded(root: string, nonce: string): Promise<void> {
  const pendingEntries = await readdir(path.join(root, PENDING_DIR_REL)).catch(() => [] as string[]);
  assert.deepEqual(pendingEntries, [], "every pending spill must be folded and finalized");
  const activeContent = await readFile(path.join(root, IMPRESSIONS_REL), "utf-8");
  assert.ok(activeContent.includes(nonce), "folded impression must land in the synced active file");
}

test("offline sync drains pending impression spills before building the initial push snapshot (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-inline-"));
  const originalFetch = globalThis.fetch;
  try {
    // Only the excluded pending spill exists — the active file does not yet. If
    // the snapshot at index.ts:9051 were built before the drain, the recorded
    // impression would be stranded in the excluded pending dir and never folded.
    const nonce = await seedPendingImpression(root);
    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles: [],
    });

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { changeset?: OfflineSyncChangeset };
        return new Response(JSON.stringify({
          namespace: "generalist",
          appliedUpserts: request.changeset?.changes.length ?? 0,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(EMPTY_REMOTE_SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
    });

    await assertImpressionFolded(root, nonce);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync drains pending impression spills before the post-direct-push changeset snapshot (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-directpush-"));
  const originalFetch = globalThis.fetch;
  try {
    const nonce = await seedPendingImpression(root);

    // A large file forces the direct-push path, so a SECOND push snapshot is
    // rebuilt at index.ts:9222 (guarded by directPushedPaths.size > 0). The
    // drained impression must remain folded on disk across that rebuild.
    const largePath = "facts/large.bin";
    const largeContent = Buffer.alloc(OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, 65);
    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, largePath), largeContent);

    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles: [
        // Present in the base with a different digest so it is a direct-push
        // candidate rather than an unchanged no-op.
        { path: largePath, bytes: OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES, sha256: "b".repeat(64), mtimeMs: 0 },
      ],
    });

    let pushedLargeFile = false;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply-file-content")) {
        pushedLargeFile = true;
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
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { changeset?: OfflineSyncChangeset };
        return new Response(JSON.stringify({
          namespace: "generalist",
          appliedUpserts: request.changeset?.changes.length ?? 0,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(EMPTY_REMOTE_SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
    });

    assert.equal(pushedLargeFile, true, "large file must take the direct-push path that triggers the second snapshot");
    await assertImpressionFolded(root, nonce);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync honors configured impression bounds without rotating into excluded archives (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-rotation-"));
  const originalFetch = globalThis.fetch;
  try {
    // The active file fits below the configured cap, but the pending row would
    // exceed it. A configured bound must defer the spill rather than silently
    // falling back to rotation-off or moving rows into an excluded archive.
    const activePath = path.join(root, IMPRESSIONS_REL);
    await mkdir(path.dirname(activePath), { recursive: true });
    const seeded = `${JSON.stringify({ seeded: "x".repeat(40) })}\n`;
    await writeFile(activePath, seeded, "utf-8");
    const nonce = await seedPendingImpression(root);

    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles: [],
    });

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { changeset?: OfflineSyncChangeset };
        return new Response(JSON.stringify({
          namespace: "generalist",
          appliedUpserts: request.changeset?.changes.length ?? 0,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(EMPTY_REMOTE_SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;


    await assert.rejects(
      () =>
        runOfflineSyncOnce({
          memoryDir: root,
          remoteUrl: "http://remnic.test",
          token: "test-token",
          namespace: "generalist",
          includeTranscripts: true,
          statePath,
          statePathExplicit: true,
          impressionsRotateBytes: 128,
          impressionsRotateKeep: 2,
        }),
      /offline-sync impression drain could not fold pending recall impressions/,
    );
    const pendingEntries = await readdir(path.join(root, PENDING_DIR_REL));
    assert.equal(pendingEntries.length, 1, "the oversized pending spill must remain durable");
    const activeContent = await readFile(activePath, "utf-8");
    assert.equal(activeContent.includes(nonce), false, "deferred rows must not enter the active file");
    assert.equal(await stat(`${activePath}.1`).then(() => true, () => false), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync aborts (never pushes) when the pending impression drain cannot complete (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-abort-"));
  const originalFetch = globalThis.fetch;
  try {
    // A real pending spill is present, but the active impression path is a
    // directory, so every append attempt fails. The durable row cannot be
    // committed, and the drain helper must abort before building a snapshot.
    await mkdir(path.join(root, IMPRESSIONS_REL), { recursive: true });
    await seedPendingImpression(root);

    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles: [],
    });

    let applyCalled = false;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        applyCalled = true;
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    await assert.rejects(
      () =>
        runOfflineSyncOnce({
          memoryDir: root,
          remoteUrl: "http://remnic.test",
          token: "test-token",
          namespace: "generalist",
          includeTranscripts: true,
          statePath,
          statePathExplicit: true,
          impressionsRotateBytes: 0,
          impressionsRotateKeep: 5,
        }),
      /impression drain could not fold pending recall impressions.*aborting snapshot/s,
      "runOfflineSyncOnce aborts when the impression drain cannot complete",
    );
    assert.equal(applyCalled, false, "no snapshot was pushed after the drain aborted");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

const LIFECYCLE_LEDGER_REL = "state/memory-lifecycle-ledger.jsonl";
const LIFECYCLE_PENDING_REL = "state/memory-lifecycle-ledger.jsonl.pending.d";

// Write one durable pending memory-lifecycle spill exactly as
// appendLifecycleEventsSerialized() does when the ledger lock is held (#2033): a
// `<uuid>.jsonl` file inside the offline-sync-EXCLUDED pending dir. The nonce
// proves this specific append-only row was folded rather than dropped.
async function seedPendingLifecycle(root: string): Promise<string> {
  const nonce = randomUUID();
  const line = `${JSON.stringify({ type: "promotion", memoryId: "mem-1", timestamp: "2026-01-01T00:00:00.000Z", nonce })}\n`;
  const pendingDir = path.join(root, LIFECYCLE_PENDING_REL);
  await mkdir(pendingDir, { recursive: true });
  await writeFile(path.join(pendingDir, `${randomUUID()}.jsonl`), line, "utf-8");
  return nonce;
}

test("offline sync folds pending lifecycle spills before building the push snapshot (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-inline-"));
  const originalFetch = globalThis.fetch;
  try {
    // Only the excluded lifecycle pending spill exists. If the snapshot were
    // built before the lifecycle drain, this promotion row would be stranded in
    // the excluded pending dir and dropped on a push-then-discard.
    const nonce = await seedPendingLifecycle(root);
    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles: [],
    });

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { changeset?: OfflineSyncChangeset };
        return new Response(JSON.stringify({
          namespace: "generalist",
          appliedUpserts: request.changeset?.changes.length ?? 0,
          appliedDeletes: 0,
          skipped: 0,
          conflicts: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/remnic/v1/offline-sync/snapshot")) {
        return new Response(JSON.stringify(EMPTY_REMOTE_SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
    });

    const pendingEntries = await readdir(path.join(root, LIFECYCLE_PENDING_REL)).catch(() => [] as string[]);
    assert.deepEqual(pendingEntries, [], "every pending lifecycle spill must be folded and finalized");
    const activeContent = await readFile(path.join(root, LIFECYCLE_LEDGER_REL), "utf-8");
    assert.ok(activeContent.includes(nonce), "folded lifecycle row must land in the synced active ledger");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync aborts (never pushes) when the lifecycle drain cannot complete (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-drain-abort-"));
  const originalFetch = globalThis.fetch;
  try {
    await seedPendingLifecycle(root);
    // The active ledger path is a DIRECTORY, so the fold's append fails on every
    // attempt: the durable row can never be committed, so the drain aborts rather
    // than let runOfflineSyncOnce build and push a snapshot that omits it.
    await mkdir(path.join(root, LIFECYCLE_LEDGER_REL), { recursive: true });

    const statePath = path.join(root, ".offline-sync", "state", "test.json");
    await writeOfflineSyncState(statePath, {
      version: 1,
      remoteId: "http://remnic.test",
      namespace: "generalist",
      includeTranscripts: true,
      lastSyncedAt: "2026-05-31T00:00:00.000Z",
      baseFiles: [],
    });

    let applyCalled = false;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/remnic/v1/offline-sync/apply")) {
        applyCalled = true;
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }) as typeof fetch;

    await assert.rejects(
      () =>
        runOfflineSyncOnce({
          memoryDir: root,
          remoteUrl: "http://remnic.test",
          token: "test-token",
          namespace: "generalist",
          includeTranscripts: true,
          statePath,
          statePathExplicit: true,
          impressionsRotateBytes: 0,
          impressionsRotateKeep: 5,
        }),
      /lifecycle drain could not fold pending memory-lifecycle events.*aborting snapshot/s,
      "runOfflineSyncOnce aborts when the lifecycle drain cannot complete",
    );
    assert.equal(applyCalled, false, "no snapshot was pushed after the lifecycle drain aborted");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
