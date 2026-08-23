import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256OfflineSyncFile } from "./offline-sync-file-io.js";

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const filePath = path.join(dir, `${name}.txt`);
  await writeFile(filePath, content);
  return filePath;
}

/** The abort guards must surface `name === "AbortError"`, not a plain Error (issue #2795). */
async function assertRejectsWithAbortError(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error, "abort must surface an Error");
    assert.equal(err.name, "AbortError", "abort must preserve the AbortError name");
    return true;
  });
}

test("sha256OfflineSyncFile rejects with AbortError name via the per-chunk guard", async () => {
  const filePath = await tempFile("offline-sync-abort", "chunk-of-bytes");
  const controller = new AbortController();
  controller.abort();
  // A non-empty file yields at least one chunk, so the in-loop guard fires first.
  await assertRejectsWithAbortError(sha256OfflineSyncFile(filePath, controller.signal));
});

test("sha256OfflineSyncFile rejects with AbortError name via the post-loop guard", async () => {
  const filePath = await tempFile("offline-sync-abort-empty", "");
  const controller = new AbortController();
  controller.abort();
  // An empty file yields no chunks, so only the trailing guard runs.
  await assertRejectsWithAbortError(sha256OfflineSyncFile(filePath, controller.signal));
});
