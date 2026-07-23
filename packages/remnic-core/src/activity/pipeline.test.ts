import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activityDigestPath } from "./digest.js";
import { activityCursorKey, syncActivitySource } from "./pipeline.js";
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
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), "cursor-2");
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

    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), null);
    assert.equal(store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z").length, 1);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource completes normally when the final page lands on the page cap", async () => {
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
        ["cursor-1", null],
      ]),
    );

    // Two pages with a page budget of exactly two: the terminal null cursor
    // arrives on the last allowed page, which must not be treated as a runaway.
    const result = await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store, maxPages: 2 });
    assert.equal(result.inserted, 2);
    assert.equal(result.cursor, "cursor-1");
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), "cursor-1");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource rejects runaway pagination and leaves the cursor unadvanced", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    let issued = 0;
    const runaway: ActivitySourceClient = {
      machineLabel: "workstation-a",
      async verify() {
        return { ok: true };
      },
      async fetchSnapshots() {
        issued += 1;
        return { snapshots: [], nextCursor: `cursor-${issued}` };
      },
    };

    await assert.rejects(
      syncActivitySource(runaway, { date: "2026-07-22", timezone: "UTC", memoryDir, store, maxPages: 3 }),
      /exceeded 3 pages/,
    );
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), null);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent same-day syncs from two sources persist without corrupting the digest", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const clientA = source("workstation-a", new Map([[null, [snapshot({ contentHash: "a-1" })]]]), new Map([[null, null]]));
    const clientB = source("workstation-b", new Map([[null, [snapshot({ contentHash: "b-1" })]]]), new Map([[null, null]]));

    await Promise.all([
      syncActivitySource(clientA, { date: "2026-07-22", timezone: "UTC", memoryDir, store }),
      syncActivitySource(clientB, { date: "2026-07-22", timezone: "UTC", memoryDir, store }),
    ]);

    const digest = await readFile(activityDigestPath(memoryDir, "2026-07-22"), "utf8");
    assert.match(digest, /kind: activity-digest/);
    assert.match(digest, /snapshotCount: 2/);
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), null);
    assert.equal(store.getCursor(activityCursorKey("workstation-b", "2026-07-22")), null);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource reindexes after a digest write, with the digest already durable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = source("workstation-a", new Map([[null, [snapshot()]]]), new Map([[null, null]]));
    let reindexed = 0;
    let digestAtReindex = "";
    const result = await syncActivitySource(client, {
      date: "2026-07-22",
      timezone: "UTC",
      memoryDir,
      store,
      afterWrites: async () => {
        reindexed += 1;
        // The reindex must see the durable digest already on disk — that is
        // what makes the new day discoverable (rule 31).
        digestAtReindex = await readFile(activityDigestPath(memoryDir, "2026-07-22"), "utf8");
      },
    });

    assert.equal(result.digestWritten, true);
    assert.equal(reindexed, 1, "reindex fires exactly once after the digest write");
    assert.match(digestAtReindex, /snapshotCount: 1/, "the written digest is visible to the reindex");
    assert.equal(result.reindexError, undefined);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource skips the reindex when the digest is unchanged", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    let reindexed = 0;
    const opts = {
      date: "2026-07-22",
      timezone: "UTC",
      memoryDir,
      store,
      afterWrites: async () => {
        reindexed += 1;
      },
    };
    const first = source("workstation-a", new Map([[null, [snapshot()]]]), new Map([[null, null]]));
    await syncActivitySource(first, opts);
    const second = source("workstation-a", new Map([[null, [snapshot()]]]), new Map([[null, null]]));
    const result = await syncActivitySource(second, opts);

    assert.equal(result.digestWritten, false, "an unchanged day rewrites nothing");
    assert.equal(reindexed, 1, "no reindex when the digest did not change");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource isolates a reindex failure: rows, digest, and cursor still commit", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = source("workstation-a", new Map([[null, [snapshot()]]]), new Map([[null, null]]));
    const result = await syncActivitySource(client, {
      date: "2026-07-22",
      timezone: "UTC",
      memoryDir,
      store,
      afterWrites: async () => {
        // A backend error whose message embeds an absolute path must be
        // sanitized to a name+code in the exported reindexError, not echoed.
        throw Object.assign(new Error("ENOENT: /abs/qmd/index.sqlite missing"), { code: "ENOENT" });
      },
    });

    assert.equal(result.digestWritten, true, "the digest is durable despite the reindex failure");
    assert.match(result.reindexError ?? "", /ENOENT/);
    assert.ok(!result.reindexError?.includes("/abs/qmd"), "reindexError does not leak the absolute path");
    assert.equal(result.inserted, 1);
    await access(activityDigestPath(memoryDir, "2026-07-22"));
    assert.equal(
      store.getCursor(activityCursorKey("workstation-a", "2026-07-22")),
      null,
      "cursor still advanced; reindex is best-effort",
    );
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource honors an abort before committing the digest and cursor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const controller = new AbortController();
    const client: ActivitySourceClient = {
      machineLabel: "workstation-a",
      async verify() {
        return { ok: true };
      },
      async fetchSnapshots() {
        // Abort fires after the last page returns but before the digest write.
        controller.abort();
        return { snapshots: [snapshot()], nextCursor: null };
      },
    };

    await assert.rejects(
      syncActivitySource(client, {
        date: "2026-07-22",
        timezone: "UTC",
        memoryDir,
        store,
        signal: controller.signal,
      }),
    );

    assert.equal(
      store.getCursor(activityCursorKey("workstation-a", "2026-07-22")),
      null,
      "an aborted tick never advances the cursor",
    );
    await assert.rejects(
      readFile(activityDigestPath(memoryDir, "2026-07-22"), "utf8"),
      "an aborted tick never writes the digest",
    );
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource persists out-of-window snapshots under their own day, never the requested day's digest", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = source(
      "workstation-a",
      new Map([
        [
          null,
          [
            snapshot({ capturedAtUtc: "2026-07-22T14:00:00.000Z", contentHash: "in-window" }),
            // A snapshot the daemon misplaced onto a different day (replay /
            // timezone bug). It must be retained under its own day, not lost.
            snapshot({ capturedAtUtc: "2026-07-20T10:00:00.000Z", contentHash: "out-of-window" }),
          ],
        ],
      ]),
      new Map([[null, null]]),
    );

    const result = await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });

    assert.equal(result.fetched, 2, "both snapshots were fetched");
    assert.equal(result.inserted, 2, "both snapshots are durably persisted (no data loss)");
    // The requested day's digest is a window query: only its in-window row.
    const day = store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z");
    assert.deepEqual(day.map((s) => s.contentHash), ["in-window"], "the requested day contains only its in-window row");
    assert.match(await readFile(activityDigestPath(memoryDir, "2026-07-22"), "utf8"), /snapshotCount: 1/);
    // The misplaced row is durable under ITS OWN day, surfacing when that day syncs.
    const ownDay = store.listSnapshotsForDay(null, "2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z");
    assert.deepEqual(ownDay.map((s) => s.contentHash), ["out-of-window"], "the misplaced row is retained under its own day, not dropped");
    // Nothing was skipped, so the cursor advancing past the page is correct.
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-07-22")), null, "cursor advances after a fully-persisted page");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource rejects a calendar-overflow timestamp instead of skipping it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-pipeline-"));
  const store = ActivityStore.open(memoryDir);
  try {
    const client = source(
      "workstation-a",
      // 2026-02-30 is impossible; Date.parse rolls it to Mar 2, which would fall
      // outside a Feb 28 sync window. It must fail loudly, not be silently skipped.
      new Map([[null, [snapshot({ capturedAtUtc: "2026-02-30T12:00:00.000Z", contentHash: "overflow" })]]]),
      new Map([[null, null]]),
    );

    await assert.rejects(
      syncActivitySource(client, { date: "2026-02-28", timezone: "UTC", memoryDir, store }),
      /capture timestamp/,
    );
    assert.equal(store.getCursor(activityCursorKey("workstation-a", "2026-02-28")), null, "cursor never advances on a rejected page");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

interface GenerationSourceState {
  generation: string;
  pages: Map<string | null, ActivitySnapshot[]>;
  cursors: Map<string | null, string | null>;
}

function generationSource(machineLabel: string, state: GenerationSourceState): ActivitySourceClient {
  return {
    machineLabel,
    async verify() {
      return { ok: true };
    },
    async fetchSnapshots({ cursor }) {
      return {
        snapshots: state.pages.get(cursor ?? null) ?? [],
        nextCursor: state.cursors.get(cursor ?? null) ?? null,
        generation: state.generation,
      };
    },
  };
}

test("syncActivitySource resets a stale cursor when a smaller rebuilt spool changes generation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-gen-"));
  const store = ActivityStore.open(memoryDir);
  const key = activityCursorKey("workstation-a", "2026-07-22");
  try {
    const state: GenerationSourceState = { generation: "gen-A", pages: new Map(), cursors: new Map() };
    const client = generationSource("workstation-a", state);

    state.pages.set(null, [snapshot({ contentHash: "a1" }), snapshot({ capturedAtUtc: "2026-07-22T14:01:00.000Z", contentHash: "a2" })]);
    state.cursors.set(null, "2");
    state.pages.set("2", []);
    state.cursors.set("2", null);
    await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });
    assert.equal(store.getCursor(key), "2");
    assert.equal(store.getCursorGeneration(key), "gen-A");

    // Rebuilt SMALLER: one fresh row at id "1"; the persisted cursor "2" would
    // strand it forever without a generation-driven reset.
    state.generation = "gen-B";
    state.pages.clear();
    state.cursors.clear();
    state.pages.set(null, [snapshot({ capturedAtUtc: "2026-07-22T15:00:00.000Z", contentHash: "b1" })]);
    state.cursors.set(null, "1");
    state.pages.set("1", []);
    state.cursors.set("1", null);
    const result = await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });
    assert.equal(result.inserted, 1);
    assert.equal(store.getCursor(key), "1");
    assert.equal(store.getCursorGeneration(key), "gen-B");
    const hashes = store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z").map((s) => s.contentHash);
    assert.ok(hashes.includes("b1"), "the post-rebuild capture is ingested");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource resets a stale cursor when a larger rebuilt spool changes generation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-gen-"));
  const store = ActivityStore.open(memoryDir);
  const key = activityCursorKey("workstation-a", "2026-07-22");
  try {
    const state: GenerationSourceState = { generation: "gen-A", pages: new Map(), cursors: new Map() };
    const client = generationSource("workstation-a", state);

    state.pages.set(null, [snapshot({ contentHash: "a1" }), snapshot({ capturedAtUtc: "2026-07-22T14:01:00.000Z", contentHash: "a2" })]);
    state.cursors.set(null, "2");
    state.pages.set("2", []);
    state.cursors.set("2", null);
    await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });
    assert.equal(store.getCursor(key), "2");

    // Rebuilt LARGER: three fresh rows. The stale-cursor path ("2") would skip
    // c1/c2 and ingest only c3; the generation reset restarts from the top.
    state.generation = "gen-C";
    state.pages.clear();
    state.cursors.clear();
    state.pages.set("2", [snapshot({ capturedAtUtc: "2026-07-22T16:03:00.000Z", contentHash: "c3" })]);
    state.cursors.set("2", null);
    state.pages.set(null, [
      snapshot({ capturedAtUtc: "2026-07-22T16:01:00.000Z", contentHash: "c1" }),
      snapshot({ capturedAtUtc: "2026-07-22T16:02:00.000Z", contentHash: "c2" }),
      snapshot({ capturedAtUtc: "2026-07-22T16:03:00.000Z", contentHash: "c3" }),
    ]);
    state.cursors.set(null, "3");
    state.pages.set("3", []);
    state.cursors.set("3", null);
    const result = await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });
    assert.equal(result.inserted, 3);
    const hashes = store.listSnapshotsForDay(null, "2026-07-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z").map((s) => s.contentHash);
    assert.ok(hashes.includes("c1") && hashes.includes("c2") && hashes.includes("c3"), "every row of the larger rebuild is ingested");
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("syncActivitySource keeps legacy behavior when the source omits generation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-activity-gen-"));
  const store = ActivityStore.open(memoryDir);
  const key = activityCursorKey("workstation-a", "2026-07-22");
  try {
    const client = source("workstation-a", new Map([[null, [snapshot()]]]), new Map([[null, null]]));
    await syncActivitySource(client, { date: "2026-07-22", timezone: "UTC", memoryDir, store });
    // No generation on the wire -> none persisted, so the reset path never engages.
    assert.equal(store.getCursorGeneration(key), null);
  } finally {
    store.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
