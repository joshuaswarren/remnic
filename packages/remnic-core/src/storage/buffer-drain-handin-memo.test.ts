import assert from "node:assert/strict";
import test from "node:test";

import { HandInMemo } from "./buffer-drain-handin-memo.js";
import type { BufferEntryState, BufferTurn } from "../types.js";

function turn(content: string, sessionKey = "s1"): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-19T00:00:00.000Z", sessionKey };
}

function entry(turns: BufferTurn[], extra: Partial<BufferEntryState> = {}): BufferEntryState {
  return { turns, lastExtractionAt: null, extractionCount: 0, ...extra };
}

// mergeIntoClaim calls plan() under the claim lock with the inbox stamp, then
// calls plan.remember() with the stamp read AFTER the append landed.
function handIn(memo: HandInMemo, key: string, stamp: string, incoming: BufferEntryState): BufferEntryState | null {
  const plan = memo.plan(key, stamp, incoming);
  if (plan === null) return null;
  plan.remember(stamp);
  return plan.record;
}

test("handin-memo: first hand-in for a claim carries the whole entry", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a"), turn("b")]);

  const record = handIn(memo, "k1", "stamp-1", incoming);

  assert.deepEqual(record, incoming);
});

test("handin-memo: repeated identical hand-in while the stamp holds is dropped", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a"), turn("b")]);
  handIn(memo, "k1", "stamp-1", incoming);

  const record = handIn(memo, "k1", "stamp-1", incoming);

  assert.equal(record, null);
});

test("handin-memo: growth hands in only the new turns", () => {
  const memo = new HandInMemo();
  handIn(memo, "k1", "stamp-1", entry([turn("a"), turn("b")]));

  const record = handIn(memo, "k1", "stamp-1", entry([turn("a"), turn("b"), turn("c")]));

  assert.deepEqual(record?.turns.map((t) => t.content), ["c"]);
});

test("handin-memo: a changed stamp resets the next hand-in to the whole entry", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a"), turn("b")]);
  handIn(memo, "k1", "stamp-1", incoming);

  // Another writer / drainer compaction / re-claim changed the inbox stamp.
  const record = handIn(memo, "k1", "stamp-2", incoming);

  assert.deepEqual(record, incoming);
});

test("handin-memo: remember stores the post-append stamp, not the plan-time stamp", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a"), turn("b")]);

  // The append itself moves the inbox stamp, so the caller re-reads it.
  const first = memo.plan("k1", "before", incoming);
  assert.notEqual(first, null);
  first!.remember("after");

  assert.equal(memo.plan("k1", "after", incoming), null);
});

test("handin-memo: a null stamp from the caller never trusts the memo", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a")]);
  handIn(memo, "k1", "stamp-1", incoming);
  assert.equal(handIn(memo, "k1", "stamp-1", incoming), null, "baseline: memo still valid under the same stamp");

  // A caller that could not read a stamp passes null: the memo is never
  // consulted for that plan.
  assert.deepEqual(memo.plan("k1", null, incoming)?.record, incoming);

  // remember(null) — the merge could not read a post-append stamp — forgets
  // the claim, so the next plan cannot match the old stamp.
  const grown = entry([turn("a"), turn("b")]);
  const plan = memo.plan("k1", "stamp-1", grown);
  assert.notEqual(plan, null);
  plan!.remember(null);

  assert.deepEqual(handIn(memo, "k1", "stamp-1", grown), grown);
});

test("handin-memo: occurrence growth hands in every occurrence of the grown identity", () => {
  const memo = new HandInMemo();
  handIn(memo, "k1", "stamp-1", entry([turn("a")]));

  // The owner now holds two identical turns; the claim needs BOTH copies.
  const incoming = entry([turn("a"), turn("a")]);
  const record = handIn(memo, "k1", "stamp-1", incoming);

  assert.deepEqual(record?.turns.map((t) => t.content), ["a", "a"]);

  // Once remembered, the same pair is not handed in again.
  assert.equal(handIn(memo, "k1", "stamp-1", incoming), null);
});

test("handin-memo: retained turns get the same delta treatment", () => {
  const memo = new HandInMemo();
  handIn(memo, "k1", "stamp-1", entry([turn("a")], { retainedTurns: [turn("r1")] }));

  const record = handIn(memo, "k1", "stamp-1", entry([turn("a")], { retainedTurns: [turn("r1"), turn("r2")] }));

  assert.deepEqual(record?.turns, []);
  assert.deepEqual(record?.retainedTurns?.map((t) => t.content), ["r2"]);
});

test("handin-memo: extraction progress alone still produces a record", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a")], { extractionCount: 1 });
  handIn(memo, "k1", "stamp-1", incoming);

  const record = handIn(memo, "k1", "stamp-1", entry([turn("a")], { extractionCount: 2 }));

  assert.notEqual(record, null);
  assert.deepEqual(record?.turns, []);
  assert.equal(record?.extractionCount, 2);
});

test("handin-memo: claims beyond the cap are evicted and get a full hand-in", () => {
  const memo = new HandInMemo();
  const incoming = entry([turn("a")]);
  for (let i = 0; i < 65; i++) handIn(memo, `k${i}`, `stamp-${i}`, incoming);

  // k0 was remembered but evicted by the 65th key: same stamp, full entry.
  const record = handIn(memo, "k0", "stamp-0", incoming);

  assert.deepEqual(record, incoming);
});
