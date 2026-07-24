import assert from "node:assert/strict";
import test from "node:test";

import { assembleConversations } from "./assembly.js";
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
