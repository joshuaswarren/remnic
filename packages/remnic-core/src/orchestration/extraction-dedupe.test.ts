import assert from "node:assert/strict";
import test from "node:test";

import type { BufferTurn } from "../types.js";
import { collapseExactDuplicateTurns, markDuplicateTurns } from "./extraction-dedupe.js";

function turn(content: string, overrides: Partial<BufferTurn> = {}): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-16T12:00:00.000Z", ...overrides };
}

test("empty input collapses to nothing", () => {
  const collapsed = collapseExactDuplicateTurns([]);
  assert.equal(collapsed.representatives.length, 0);
  assert.equal(collapsed.representativePositions.length, 0);
  assert.equal(collapsed.duplicateCount, 0);
});

test("unique turns all survive in order", () => {
  const turns = [turn("a"), turn("b"), turn("c")];
  const collapsed = collapseExactDuplicateTurns(turns);
  assert.deepEqual(collapsed.representatives, turns);
  assert.deepEqual(collapsed.representativePositions, [0, 1, 2]);
  assert.equal(collapsed.duplicateCount, 0);
});

test("an exact duplicate collapses to its FIRST occurrence", () => {
  const first = turn("same");
  const second = turn("same", { timestamp: "2026-11-16T12:00:05.000Z" });
  const collapsed = collapseExactDuplicateTurns([first, second]);
  assert.deepEqual(collapsed.representatives, [first], "the first occurrence is the representative");
  assert.deepEqual(collapsed.representativePositions, [0]);
  assert.deepEqual(collapsed.duplicateFlags, [false, true]);
  assert.equal(collapsed.duplicateCount, 1);
});

test("representative order follows first occurrence, not key order", () => {
  const a = turn("a");
  const b = turn("b");
  const a2 = turn("a", { timestamp: "2026-11-16T12:00:09.000Z" });
  const collapsed = collapseExactDuplicateTurns([a, b, a2]);
  assert.deepEqual(collapsed.representatives, [a, b]);
  assert.deepEqual(collapsed.representativePositions, [0, 1]);
});

test("role matters: the same text under different roles is not a duplicate", () => {
  const user = turn("hello");
  const assistant = turn("hello", { role: "assistant" });
  const collapsed = collapseExactDuplicateTurns([user, assistant]);
  assert.equal(collapsed.duplicateCount, 0);
  assert.deepEqual(collapsed.representatives, [user, assistant]);
});

test("the match is whitespace-sensitive and exact", () => {
  const collapsed = collapseExactDuplicateTurns([turn("hello"), turn("hello "), turn(" hello"), turn("Hello")]);
  assert.equal(collapsed.duplicateCount, 0, "trailing space, leading space, and case all differ");
});

test("turns in different write scopes are never collapsed", () => {
  const namespaceA = turn("project note", { writeNamespaceOverride: "ns-a" });
  const namespaceB = turn("project note", { writeNamespaceOverride: "ns-b" });
  const collapsed = collapseExactDuplicateTurns([namespaceA, namespaceB]);
  assert.equal(collapsed.duplicateCount, 0, "different namespace pins are different scopes");
});

test("turns in different coding bindings are never collapsed", () => {
  const repoA = turn("fix the bug", { codingContext: { projectId: "p1", rootPath: "/r1", branch: "main", defaultBranch: "main" } });
  const repoB = turn("fix the bug", { codingContext: { projectId: "p2", rootPath: "/r2", branch: "main", defaultBranch: "main" } });
  const collapsed = collapseExactDuplicateTurns([repoA, repoB]);
  assert.equal(collapsed.duplicateCount, 0, "different project bindings are different scopes");
});

test("accepted captures never collapse with ordinary turns", () => {
  const ordinary = turn("captured text");
  const accepted = turn("captured text", { acceptedCapture: true });
  const collapsed = collapseExactDuplicateTurns([ordinary, accepted]);
  assert.equal(collapsed.duplicateCount, 0);
});

test("scope-identical duplicates within one scope still collapse", () => {
  const first = turn("same", { writeNamespaceOverride: "ns-a" });
  const second = turn("same", { writeNamespaceOverride: "ns-a", timestamp: "2026-11-16T12:00:07.000Z" });
  const collapsed = collapseExactDuplicateTurns([first, second]);
  assert.equal(collapsed.duplicateCount, 1);
  assert.deepEqual(collapsed.representatives, [first]);
});

test("markDuplicateTurns flags only the duplicates of a range, keeping order", () => {
  const turns = [turn("a"), turn("a", { timestamp: "2026-11-16T12:00:02.000Z" }), turn("b")];
  const collapsed = collapseExactDuplicateTurns(turns);
  const marked = markDuplicateTurns(turns, collapsed);
  assert.equal(marked.length, 3);
  assert.equal(marked[0], turns[0], "representatives pass through untouched");
  assert.equal(marked[1]?.extractionDuplicateOf, true, "the duplicate carries the marker");
  assert.equal(marked[1]?.content, "a");
  assert.equal(marked[2]?.extractionDuplicateOf, undefined);
  assert.deepEqual(
    marked.map((markedTurn) => markedTurn.timestamp),
    turns.map((original) => original.timestamp),
    "order and timestamps are preserved",
  );
});
