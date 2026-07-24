import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { CaptureConfigError, CaptureInputError } from "./errors.js";
import { Spool } from "./spool.js";
import type { ChunkStatus, ConversationState, SegmentInput } from "./spool.js";

const seg = (text: string): SegmentInput => ({
  channel: "mic",
  text,
  startUtc: "2026-07-20T10:00:00.000Z",
  endUtc: "2026-07-20T10:00:05.000Z",
});

test("schema is created with meta schema_version and instance_id", () => {
  const spool = new Spool(":memory:");
  assert.equal(spool.meta("schema_version"), "1");
  assert.ok(spool.meta("instance_id"));
  spool.close();
});

test("final-only keyset pagination is stable across duplicate timestamps", () => {
  const spool = new Spool(":memory:");
  spool.insertConversation({ id: "conv_a", startedAtUtc: "2026-07-20T10:00:00.000Z", segments: [seg("a")] });
  spool.insertConversation({ id: "conv_b", startedAtUtc: "2026-07-20T10:00:00.000Z", segments: [seg("b")] });
  spool.insertConversation({ id: "conv_c", startedAtUtc: "2026-07-20T12:00:00.000Z", segments: [seg("c")] });
  spool.insertConversation({
    id: "conv_cap",
    startedAtUtc: "2026-07-20T13:00:00.000Z",
    state: "capturing",
    segments: [seg("still going")],
  });
  spool.insertConversation({ id: "conv_next_day", startedAtUtc: "2026-07-21T10:00:00.000Z", segments: [seg("d")] });

  const p1 = spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", cursor: null, limit: 2 });
  assert.deepEqual(p1.conversations.map((c) => c.id), ["conv_a", "conv_b"]);
  assert.ok(p1.nextCursor, "expected a nextCursor when more remain");

  const p2 = spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", cursor: p1.nextCursor, limit: 2 });
  assert.deepEqual(
    p2.conversations.map((c) => c.id),
    ["conv_c"],
    "capturing and next-day conversations must be excluded",
  );
  assert.equal(p2.nextCursor, null);
  spool.close();
});

test("segments hydrate with textRaw/speakerKey/isWearer/channel", () => {
  const spool = new Spool(":memory:");
  spool.insertConversation({
    id: "conv_x",
    startedAtUtc: "2026-07-20T09:00:00.000Z",
    segments: [
      { channel: "system", text: "hello", speakerCluster: "spk_1", isWearer: false, startUtc: "2026-07-20T09:00:00.000Z", endUtc: "2026-07-20T09:00:02.000Z" },
      { channel: "mic", text: "hi back", speakerCluster: "self", isWearer: true, startUtc: "2026-07-20T09:00:03.000Z", endUtc: "2026-07-20T09:00:05.000Z" },
    ],
  });
  const page = spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", limit: 10 });
  const conv = page.conversations[0];
  assert.equal(conv.segmentCount, 2);
  assert.deepEqual(conv.segments.map((s) => s.textRaw), ["hello", "hi back"]);
  assert.equal(conv.segments[0].speakerKey, "spk_1");
  assert.equal(conv.segments[1].isWearer, true);
  assert.equal(conv.segments[0].channel, "system");
  spool.close();
});

test("timezone determines the local day bucket", () => {
  const spool = new Spool(":memory:");
  // 02:00 UTC is still the previous day in Los Angeles (UTC-7 in July).
  spool.insertConversation({ id: "conv_tz", startedAtUtc: "2026-07-20T02:00:00.000Z", segments: [seg("tz")] });
  assert.equal(spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", limit: 10 }).conversations.length, 1);
  assert.equal(
    spool.queryFinalConversations({ date: "2026-07-19", timezone: "America/Los_Angeles", limit: 10 }).conversations.length,
    1,
  );
  assert.equal(
    spool.queryFinalConversations({ date: "2026-07-20", timezone: "America/Los_Angeles", limit: 10 }).conversations.length,
    0,
  );
  spool.close();
});

test("re-inserting the same conversation id is idempotent (no duplicate rows)", () => {
  const spool = new Spool(":memory:");
  const input = { id: "conv_dup", startedAtUtc: "2026-07-20T10:00:00.000Z", segments: [seg("a"), seg("b")] };
  spool.insertConversation(input);
  const before = spool.stats();
  spool.insertConversation(input);
  const after = spool.stats();
  assert.deepEqual(after, before);
  assert.equal(after.conversations, 1);
  assert.equal(after.segments, 2);
  assert.equal(after.chunks, 1);
  spool.close();
});

test("a malformed cursor is a 400-class CaptureInputError", () => {
  const spool = new Spool(":memory:");
  assert.throws(
    () => spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", cursor: "!!!not-a-token", limit: 5 }),
    CaptureInputError,
  );
  spool.close();
});

test("pendingChunkCount reflects non-transcribed chunks", () => {
  const spool = new Spool(":memory:");
  spool.insertConversation({ id: "conv_ok", startedAtUtc: "2026-07-20T10:00:00.000Z", segments: [seg("a")] });
  spool.insertConversation({ id: "conv_pending", startedAtUtc: "2026-07-20T11:00:00.000Z", chunkStatus: "pending", segments: [seg("b")] });
  assert.equal(spool.pendingChunkCount(), 1);
  spool.close();
});

test("speakers upsert, update, and list ordered by id", () => {
  const spool = new Spool(":memory:");
  spool.upsertSpeaker({ id: "spk_1", label: "Alice", isSelf: false });
  spool.upsertSpeaker({ id: "self", label: "Me", isSelf: true });
  spool.upsertSpeaker({ id: "spk_1", label: "Alice B." });
  const list = spool.listSpeakers();
  assert.deepEqual(list.map((s) => s.id), ["self", "spk_1"]);
  assert.equal(list.find((s) => s.id === "self")?.isSelf, true);
  assert.equal(list.find((s) => s.id === "spk_1")?.label, "Alice B.");
  spool.close();
});

test("speaker updates preserve omitted state while honoring explicit changes", () => {
  const spool = new Spool(":memory:");
  spool.upsertSpeaker({ id: "self", label: "Me", isSelf: true, embeddingCount: 4 });
  spool.upsertSpeaker({ id: "self", label: "Updated" });
  assert.deepEqual(spool.listSpeakers(), [{ id: "self", label: "Updated", isSelf: true, embeddingCount: 4 }]);
  spool.upsertSpeaker({ id: "self", isSelf: false, embeddingCount: 0 });
  assert.deepEqual(spool.listSpeakers(), [{ id: "self", label: "Updated", isSelf: false, embeddingCount: 0 }]);
  spool.close();
});

test("finalizeOpenConversations flips capturing to final", () => {
  const spool = new Spool(":memory:");
  spool.insertConversation({ id: "conv_live", startedAtUtc: "2026-07-20T10:00:00.000Z", state: "capturing", segments: [seg("a")] });
  assert.equal(spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", limit: 10 }).conversations.length, 0);
  assert.equal(spool.finalizeOpenConversations(), 1);
  assert.equal(spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", limit: 10 }).conversations.length, 1);
  spool.close();
});

test("upsertSpeaker preserves fields omitted from a later update", () => {
  const spool = new Spool(":memory:");
  spool.upsertSpeaker({ id: "self", label: "Me", isSelf: true, embeddingCount: 5 });
  // label-only update must not clear isSelf or reset embeddingCount
  spool.upsertSpeaker({ id: "self", label: "Myself" });
  const row = spool.listSpeakers().find((s) => s.id === "self");
  assert.equal(row?.label, "Myself");
  assert.equal(row?.isSelf, true);
  assert.equal(row?.embeddingCount, 5);
  spool.close();
});

test("close() is idempotent (double signal / double shutdown safe)", () => {
  const spool = new Spool(":memory:");
  spool.close();
  assert.doesNotThrow(() => spool.close());
});

test("an on-disk spool file is created owner-only (0600)", () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "cap-spool-"));
  const file = nodePath.join(dir, "audio.sqlite");
  const spool = new Spool(file);
  spool.close();
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("insertConversation rejects invalid timestamps before persisting (no partial write)", () => {
  const spool = new Spool(":memory:");
  assert.throws(
    () => spool.insertConversation({ id: "c1", startedAtUtc: "not-a-date", segments: [seg("a")] }),
    CaptureConfigError,
  );
  assert.throws(
    () =>
      spool.insertConversation({
        id: "c2",
        startedAtUtc: "2026-07-20T10:00:00.000Z",
        segments: [{ channel: "mic", text: "x", startUtc: "bad", endUtc: "2026-07-20T10:00:01.000Z" }],
      }),
    CaptureConfigError,
  );
  assert.deepEqual(spool.stats(), { conversations: 0, segments: 0, chunks: 0 });
  spool.close();
});

test("insertConversation rejects invalid calendar dates at the Spool boundary", () => {
  const spool = new Spool(":memory:");
  assert.throws(
    () => spool.insertConversation({ id: "c", startedAtUtc: "2026-02-30T00:00:00.000Z", segments: [seg("a")] }),
    /not a real calendar date/,
  );
  assert.deepEqual(spool.stats(), { conversations: 0, segments: 0, chunks: 0 });
  spool.close();
});

test("insertConversation enforces conversation and segment chronology", () => {
  const spool = new Spool(":memory:");
  assert.throws(
    () =>
      spool.insertConversation({
        id: "c1",
        startedAtUtc: "2026-07-20T10:00:00.000Z",
        endedAtUtc: "2026-07-20T09:00:00.000Z",
        segments: [seg("a")],
      }),
    /must not precede startedAtUtc/,
  );
  assert.throws(
    () =>
      spool.insertConversation({
        id: "c2",
        startedAtUtc: "2026-07-20T10:00:00.000Z",
        segments: [{ channel: "mic", text: "x", startUtc: "2026-07-20T10:00:02.000Z", endUtc: "2026-07-20T10:00:01.000Z" }],
      }),
    /endUtc must not precede startUtc/,
  );
  assert.deepEqual(spool.stats(), { conversations: 0, segments: 0, chunks: 0 });
  spool.close();
});

test("insertConversation requires a canonical instant (rejects date-only / offsetless)", () => {
  const spool = new Spool(":memory:");
  for (const bad of ["2026-07-20", "2026-07-20T10:00:00", "2026-07-20 10:00:00Z"]) {
    assert.throws(
      () => spool.insertConversation({ id: "c", startedAtUtc: bad, segments: [seg("x")] }),
      CaptureConfigError,
      `should reject ${bad}`,
    );
  }
  // Nothing partially written by the rejected inserts.
  assert.equal(spool.stats().conversations, 0);
  // A canonical Z instant is accepted.
  const id = spool.insertConversation({
    id: "c_ok",
    startedAtUtc: "2026-07-20T10:00:00.000Z",
    segments: [seg("x")],
  });
  assert.equal(id, "c_ok");
  spool.close();
});

test("insertConversation rejects unknown state/chunkStatus at the persistence boundary (JS callers)", () => {
  const spool = new Spool(":memory:");
  // Simulate an untyped JS caller passing values the query/finalize/count paths
  // don't recognize; the runtime guard must reject rather than persist them.
  assert.throws(
    () =>
      spool.insertConversation({
        id: "c_badstate",
        startedAtUtc: "2026-07-20T10:00:00.000Z",
        state: "finished" as ConversationState,
        segments: [seg("x")],
      }),
    CaptureConfigError,
  );
  assert.throws(
    () =>
      spool.insertConversation({
        id: "c_badchunk",
        startedAtUtc: "2026-07-20T10:00:00.000Z",
        chunkStatus: "done" as ChunkStatus,
        segments: [seg("x")],
      }),
    CaptureConfigError,
  );
  assert.equal(spool.stats().conversations, 0);
  const id = spool.insertConversation({
    id: "c_ok",
    startedAtUtc: "2026-07-20T10:00:00.000Z",
    state: "capturing",
    chunkStatus: "pending",
    segments: [seg("x")],
  });
  assert.equal(id, "c_ok");
  spool.close();
});

test("insertConversation normalizes offset instants to UTC Z so the keyset orders chronologically", () => {
  const spool = new Spool(":memory:");
  // conv_a is chronologically earlier (10:30Z) but its RAW offset text sorts
  // lexically AFTER conv_b's Z text — proving the write must normalize to Z.
  spool.insertConversation({
    id: "conv_a",
    startedAtUtc: "2026-07-20T11:30:00+01:00",
    segments: [{ channel: "mic", text: "a", startUtc: "2026-07-20T11:30:00+01:00", endUtc: "2026-07-20T11:30:05+01:00" }],
  });
  spool.insertConversation({
    id: "conv_b",
    startedAtUtc: "2026-07-20T11:00:00.000Z",
    segments: [{ channel: "mic", text: "b", startUtc: "2026-07-20T11:00:00.000Z", endUtc: "2026-07-20T11:00:05.000Z" }],
  });
  const page = spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", cursor: null, limit: 10 });
  assert.deepEqual(
    page.conversations.map((c) => c.id),
    ["conv_a", "conv_b"],
    "final conversations must page in true UTC order, not lexical raw-text order",
  );
  assert.equal(
    page.conversations.find((c) => c.id === "conv_a")?.startedAtUtc,
    "2026-07-20T10:30:00.000Z",
    "an accepted offset instant is stored normalized to Z",
  );
  spool.close();
});

test("upsertSpeaker persists centroid + examples and readSpeakerClusters round-trips them", () => {
  const spool = new Spool(":memory:");
  try {
    spool.upsertSpeaker({
      id: "spk_1",
      label: "Jane",
      isSelf: false,
      embeddingCount: 3,
      centroid: [0.1, 0.2, 0.3],
      examples: [
        [0.1, 0.2, 0.3],
        [0.11, 0.19, 0.31],
      ],
    });
    spool.upsertSpeaker({ id: "self", isSelf: true, embeddingCount: 1, centroid: [0.5, 0.5], examples: [[0.5, 0.5]] });
    const clusters = spool.readSpeakerClusters();
    assert.equal(clusters.length, 2);
    const jane = clusters.find((c) => c.id === "spk_1");
    assert.equal(jane?.label, "Jane");
    assert.equal(jane?.embeddingCount, 3);
    assert.deepEqual(jane?.centroid, [0.1, 0.2, 0.3]);
    assert.equal(jane?.examples.length, 2);
    const self = clusters.find((c) => c.id === "self");
    assert.equal(self?.isSelf, true);
    assert.deepEqual(self?.centroid, [0.5, 0.5]);
  } finally {
    spool.close();
  }
});

test("upsertSpeaker preserves an existing centroid when the field is omitted", () => {
  const spool = new Spool(":memory:");
  try {
    spool.upsertSpeaker({ id: "spk_1", centroid: [1, 2, 3], examples: [[1, 2, 3]] });
    spool.upsertSpeaker({ id: "spk_1", label: "renamed" }); // no centroid field
    const c = spool.readSpeakerClusters()[0];
    assert.equal(c.label, "renamed");
    assert.deepEqual(c.centroid, [1, 2, 3]);
  } finally {
    spool.close();
  }
});
