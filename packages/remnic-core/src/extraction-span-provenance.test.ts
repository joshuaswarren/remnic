import assert from "node:assert/strict";
import { test } from "node:test";
import { spanToProvenance } from "./extraction-span-provenance.js";

const TEXT = "The quick brown fox jumps over the lazy dog";

test("spanToProvenance: mid-text span yields exact slice with echoed offsets", () => {
  const result = spanToProvenance({ text: TEXT, start: 4, end: 19 });
  assert.deepEqual(result, {
    ok: true,
    provenance: { quote: "quick brown fox", charStart: 4, charEnd: 19 },
  });
  if (result.ok) {
    assert.ok(result.provenance.charEnd >= result.provenance.charStart);
  }
});

test("spanToProvenance: full-text span succeeds", () => {
  const result = spanToProvenance({ text: TEXT, start: 0, end: TEXT.length });
  assert.deepEqual(result, {
    ok: true,
    provenance: { quote: TEXT, charStart: 0, charEnd: TEXT.length },
  });
});

test("spanToProvenance: matching supplied quote succeeds", () => {
  const result = spanToProvenance({ text: TEXT, start: 4, end: 9, quote: "quick" });
  assert.deepEqual(result, {
    ok: true,
    provenance: { quote: "quick", charStart: 4, charEnd: 9 },
  });
});

test("spanToProvenance: whitespace-differing quote is quote_mismatch", () => {
  const result = spanToProvenance({ text: TEXT, start: 4, end: 15, quote: "quick  brown" });
  assert.deepEqual(result, { ok: false, error: "quote_mismatch" });
});

test("spanToProvenance: paraphrase is quote_mismatch", () => {
  const result = spanToProvenance({ text: TEXT, start: 4, end: 19, quote: "a fast fox" });
  assert.deepEqual(result, { ok: false, error: "quote_mismatch" });
});

test("spanToProvenance: empty span", () => {
  assert.deepEqual(spanToProvenance({ text: TEXT, start: 3, end: 3 }), {
    ok: false,
    error: "empty_span",
  });
  assert.deepEqual(spanToProvenance({ text: "", start: 0, end: 0 }), {
    ok: false,
    error: "empty_span",
  });
});

test("spanToProvenance: out of range", () => {
  assert.deepEqual(spanToProvenance({ text: TEXT, start: -1, end: 4 }), {
    ok: false,
    error: "out_of_range",
  });
  assert.deepEqual(spanToProvenance({ text: TEXT, start: 0, end: TEXT.length + 1 }), {
    ok: false,
    error: "out_of_range",
  });
  assert.deepEqual(spanToProvenance({ text: TEXT, start: 10, end: 4 }), {
    ok: false,
    error: "out_of_range",
  });
});

test("spanToProvenance: non-integers and non-finite offsets throw", () => {
  assert.throws(() => spanToProvenance({ text: TEXT, start: 1.5, end: 4 }), /integers/);
  assert.throws(() => spanToProvenance({ text: TEXT, start: 0, end: 3.2 }), /integers/);
  assert.throws(() => spanToProvenance({ text: TEXT, start: Number.NaN, end: 4 }), /integers/);
  assert.throws(
    () => spanToProvenance({ text: TEXT, start: 0, end: Number.POSITIVE_INFINITY }),
    /integers/,
  );
});

test("spanToProvenance: does not mutate the input object", () => {
  const input = { text: TEXT, start: 4, end: 19, quote: "quick brown fox" };
  const snapshot = { ...input };
  spanToProvenance(input);
  assert.deepEqual(input, snapshot);
});
