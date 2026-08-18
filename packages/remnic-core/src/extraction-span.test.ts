import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpanOffsets } from "./extraction-span.js";

const TEXT = "Alice moved to Seattle";

test("parseSpanOffsets: disabled or 0 is identity", () => {
  const offsets = { start: 6, end: 11 };
  assert.deepEqual(parseSpanOffsets(TEXT, offsets, false), { text: TEXT });
  assert.deepEqual(parseSpanOffsets(TEXT, offsets, 0), { text: TEXT });
  assert.deepEqual(parseSpanOffsets(TEXT, offsets), { text: TEXT });
});

test("parseSpanOffsets: enabled slices half-open [start, end)", () => {
  assert.deepEqual(parseSpanOffsets(TEXT, { start: 6, end: 11 }, true), {
    text: "moved",
    start: 6,
    end: 11,
  });
});

test("parseSpanOffsets: boundary offsets stay inside the string", () => {
  assert.deepEqual(parseSpanOffsets(TEXT, { start: 0, end: TEXT.length }, true), {
    text: TEXT,
    start: 0,
    end: TEXT.length,
  });
  assert.deepEqual(parseSpanOffsets(TEXT, { start: 0, end: 1 }, true), {
    text: "A",
    start: 0,
    end: 1,
  });
  assert.deepEqual(parseSpanOffsets(TEXT, { start: TEXT.length - 1, end: TEXT.length }, true), {
    text: "e",
    start: TEXT.length - 1,
    end: TEXT.length,
  });
});

test("parseSpanOffsets: reversed and out-of-range offsets reject", () => {
  assert.throws(() => parseSpanOffsets(TEXT, { start: 12, end: 6 }, true), /reversed|out of range|invalid span/i);
  assert.throws(() => parseSpanOffsets(TEXT, { start: -1, end: 6 }, true), /out of range|invalid span/i);
  assert.throws(() => parseSpanOffsets(TEXT, { start: 0, end: TEXT.length + 1 }, true), /out of range|invalid span/i);
});

test("parseSpanOffsets: empty source and empty span", () => {
  assert.deepEqual(parseSpanOffsets("", { start: 0, end: 0 }, false), { text: "" });
  assert.deepEqual(parseSpanOffsets("", { start: 0, end: 0 }, true), {
    text: "",
    start: 0,
    end: 0,
  });
  assert.deepEqual(parseSpanOffsets(TEXT, { start: 6, end: 6 }, true), {
    text: "",
    start: 6,
    end: 6,
  });
  assert.throws(() => parseSpanOffsets("", { start: 0, end: 1 }, true), /out of range|invalid span/i);
});
