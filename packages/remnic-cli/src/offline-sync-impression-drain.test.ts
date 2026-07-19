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

test("offline sync drains through a LastRecallStore configured with the caller's rotation bounds, not defaults (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-rotation-"));
  const originalFetch = globalThis.fetch;
  try {
    // Seed an active impressions file already larger than the configured cap so
    // folding one more spilled row must rotate it. With the LastRecallStore
    // default (impressionsRotateBytes = 0, rotation disabled) no `.1` archive
    // would ever appear — its presence proves runOfflineSyncOnce propagated the
    // configured cap into the store instead of falling back to defaults.
    const activePath = path.join(root, IMPRESSIONS_REL);
    await mkdir(path.dirname(activePath), { recursive: true });
    const seeded = `${JSON.stringify({ seeded: "x".repeat(200) })}\n`;
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

    await runOfflineSyncOnce({
      memoryDir: root,
      remoteUrl: "http://remnic.test",
      token: "test-token",
      namespace: "generalist",
      includeTranscripts: true,
      statePath,
      statePathExplicit: true,
      impressionsRotateBytes: 128,
      impressionsRotateKeep: 2,
    });

    // The fold appended the spill under the configured cap, rotating the
    // over-cap active generation into `.1`.
    const archive = await stat(`${activePath}.1`).then(() => true, () => false);
    assert.equal(archive, true, "configured rotation bytes propagated: the over-cap active file rotated into .1");
    // The spilled row was still folded (never dropped) — it lives in the current
    // active generation.
    await assertImpressionFolded(root, nonce);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("offline sync aborts (never pushes) when the pending impression drain cannot complete (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-abort-"));
  const originalFetch = globalThis.fetch;
  try {
    // A file where the pending spill DIRECTORY is expected makes the drain's
    // readdir fail (ENOTDIR) on every attempt: the durable rows can never be
    // folded, so the drain helper aborts rather than let runOfflineSyncOnce build
    // and push a snapshot that silently omits them.
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(path.join(root, PENDING_DIR_REL), "not a directory", "utf-8");

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
