import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { activityDayWindow } from "./digest.js";
import { ActivityStore } from "./store.js";
import type { ActivitySnapshot } from "./types.js";

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    machine: "macstudio",
    capturedAtUtc: "2026-03-10T14:00:00.000Z",
    app: "Chrome",
    windowTitle: "Roadmap",
    text: "quarterly roadmap review",
    textSource: "ax",
    contentHash: "hash-a",
    ...overrides,
  };
}

async function withStore(fn: (store: ActivityStore) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "activity-store-"));
  const store = ActivityStore.open(dir);
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("insertSnapshot dedups on (machine, content_hash)", async () => {
  await withStore((store) => {
    const first = store.insertSnapshot(snapshot());
    const second = store.insertSnapshot(snapshot({ text: "different text, same hash" }));
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.id, first.id);
    const rows = store.listSnapshotsForDay("macstudio", "2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z");
    assert.equal(rows.length, 1);
  });
});

test("the same content_hash on a different machine is stored separately", async () => {
  await withStore((store) => {
    assert.equal(store.insertSnapshot(snapshot({ machine: "macstudio" })).inserted, true);
    assert.equal(store.insertSnapshot(snapshot({ machine: "laptop" })).inserted, true);
    const all = store.listSnapshotsForDay(null, "2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z");
    assert.equal(all.length, 2);
  });
});

test("listSnapshotsForDay is half-open: a snapshot at the end bound is excluded", async () => {
  await withStore((store) => {
    store.insertSnapshot(snapshot({ contentHash: "h1", capturedAtUtc: "2026-03-10T00:00:00.000Z" }));
    store.insertSnapshot(snapshot({ contentHash: "h2", capturedAtUtc: "2026-03-10T23:59:59.000Z" }));
    store.insertSnapshot(snapshot({ contentHash: "h3", capturedAtUtc: "2026-03-11T00:00:00.000Z" }));
    const rows = store.listSnapshotsForDay(null, "2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z");
    assert.deepEqual(rows.map((r) => r.contentHash), ["h1", "h2"]);
  });
});

test("results are ordered by (captured_at_utc, id)", async () => {
  await withStore((store) => {
    store.insertSnapshot(snapshot({ contentHash: "b", capturedAtUtc: "2026-03-10T15:00:00.000Z" }));
    store.insertSnapshot(snapshot({ contentHash: "a", capturedAtUtc: "2026-03-10T14:00:00.000Z" }));
    const rows = store.listSnapshotsForDay(null, "2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z");
    assert.deepEqual(rows.map((r) => r.contentHash), ["a", "b"]);
  });
});

test("cursors are per-machine and round-trip", async () => {
  await withStore((store) => {
    assert.equal(store.getCursor("macstudio"), null);
    store.setCursor("macstudio", "cur-1");
    store.setCursor("laptop", "cur-2");
    assert.equal(store.getCursor("macstudio"), "cur-1");
    assert.equal(store.getCursor("laptop"), "cur-2");
    store.setCursor("macstudio", "cur-3");
    assert.equal(store.getCursor("macstudio"), "cur-3");
  });
});

test("searchSnapshots finds by text token and by app name", async () => {
  await withStore((store) => {
    store.insertSnapshot(snapshot({ contentHash: "h1", app: "Slack", text: "deploy the staging build" }));
    store.insertSnapshot(snapshot({ contentHash: "h2", app: "Chrome", text: "unrelated content" }));
    assert.equal(store.searchSnapshots("deploy", 10).length, 1);
    assert.equal(store.searchSnapshots("Slack", 10)[0]?.app, "Slack");
    assert.equal(store.searchSnapshots("nonexistentterm", 10).length, 0);
  });
});

test("pruneOlderThan removes only rows before the cutoff, incl. their FTS rows", async () => {
  await withStore((store) => {
    store.insertSnapshot(snapshot({ contentHash: "old", capturedAtUtc: "2026-03-01T10:00:00.000Z", text: "ancient" }));
    store.insertSnapshot(snapshot({ contentHash: "new", capturedAtUtc: "2026-03-10T10:00:00.000Z", text: "recent" }));
    const removed = store.pruneOlderThan("2026-03-05T00:00:00.000Z");
    assert.equal(removed, 1);
    const all = store.listSnapshotsForDay(null, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
    assert.deepEqual(all.map((r) => r.contentHash), ["new"]);
    // FTS row for the pruned snapshot is gone too.
    assert.equal(store.searchSnapshots("ancient", 10).length, 0);
    assert.equal(store.searchSnapshots("recent", 10).length, 1);
  });
});

test("searchSnapshots never throws on FTS-special input (URLs, quotes, operators)", async () => {
  await withStore((store) => {
    store.insertSnapshot(
      snapshot({ contentHash: "u", app: "Chrome", windowTitle: "PR", browserUrl: "https://github.com/x/pull/412", text: "review the change" }),
    );
    // URL with slashes/dots would be FTS5 syntax without sanitization.
    assert.equal(store.searchSnapshots("github.com/x/pull/412", 10).length, 1);
    // Bare boolean operators and quotes must not throw.
    assert.doesNotThrow(() => store.searchSnapshots('AND OR "', 10));
    assert.deepEqual(store.searchSnapshots("   ", 10), []);
    assert.deepEqual(store.searchSnapshots('""', 10), []);
  });
});

test("ActivityStore.open works on a fresh memoryDir (creates state/ itself)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "activity-fresh-"));
  try {
    // No pre-created state/ dir: the public factory must not throw.
    const store = ActivityStore.open(dir);
    const result = store.insertSnapshot(snapshot());
    assert.equal(result.inserted, true);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("insertSnapshot writes the FTS row atomically (searchable right after insert)", async () => {
  await withStore((store) => {
    const result = store.insertSnapshot(snapshot({ text: "atomic search token zzq", contentHash: "atomic-1" }));
    assert.equal(result.inserted, true);
    // A committed base row without its FTS row would return zero hits here.
    const hits = store.searchSnapshots("zzq", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.contentHash, "atomic-1");
  });
});

test("dedup keeps the same content at a different time; exact re-ingest dedups", async () => {
  await withStore((store) => {
    const first = store.insertSnapshot(snapshot({ capturedAtUtc: "2026-03-10T14:00:00.000Z", contentHash: "same" }));
    const later = store.insertSnapshot(snapshot({ capturedAtUtc: "2026-03-10T15:00:00.000Z", contentHash: "same" }));
    const dup = store.insertSnapshot(snapshot({ capturedAtUtc: "2026-03-10T14:00:00.000Z", contentHash: "same" }));
    assert.equal(first.inserted, true);
    assert.equal(later.inserted, true); // same content, different time → kept
    assert.equal(dup.inserted, false); // exact re-ingestion → deduped
  });
});

test("captured timestamps are canonicalized so day-window filtering matches", async () => {
  await withStore((store) => {
    // Non-canonical inputs (explicit +00:00 offset, missing millis) must land in the day.
    store.insertSnapshot(snapshot({ capturedAtUtc: "2026-03-10T14:00:00+00:00", contentHash: "c1" }));
    store.insertSnapshot(snapshot({ capturedAtUtc: "2026-03-10T15:30:00Z", contentHash: "c2" }));
    const { startUtc, endUtc } = activityDayWindow("2026-03-10", "UTC");
    const rows = store.listSnapshotsForDay(null, startUtc, endUtc);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.capturedAtUtc.endsWith("Z") && r.capturedAtUtc.includes(".")));
  });
});
