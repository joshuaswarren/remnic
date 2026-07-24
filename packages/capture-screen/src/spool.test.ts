import assert from "node:assert/strict";
import { after, test } from "node:test";

import { contentHash } from "./capture.js";
import { simhashToHex, simhash } from "./simhash.js";
import { Spool, type SnapshotInput } from "./spool.js";

const spools: Spool[] = [];
after(() => {
  for (const s of spools) s.close();
});

function open(): Spool {
  const s = new Spool(":memory:");
  spools.push(s);
  return s;
}

function snap(over: Partial<SnapshotInput> & { capturedAtUtc: string }): SnapshotInput {
  const base = {
    app: "Editor",
    windowTitle: "main.ts",
    browserUrl: null as string | null,
    text: "hello",
    textSource: "ax" as const,
    ...over,
  };
  return {
    ...base,
    contentHash: contentHash(base),
    simhash: simhashToHex(simhash(base.text)),
  };
}

const GAP = 300;

test("insert then read back a snapshot", () => {
  const spool = open();
  const { id, inserted } = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z" }), GAP);
  assert.ok(id > 0);
  assert.equal(inserted, true);
  assert.equal(spool.countSnapshots(), 1);
  const row = spool.getSnapshot(id);
  assert.equal(row?.app, "Editor");
  assert.equal(row?.textSource, "ax");
  assert.equal(row?.supersededBy, null);
});

test("insert is idempotent by content hash", () => {
  const spool = open();
  const input = snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z" });
  const first = spool.insertSnapshot(input, GAP);
  const second = spool.insertSnapshot(input, GAP);
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id);
  assert.equal(spool.countSnapshots(), 1);
});

test("content hash is NUL/control-char safe (no field-boundary collision)", () => {
  const spool = open();
  // Same concatenation, different field split — must NOT collide.
  const a = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", app: "ab", windowTitle: "c" }), GAP);
  const b = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", app: "a", windowTitle: "bc" }), GAP);
  assert.notEqual(a.id, b.id);
  // A literal NUL in text must not alias a different split either.
  const c = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:01.000Z", text: "x\u0000y" }), GAP);
  const d = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:01.000Z", text: "x\u0000z" }), GAP);
  assert.notEqual(c.id, d.id);
  assert.equal(spool.countSnapshots(), 4);
});

test("supersession links the prior in-session snapshot of the same window", () => {
  const spool = open();
  const first = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", text: "v1" }), GAP);
  const second = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:10.000Z", text: "v2" }), GAP);
  assert.equal(second.supersededId, first.id);
  assert.equal(spool.getSnapshot(first.id)?.supersededBy, second.id);
  assert.equal(spool.getSnapshot(second.id)?.supersededBy, null);
});

test("a snapshot outside the session gap does not supersede", () => {
  const spool = open();
  const first = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", text: "v1" }), GAP);
  const later = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:10:00.000Z", text: "v2" }), GAP);
  assert.equal(later.supersededId, null);
  assert.equal(spool.getSnapshot(first.id)?.supersededBy, null);
});

test("a different window is never superseded by another", () => {
  const spool = open();
  const a = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", windowTitle: "a.ts", text: "1" }), GAP);
  const b = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:05.000Z", windowTitle: "b.ts", text: "2" }), GAP);
  assert.equal(b.supersededId, null);
  assert.equal(spool.getSnapshot(a.id)?.supersededBy, null);
});

test("retention janitor drops rows older than N days", () => {
  const spool = open();
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-01T10:00:00.000Z", text: "old" }), GAP);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-19T10:00:00.000Z", text: "fresh" }), GAP);
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const removed = spool.pruneOlderThan(14, now);
  assert.equal(removed, 1);
  assert.equal(spool.countSnapshots(), 1);
});

test("querySnapshots pages by a stable keyset within a half-open local day", () => {
  const spool = open();
  // Three at distinct times plus a tie at the second instant.
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T09:00:00.000Z", text: "a" }), GAP);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", text: "b" }), GAP);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", windowTitle: "tie.ts", text: "b2" }), GAP);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T11:00:00.000Z", text: "c" }), GAP);
  // A snapshot exactly at the next-day boundary must be excluded (half-open).
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-21T00:00:00.000Z", text: "next" }), GAP);

  const p1 = spool.querySnapshots({ date: "2026-07-20", timezone: "UTC", limit: 2 });
  assert.equal(p1.snapshots.length, 2);
  assert.ok(p1.nextCursor);
  assert.deepEqual(p1.snapshots.map((s) => s.text), ["a", "b"]);

  const p2 = spool.querySnapshots({ date: "2026-07-20", timezone: "UTC", limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.snapshots.map((s) => s.text), ["b2", "c"]);
  assert.equal(p2.nextCursor, null, "four rows in the day exactly fill two pages");

  const nextDay = spool.querySnapshots({ date: "2026-07-21", timezone: "UTC", limit: 10 });
  assert.deepEqual(nextDay.snapshots.map((s) => s.text), ["next"]);
});

test("querySnapshots and daySnapshots exclude superseded rows", () => {
  const spool = open();
  const first = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", windowTitle: "w", text: "v1" }), GAP);
  const second = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:05.000Z", windowTitle: "w", text: "v2" }), GAP);
  assert.equal(second.supersededId, first.id);
  const page = spool.querySnapshots({ date: "2026-07-20", timezone: "UTC", limit: 10 });
  assert.deepEqual(page.snapshots.map((s) => s.text), ["v2"], "a superseded row must not be served");
  const day = spool.daySnapshots("2026-07-20", "UTC");
  assert.deepEqual(day.map((s) => s.text), ["v2"]);
});

test("latestFingerprints returns the newest non-superseded row per window", () => {
  const spool = open();
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", windowTitle: "w", text: "v1" }), GAP);
  const latest = spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:10.000Z", windowTitle: "w", text: "v2" }), GAP);
  const fps = spool.latestFingerprints();
  assert.equal(fps.length, 1);
  assert.equal(fps[0].windowTitle, "w");
  assert.equal(fps[0].capturedAtUtc, spool.getSnapshot(latest.id)?.capturedAtUtc);
});

test("insert rejects a non-canonical timestamp", () => {
  const spool = open();
  assert.throws(() => spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20" }), GAP));
});
