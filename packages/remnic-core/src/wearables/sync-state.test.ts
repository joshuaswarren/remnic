import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  emptySyncState,
  loadSyncState,
  saveSyncState,
  syncStateFilePath,
  updateSourceSyncState,
} from "./sync-state.js";

test("round-trips through disk and tolerates absence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-syncstate-"));
  try {
    assert.deepEqual(await loadSyncState(dir), emptySyncState());
    const updated = updateSourceSyncState(emptySyncState(), "limitless", {
      syncedAt: "2026-06-11T01:00:00.000Z",
      days: ["2026-06-10", "2026-06-11"],
      dayHashes: { "2026-06-10": "aaa", "2026-06-11": "bbb" },
      importedNativeMemoryIds: ["n1", "n2"],
    });
    await saveSyncState(dir, updated);
    const loaded = await loadSyncState(dir);
    assert.equal(loaded.sources.limitless.lastDateSynced, "2026-06-11");
    assert.equal(loaded.sources.limitless.dayHashes["2026-06-10"], "aaa");
    assert.deepEqual(loaded.sources.limitless.importedNativeMemoryIds, ["n1", "n2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file cold-starts instead of bricking sync", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-syncstate-"));
  try {
    const { promises: fsPromises } = await import("node:fs");
    const filePath = syncStateFilePath(dir);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, "{broken", "utf-8");
    assert.deepEqual(await loadSyncState(dir), emptySyncState());
    await fsPromises.writeFile(filePath, "null", "utf-8");
    assert.deepEqual(await loadSyncState(dir), emptySyncState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastDateSynced never moves backwards", () => {
  let state = updateSourceSyncState(emptySyncState(), "bee", {
    syncedAt: "2026-06-11T01:00:00.000Z",
    days: ["2026-06-11"],
    dayHashes: { "2026-06-11": "x" },
  });
  state = updateSourceSyncState(state, "bee", {
    syncedAt: "2026-06-12T01:00:00.000Z",
    days: ["2026-06-01"],
    dayHashes: { "2026-06-01": "y" },
  });
  assert.equal(state.sources.bee.lastDateSynced, "2026-06-11");
  assert.equal(state.sources.bee.lastSyncAt, "2026-06-12T01:00:00.000Z");
});

test("native memory ids are deduplicated and bounded", () => {
  const manyIds = Array.from({ length: 6_000 }, (_, index) => `id-${index}`);
  let state = updateSourceSyncState(emptySyncState(), "omi", {
    syncedAt: "2026-06-11T01:00:00.000Z",
    days: [],
    dayHashes: {},
    importedNativeMemoryIds: manyIds,
  });
  state = updateSourceSyncState(state, "omi", {
    syncedAt: "2026-06-11T02:00:00.000Z",
    days: [],
    dayHashes: {},
    importedNativeMemoryIds: ["id-5999", "fresh"],
  });
  const ids = state.sources.omi.importedNativeMemoryIds;
  assert.ok(ids.length <= 5_000);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  assert.ok(ids.includes("fresh"));
  assert.ok(ids.includes("id-5999"));
});

test("clearMemoryDays removes stale completion records", () => {
  let state = updateSourceSyncState(emptySyncState(), "limitless", {
    syncedAt: "2026-06-11T01:00:00.000Z",
    days: ["2026-06-10"],
    dayHashes: { "2026-06-10": "h1" },
    memoryDayHashes: { "2026-06-10": "h1" },
  });
  assert.equal(state.sources.limitless.memoryDayHashes?.["2026-06-10"], "h1");

  // A later run where the day's memory pass failed must clear the
  // earlier completion record even though the body hash is unchanged.
  state = updateSourceSyncState(state, "limitless", {
    syncedAt: "2026-06-12T01:00:00.000Z",
    days: ["2026-06-10"],
    dayHashes: { "2026-06-10": "h1" },
    clearMemoryDays: ["2026-06-10"],
  });
  assert.equal(state.sources.limitless.memoryDayHashes?.["2026-06-10"], undefined);

  // A clear for a day that completed in the same run is a no-op.
  state = updateSourceSyncState(state, "limitless", {
    syncedAt: "2026-06-13T01:00:00.000Z",
    days: ["2026-06-10"],
    dayHashes: { "2026-06-10": "h1" },
    memoryDayHashes: { "2026-06-10": "h1" },
    clearMemoryDays: ["2026-06-10"],
  });
  assert.equal(state.sources.limitless.memoryDayHashes?.["2026-06-10"], "h1");
});

test("day hashes are bounded to the most recent dates", () => {
  const hashes: Record<string, string> = {};
  for (let index = 0; index < 900; index++) {
    const day = new Date(Date.UTC(2024, 0, 1) + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    hashes[day] = `h${index}`;
  }
  const state = updateSourceSyncState(emptySyncState(), "limitless", {
    syncedAt: "2026-06-11T01:00:00.000Z",
    days: [],
    dayHashes: hashes,
  });
  const keys = Object.keys(state.sources.limitless.dayHashes).sort();
  assert.equal(keys.length, 800);
  // The oldest dates were evicted, the newest retained.
  assert.equal(keys.includes("2024-01-01"), false);
  assert.ok(keys[keys.length - 1] > "2026-01-01");
});
