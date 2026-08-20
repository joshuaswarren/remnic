import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TRAVERSE_LIMIT } from "./recall-navigate-traverse.js";
import { selectTraverseNeighbors } from "./recall-navigate-traverse.js";

test("no relation returns all known-type links sorted", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "m-3", linkType: "supports" },
      { targetId: "m-1", linkType: "elaborates" },
      { targetId: "m-2", linkType: "causes" },
    ],
  });
  assert.ok(result.ok);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.neighbors, [
    { targetId: "m-2", linkType: "causes" },
    { targetId: "m-1", linkType: "elaborates" },
    { targetId: "m-3", linkType: "supports" },
  ]);
});

test("relation filter returns only that relation", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "m-1", linkType: "supports" },
      { targetId: "m-2", linkType: "contradicts" },
      { targetId: "m-3", linkType: "supports" },
    ],
    relation: "supports",
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [
    { targetId: "m-1", linkType: "supports" },
    { targetId: "m-3", linkType: "supports" },
  ]);
});

test("unknown relation is refused with unknown_relation", () => {
  const result = selectTraverseNeighbors({
    links: [{ targetId: "m-1", linkType: "supports" }],
    relation: "destroys",
  });
  assert.deepEqual(result, { ok: false, error: "unknown_relation" });
});

test("unknown linkType link is skipped while siblings survive", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "m-1", linkType: "hyperlinks" },
      { targetId: "m-2", linkType: "supports" },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [{ targetId: "m-2", linkType: "supports" }]);
});

test("duplicate targetIds collapse to the first occurrence", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "m-1", linkType: "causes" },
      { targetId: "m-1", linkType: "supports" },
      { targetId: "m-2", linkType: "elaborates" },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [
    { targetId: "m-1", linkType: "causes" },
    { targetId: "m-2", linkType: "elaborates" },
  ]);
});

test("blank targetId is skipped", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "", linkType: "supports" },
      { targetId: "  ", linkType: "supports" },
      { targetId: "m-1", linkType: "supports" },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [{ targetId: "m-1", linkType: "supports" }]);
});

test("limit truncates after sorting and sets truncated", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "m-9", linkType: "supports" },
      { targetId: "m-2", linkType: "causes" },
      { targetId: "m-5", linkType: "elaborates" },
    ],
    limit: 2,
  });
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.neighbors, [
    { targetId: "m-2", linkType: "causes" },
    { targetId: "m-5", linkType: "elaborates" },
  ]);
});

test("default limit caps at DEFAULT_TRAVERSE_LIMIT", () => {
  const links = Array.from({ length: DEFAULT_TRAVERSE_LIMIT + 3 }, (_, i) => ({
    targetId: `m-${i}`,
    linkType: "supports",
  }));
  const result = selectTraverseNeighbors({ links });
  assert.ok(result.ok);
  assert.equal(result.truncated, true);
  assert.equal(result.neighbors.length, DEFAULT_TRAVERSE_LIMIT);
});

test("limit 0 is invalid_limit", () => {
  assert.deepEqual(
    selectTraverseNeighbors({ links: [], limit: 0 }),
    { ok: false, error: "invalid_limit" },
  );
});

test("limit -1 is invalid_limit", () => {
  assert.deepEqual(
    selectTraverseNeighbors({ links: [], limit: -1 }),
    { ok: false, error: "invalid_limit" },
  );
});

test("limit 1.5 is invalid_limit", () => {
  assert.deepEqual(
    selectTraverseNeighbors({ links: [], limit: 1.5 }),
    { ok: false, error: "invalid_limit" },
  );
});

test("limit NaN is invalid_limit", () => {
  assert.deepEqual(
    selectTraverseNeighbors({ links: [], limit: Number.NaN }),
    { ok: false, error: "invalid_limit" },
  );
});

test("shuffled input is deep-equal to sorted-input result", () => {
  const sorted = [
    { targetId: "m-2", linkType: "caused_by" },
    { targetId: "m-1", linkType: "causes" },
    { targetId: "m-3", linkType: "elaborates" },
    { targetId: "m-4", linkType: "supports" },
  ];
  const result = selectTraverseNeighbors({
    links: [...sorted].reverse(),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, sorted);
  assert.deepEqual(selectTraverseNeighbors({ links: sorted }), result);
});

test("inputs are not mutated", () => {
  const links = [
    { targetId: "m-2", linkType: "supports" },
    { targetId: "m-1", linkType: "causes" },
  ];
  selectTraverseNeighbors({ links, relation: "causes", limit: 1 });
  assert.deepEqual(links, [
    { targetId: "m-2", linkType: "supports" },
    { targetId: "m-1", linkType: "causes" },
  ]);
});

// Review: the contract said bad stored data is skipped, but a nullish
// targetId threw before the skip checks could run.
test("a nullish or non-string targetId is skipped, never thrown", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: undefined as unknown as string, linkType: "supports" },
      { targetId: null as unknown as string, linkType: "supports" },
      { targetId: 42 as unknown as string, linkType: "supports" },
      { targetId: "m-real", linkType: "supports" },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [{ targetId: "m-real", linkType: "supports" }]);
});

// A padded id is malformed, not a variant of the trimmed id: trimming would
// guess at an identity, so the row is skipped.
test("a whitespace-padded targetId is skipped rather than trimmed", () => {
  const result = selectTraverseNeighbors({
    links: [
      { targetId: " m-1", linkType: "supports" },
      { targetId: "m-2", linkType: "supports" },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [{ targetId: "m-2", linkType: "supports" }]);
});

// Review: dedup ran before sorting, so input order decided which relation
// survived for a doubly-linked target. Sorting first fixes the survivor.
test("a target under two relations keeps the smallest linkType regardless of input order", () => {
  const a = { targetId: "m-1", linkType: "supports" };
  const b = { targetId: "m-1", linkType: "contradicts" };
  const forward = selectTraverseNeighbors({ links: [a, b] });
  const reversed = selectTraverseNeighbors({ links: [b, a] });
  assert.ok(forward.ok && reversed.ok);
  assert.deepEqual(forward.neighbors, reversed.neighbors);
  assert.deepEqual(forward.neighbors, [{ targetId: "m-1", linkType: "contradicts" }]);
});

test("sort-then-dedup also decides which target survives a tight limit", () => {
  const links = [
    { targetId: "m-z", linkType: "supports" },
    { targetId: "m-a", linkType: "supports" },
    { targetId: "m-a", linkType: "elaborates" },
  ];
  const shuffled = selectTraverseNeighbors({ links: [...links].reverse(), limit: 1 });
  const straight = selectTraverseNeighbors({ links, limit: 1 });
  assert.ok(shuffled.ok && straight.ok);
  assert.deepEqual(shuffled.neighbors, straight.neighbors);
  assert.deepEqual(straight.neighbors, [{ targetId: "m-a", linkType: "elaborates" }]);
});
