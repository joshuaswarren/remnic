import assert from "node:assert/strict";
import test from "node:test";

import { assembleConversations, ConversationAssembler } from "./assembly.js";
import type { SegmentInput } from "./spool.js";

function seg(startUtc: string, endUtc: string, text = "hi"): SegmentInput {
  return { channel: "mic", text, startUtc, endUtc };
}

test("segments within the gap join one conversation", () => {
  const convs = assembleConversations(
    [
      seg("2026-07-20T15:00:00.000Z", "2026-07-20T15:00:05.000Z"),
      seg("2026-07-20T15:02:00.000Z", "2026-07-20T15:02:05.000Z"),
    ],
    10,
  );
  assert.equal(convs.length, 1);
  assert.equal(convs[0].segments.length, 2);
  assert.equal(convs[0].startedAtUtc, "2026-07-20T15:00:00.000Z");
  assert.equal(convs[0].endedAtUtc, "2026-07-20T15:02:05.000Z");
});

test("a gap larger than the threshold splits into two conversations", () => {
  const convs = assembleConversations(
    [
      seg("2026-07-20T15:00:00.000Z", "2026-07-20T15:00:05.000Z"),
      seg("2026-07-20T15:20:00.000Z", "2026-07-20T15:20:05.000Z"),
    ],
    10,
  );
  assert.equal(convs.length, 2);
});

test("a gap exactly equal to the threshold splits (join rule is strictly gap < threshold)", () => {
  const convs = assembleConversations(
    [
      seg("2026-07-20T15:00:00.000Z", "2026-07-20T15:00:00.000Z"),
      // next starts exactly 10 minutes after the previous end
      seg("2026-07-20T15:10:00.000Z", "2026-07-20T15:10:05.000Z"),
    ],
    10,
  );
  assert.equal(convs.length, 2);
});

test("state defaults to final and is applied to every conversation", () => {
  const convs = assembleConversations([seg("2026-07-20T15:00:00.000Z", "2026-07-20T15:00:01.000Z")], 10);
  assert.equal(convs[0].state, "final");
  const capturing = assembleConversations([seg("2026-07-20T15:00:00.000Z", "2026-07-20T15:00:01.000Z")], 10, "capturing");
  assert.equal(capturing[0].state, "capturing");
});

test("empty input yields no conversations", () => {
  assert.deepEqual(assembleConversations([], 10), []);
});

function counterIds(): () => string {
  let n = 0;
  return () => `conv_${++n}`;
}

test("ConversationAssembler joins within-gap segments and splits past the gap", () => {
  const a = new ConversationAssembler({ gapMinutes: 5, makeId: counterIds() });
  const first = a.add(seg("2026-07-24T00:00:00.000Z", "2026-07-24T00:00:02.000Z"));
  const same = a.add(seg("2026-07-24T00:00:10.000Z", "2026-07-24T00:00:12.000Z"));
  assert.equal(same.id, first.id);
  const next = a.add(seg("2026-07-24T00:10:00.000Z", "2026-07-24T00:10:02.000Z"));
  assert.notEqual(next.id, first.id);
  assert.equal(a.conversations().length, 2);
});

test("resume continues a recovered open conversation instead of splitting", () => {
  const a = new ConversationAssembler({ gapMinutes: 10, makeId: () => "conv_new" });
  a.resume({ id: "conv_prior", startedAtUtc: "2026-07-24T00:00:00.000Z", endedAtUtc: "2026-07-24T00:00:05.000Z" });
  const c = a.add(seg("2026-07-24T00:00:10.000Z", "2026-07-24T00:00:12.000Z"));
  assert.equal(c.id, "conv_prior");
});

test("finalize flips open conversations to final", () => {
  const a = new ConversationAssembler({ gapMinutes: 10 });
  a.add(seg("2026-07-24T00:00:00.000Z", "2026-07-24T00:00:02.000Z"));
  assert.equal(a.finalize(), 1);
  assert.equal(a.conversations()[0].state, "final");
});

test("ConversationAssembler rejects a negative gap but allows zero (config agreement)", () => {
  assert.throws(() => new ConversationAssembler({ gapMinutes: -1 }));
  assert.doesNotThrow(() => new ConversationAssembler({ gapMinutes: 0 }));
});

test("closeIfIdle finalizes the open conversation after a gap of silence", () => {
  const a = new ConversationAssembler({ gapMinutes: 5, makeId: () => "conv_1" });
  a.add(seg("2026-07-24T00:00:00.000Z", "2026-07-24T00:00:02.000Z"));
  assert.equal(a.closeIfIdle("2026-07-24T00:02:00.000Z"), null); // within the gap -> stays open
  assert.equal(a.closeIfIdle("2026-07-24T00:10:00.000Z"), "conv_1"); // gap elapsed -> closes
  assert.equal(a.conversations()[0].state, "final");
  assert.equal(a.closeIfIdle("2026-07-24T00:20:00.000Z"), null); // nothing open
});
