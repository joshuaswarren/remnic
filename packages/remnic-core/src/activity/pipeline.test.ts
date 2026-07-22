import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activityDigestPath } from "./digest.js";
import { syncActivitySource } from "./pipeline.js";
import { ActivityStore } from "./store.js";
import type { ActivitySnapshot, ActivitySourceClient } from "./types.js";

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    machine: "untrusted-source-value",
    capturedAtUtc: "2026-07-22T14:00:00.000Z",
    app: "Browser",
    windowTitle: "Example",
    text: "A synthetic activity snapshot",
    textSource: "ax",
    contentHash: "hash-1",
    ...overrides,
  };
}

function source(
  machineLabel: string,
  pages: Map<string | null, ActivitySnapshot[]>,
  cursors: Map<string | null, string | null>,
): ActivitySourceClient {
  return {
    machineLabel,
    async verify() {
      return { ok: true };
    },
    async fetchSnapshots({ cursor }) {
      return { snapshots: pages.get(cursor ?? null) ?? [], nextCursor: cursors.get(cursor ?? null) ?? null };
    },
  };
}

test("syncActivitySource persists every page, renders the digest, then advances the cursor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = source(
      "workstation-a",
      new Map([
        [null, [snapshot()]],
        ["cursor-1", [snapshot({ capturedAtUtc: "2026-07-22T14:01:00.000Z", contentHash: "hash-2" })]],
      ]),
      new Map([
        [null, "cursor-1"],
        ["cursor-1", "cursor-2"],
      ]),
    );

    const result = await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });

    assert.deepEqual(result, {
      machine: "workstation-a",
      fetched: 2,
      inserted: 2,
      duplicates: 0,
      cursor: "cursor-2",
      digestWritten: true,
    });
    assert.equal(store.getCursor("workstation-a"), "cursor-2");
    assert.deepEqual(
      store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z").map((item) => item.machine),
      ["workstation-a", "workstation-a"],
      "the source identity, not a remote payload label, owns the persisted machine field",
    );
    assert.match(await readFile(activityDigestPath(memoryDir, "2026-07-22"), "utf8"), /snapshotCount: 2/);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource leaves the cursor unchanged when a later page cannot persist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = source(
      "workstation-a",
      new Map([
        [null, [snapshot()]],
        ["cursor-1", [snapshot({ capturedAtUtc: "not-a-timestamp", contentHash: "bad-hash" })]],
      ]),
      new Map([
        [null, "cursor-1"],
        ["cursor-1", "cursor-2"],
      ]),
    );

    await assert.rejects(
      syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store }),
      /capture timestamp/,
    );

    assert.equal(store.getCursor("workstation-a"), null);
    assert.equal(store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z").length, 1);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
