import assert from "node:assert/strict";
import { test } from "node:test";
import { applySpanMode } from "./extraction-span-wire.js";

const TEXT = "Alice moved to Seattle";

test("applySpanMode: disabled or 0 is identity", () => {
  const span = { text: TEXT, start: 6, end: 11 };
  assert.deepEqual(applySpanMode({ enabled: false, ...span }), { text: TEXT });
  assert.deepEqual(applySpanMode({ enabled: 0, ...span }), { text: TEXT });
  assert.deepEqual(applySpanMode(span), { text: TEXT });
});

test("applySpanMode: enabled slices half-open [start, end)", () => {
  assert.deepEqual(applySpanMode({ enabled: true, text: TEXT, start: 6, end: 11 }), {
    text: "moved",
    start: 6,
    end: 11,
  });
});
