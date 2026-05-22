import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { syncChanges, watchForChanges } from "../packages/remnic-core/src/sync/index.js";
import type { FileChange } from "../packages/remnic-core/src/sync/index.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail("timed out waiting for watcher condition");
}

test("watchForChanges retries unchanged diffs until onChange succeeds", async () => {
  const sourceDir = mkdtempSync(path.join(os.tmpdir(), "remnic-sync-watch-"));
  const filePath = path.join(sourceDir, "memory.md");
  writeFileSync(filePath, "initial\n");

  const calls: FileChange[][] = [];
  const watcher = watchForChanges(
    {
      sourceDir,
      memoryDir: sourceDir,
      pollIntervalMs: 25,
    },
    (changes) => {
      calls.push(changes);
      if (calls.length === 1) {
        throw new Error("transient ingest failure");
      }
    },
  );

  try {
    writeFileSync(filePath, "updated\n");
    await waitFor(() => calls.length >= 2);

    assert.equal(calls[0]?.[0]?.type, "modified");
    assert.equal(calls[1]?.[0]?.type, "modified");
    assert.equal(calls[0]?.[0]?.currentHash, calls[1]?.[0]?.currentHash);

    await delay(100);
    assert.equal(calls.length, 2);
  } finally {
    watcher.stop();
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("syncChanges preserves existing state when source root scan fails", () => {
  const memoryDir = mkdtempSync(path.join(os.tmpdir(), "remnic-sync-state-"));
  const stateFile = path.join(memoryDir, ".sync-state.json");
  const missingSourceDir = path.join(memoryDir, "missing-source");
  const existingState = {
    fileHashes: { "memory.md": "previous-hash" },
    lastSyncAt: "2026-05-21T00:00:00.000Z",
    version: 1,
  };
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(existingState, null, 2)}\n`);

  try {
    assert.throws(
      () =>
        syncChanges({
          sourceDir: missingSourceDir,
          memoryDir,
          stateFile,
        }),
      /sync scan failed/,
    );
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), existingState);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
