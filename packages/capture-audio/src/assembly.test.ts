import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationAssembler } from "./assembly.js";
import type { AssemblySegment } from "./assembly.js";
import { CaptureInputError } from "./errors.js";
import { Spool } from "./spool.js";
import type { SegmentInput } from "./spool.js";

/** Deterministic, ordered `conv_` ids so grouping assertions are exact. */
function seqIds(): () => string {
  let n = 0;
  return () => `conv_${++n}`;
}

const seg = (startUtc: string, endUtc: string, text = "hi"): AssemblySegment => ({
  channel: "mic",
  text,
  startUtc,
  endUtc,
});

test("a gap strictly less than the threshold stays one capturing conversation", () => {
  const asm = new ConversationAssembler({ gapMinutes: 10, makeId: seqIds() });
  asm.add(seg("2026-07-20T10:00:00.000Z", "2026-07-20T10:00:05.000Z", "one"));
  // 9m59s after the prior segment ended: strictly below the 10-minute gap.
  asm.add(seg("2026-07-20T10:10:04.000Z", "2026-07-20T10:10:09.000Z", "two"));

  const convs = asm.conversations();
  assert.equal(convs.length, 1, "sub-threshold gap must not split the conversation");
  assert.equal(convs[0].id, "conv_1");
  assert.equal(convs[0].state, "capturing", "an open conversation stays capturing");
  assert.deepEqual(
    convs[0].segments.map((s) => s.text),
    ["one", "two"],
    "segments preserve arrival order",
  );
  assert.equal(convs[0].startedAtUtc, "2026-07-20T10:00:00.000Z");
  assert.equal(convs[0].endedAtUtc, "2026-07-20T10:10:09.000Z");
});

test("a gap exactly equal to the threshold begins the next conversation", () => {
  const asm = new ConversationAssembler({ gapMinutes: 10, makeId: seqIds() });
  asm.add(seg("2026-07-20T10:00:00.000Z", "2026-07-20T10:00:05.000Z", "one"));
  // exactly 10 minutes after the prior segment ended: the boundary opens a new conversation.
  asm.add(seg("2026-07-20T10:10:05.000Z", "2026-07-20T10:10:10.000Z", "two"));

  const convs = asm.conversations();
  assert.equal(convs.length, 2, "gap == threshold must open a new conversation");
  assert.equal(convs[0].id, "conv_1");
  assert.equal(convs[0].state, "final", "the prior conversation closes when the next begins");
  assert.deepEqual(convs[0].segments.map((s) => s.text), ["one"]);
  assert.equal(convs[1].id, "conv_2");
  assert.equal(convs[1].state, "capturing", "the newest conversation is still open");
  assert.deepEqual(convs[1].segments.map((s) => s.text), ["two"]);
});

test("finalize closes the open conversation and is idempotent", () => {
  const asm = new ConversationAssembler({ gapMinutes: 10, makeId: seqIds() });
  asm.add(seg("2026-07-20T10:00:00.000Z", "2026-07-20T10:00:05.000Z"));
  assert.equal(asm.conversations()[0].state, "capturing");

  assert.equal(asm.finalize(), 1, "finalize flips the one open conversation");
  assert.equal(asm.conversations()[0].state, "final");
  assert.equal(asm.finalize(), 0, "nothing left to finalize");
});

test("assembler rejects unparseable timestamps loudly", () => {
  const asm = new ConversationAssembler({ gapMinutes: 10 });
  assert.throws(() => asm.add(seg("not-a-date", "2026-07-20T10:00:05.000Z")), CaptureInputError);
});

const dseg = (text: string, startUtc: string, endUtc: string): SegmentInput => ({
  channel: "mic",
  text,
  startUtc,
  endUtc,
});

test("a replayed completed chunk does not duplicate persisted segments", () => {
  const spool = new Spool(":memory:");
  const base = {
    idempotencyKey: "chk_1",
    conversationId: "conv_x",
    startedAtUtc: "2026-07-20T10:00:00.000Z",
    state: "capturing" as const,
    segments: [
      dseg("one", "2026-07-20T10:00:00.000Z", "2026-07-20T10:00:05.000Z"),
      dseg("two", "2026-07-20T10:00:06.000Z", "2026-07-20T10:00:10.000Z"),
    ],
  };

  const first = spool.appendAssembledSegments(base);
  assert.equal(first.applied, true);
  assert.equal(first.segmentCount, 2);

  // Same helper chunk replayed after a restart: the durable idempotency key rejects it.
  const replay = spool.appendAssembledSegments(base);
  assert.equal(replay.applied, false, "the idempotency key must reject a replay");
  assert.equal(replay.conversationId, "conv_x");

  const after = spool.getConversation("conv_x");
  assert.ok(after);
  assert.equal(after.segments.length, 2, "a replay must not duplicate segments");
  assert.deepEqual(after.segments.map((s) => s.textRaw), ["one", "two"]);

  spool.close();
});

test("a distinct chunk appends ordered segments and grows the conversation", () => {
  const spool = new Spool(":memory:");
  spool.appendAssembledSegments({
    idempotencyKey: "chk_1",
    conversationId: "conv_x",
    startedAtUtc: "2026-07-20T10:00:00.000Z",
    segments: [dseg("one", "2026-07-20T10:00:00.000Z", "2026-07-20T10:00:05.000Z")],
  });
  const second = spool.appendAssembledSegments({
    idempotencyKey: "chk_2",
    conversationId: "conv_x",
    startedAtUtc: "2026-07-20T10:00:00.000Z",
    segments: [dseg("two", "2026-07-20T10:00:30.000Z", "2026-07-20T10:00:35.000Z")],
  });
  assert.equal(second.applied, true);
  assert.equal(second.segmentCount, 2);

  const conv = spool.getConversation("conv_x");
  assert.ok(conv);
  assert.deepEqual(conv.segments.map((s) => s.textRaw), ["one", "two"], "ordinals continue in order");
  assert.equal(conv.endedAtUtc, "2026-07-20T10:00:35.000Z", "ended advances to the latest segment");
  assert.equal(conv.state, "capturing");

  assert.equal(spool.finalizeConversation("conv_x"), true);
  assert.equal(spool.getConversation("conv_x")?.state, "final");
  assert.equal(spool.finalizeConversation("conv_x"), false, "already final");
  spool.close();
});
