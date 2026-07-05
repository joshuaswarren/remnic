// Issue #1539 PRs 3–6 — migration parity guards.
//
// Each recall pipeline (targeted-fact, response-guidance, explicit-cue,
// event-order) was migrated from an inline dedup/score/threshold/sort block to
// a thin config object handed to `unifiedDedupeAndRank` (the spine). The
// per-tier test files (targeted-fact-recall.test.ts etc.) are the end-to-end
// characterization — they exercise buildXxxRecallSection on full fixtures. This
// file is the SEAM guard: it pins, per pipeline, that the declared config shape
// routes through the spine with the correct divergence (sort direction,
// content-dedup on/off, rank threshold, transform-applied-to-output-but-not-
// score). If a future refactor flips one of these silently, the matching test
// here fails BEFORE the end-to-end suites have a chance to mask it.
//
// These tests do NOT re-implement the per-tier scorers — those are genuinely
// per-tier policy and stay in the per-tier test files. Here we use small
// representative scorers that exercise the divergence dimension each pipeline
// declares on the spine.

import assert from "node:assert/strict";
import test from "node:test";

import type { EvidencePackItem } from "./evidence-pack.js";
import { unifiedDedupeAndRank } from "./recall-pipeline-stages.js";

function item(
  turnIndex: number,
  content: string,
  overrides: Partial<EvidencePackItem> = {},
): EvidencePackItem {
  return {
    id: `s1:${turnIndex}`,
    sessionId: "s1",
    turnIndex,
    role: "user",
    content,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PR3 — targeted-fact shape: DESC, content-dedup, transform-applied-to-output,
// score-on-original. No rank threshold.
// ---------------------------------------------------------------------------

test("parity targeted-fact: DESC ordering on score ties (latest turnIndex first)", () => {
  const items = [
    item(1, "early turn"),
    item(5, "late turn"),
    item(3, "middle turn"),
  ];
  // Constant scorer forces score ties so turnIndex DESC is the deciding key.
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 10,
  });
  assert.equal(ranked[0].turnIndex, 5);
  assert.equal(ranked[1].turnIndex, 3);
  assert.equal(ranked[2].turnIndex, 1);
});

test("parity targeted-fact: content transform applied to output, NOT to scorer input", () => {
  const items = [item(2, "Revenue was $500")];
  // A scorer that reads ORIGINAL content must NOT see the appended cue suffix.
  let scorerObserved = "";
  unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: (original) => {
      scorerObserved = original.content;
      return 1;
    },
    transformContent: (content) => `${content} [CUE]`,
  });
  assert.equal(scorerObserved, "Revenue was $500");
  // ...and the output content carries the transform:
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 1,
    transformContent: (content) => `${content} [CUE]`,
  });
  assert.equal(ranked[0].content, "Revenue was $500 [CUE]");
});

test("parity targeted-fact: duplicate normalized content collapses (default dedupByContent)", () => {
  const items = [
    item(1, "Same content"),
    item(2, "same   content"), // whitespace/case differences normalize equal
    item(3, "Distinct"),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 10,
  });
  assert.equal(ranked.length, 2);
  // First-seen wins: turnIndex 1 is kept, turnIndex 2 (same normalized content)
  // is dropped. Output is then sorted DESC by turnIndex on the score tie.
  assert.deepEqual(
    ranked.map((r) => r.turnIndex),
    [3, 1],
  );
});

// ---------------------------------------------------------------------------
// PR4 — response-guidance shape: same as targeted-fact (DESC + content-dedup +
// transform + score-on-original) but with guidance-cue transform. Pin the shape
// matches; the guidance-specific transform is exercised end-to-end in
// response-guidance-recall.test.ts.
// ---------------------------------------------------------------------------

test("parity response-guidance: DESC ordering on score ties", () => {
  const items = [
    item(2, "guidance b"),
    item(7, "guidance a"),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 5,
  });
  assert.equal(ranked[0].turnIndex, 7);
  assert.equal(ranked[1].turnIndex, 2);
});

test("parity response-guidance: rank primary key always DESC regardless of turnIndex", () => {
  const items = [
    item(1, "low rank high turnIndex"),
    item(9, "high rank low turnIndex"),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: (original) => (original.content.includes("high rank") ? 20 : 1),
  });
  assert.equal(ranked[0].turnIndex, 9);
  assert.equal(ranked[1].turnIndex, 1);
});

// ---------------------------------------------------------------------------
// PR5 — explicit-cue shape: no scoring (constant scorer — the "intentional
// no-scoring behavior" made explicit by the config), DESC default, content-dedup.
// ---------------------------------------------------------------------------

test("parity explicit-cue: constant scorer reduces to turnIndex DESC ordering", () => {
  const items = [
    item(2, "explicit cue b"),
    item(4, "explicit cue a"),
    item(1, "explicit cue c"),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 1, // explicit-cue does not score
  });
  assert.deepEqual(
    ranked.map((r) => r.turnIndex),
    [4, 2, 1],
  );
});

// ---------------------------------------------------------------------------
// PR6 — event-order shape: ASC ordering, NO content-dedup (dedupByContent:false
// keeps distinct turns even when cue-appended bodies match), declared
// rankThreshold of 6, transform applied to output.
// ---------------------------------------------------------------------------

test("parity event-order: ASC ordering on rank ties (earliest turnIndex first)", () => {
  const items = [
    item(5, "turn five"),
    item(1, "turn one"),
    item(3, "turn three"),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 10,
    turnIndexSortDirection: "asc",
  });
  assert.deepEqual(
    ranked.map((r) => r.turnIndex),
    [1, 3, 5],
  );
});

test("parity event-order: dedupByContent false keeps distinct turns with identical bodies", () => {
  // Two distinct turns (different ids/turnIndex) but identical cue-appended body.
  // Event-order MUST keep both — they are legitimate repeated turns in a
  // chronological transcript. This is the cursor-bugbot a4299851 regression guard.
  const items = [
    item(1, "the user asked again"),
    item(4, "the user asked again"),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 10,
    dedupByContent: false,
    turnIndexSortDirection: "asc",
  });
  assert.equal(ranked.length, 2);
  assert.deepEqual(
    ranked.map((r) => r.turnIndex),
    [1, 4],
  );
});

test("parity event-order: declared rankThreshold (6) drops below-threshold items", () => {
  const items = [
    item(1, "strong", { id: "s:1" }),
    item(2, "weak", { id: "s:2" }),
    item(3, "borderline", { id: "s:3" }),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: (original) => {
      if (original.content === "strong") return 10;
      if (original.content === "borderline") return 6; // exactly threshold -> kept (>=)
      return 5; // weak -> dropped
    },
    rankThreshold: 6,
    turnIndexSortDirection: "asc",
  });
  // rank is ALWAYS DESC primary: strong (10) outranks borderline (6).
  // turnIndex ASC only breaks ties within the same rank.
  assert.deepEqual(
    ranked.map((r) => r.content),
    ["strong", "borderline"],
  );
});

// ---------------------------------------------------------------------------
// Cross-pipeline divergence guard: the SAME corpus produces DIFFERENT orderings
// under DESC vs ASC config. This is the core #1539 defect class — copy-pasting
// the comparator into a chronological pipeline silently inverts ordering.
// ---------------------------------------------------------------------------

test("parity divergence: DESC vs ASC configs on the same corpus invert turnIndex ordering", () => {
  const corpus = [
    item(1, "a", { id: "x:1" }),
    item(2, "b", { id: "x:2" }),
    item(3, "c", { id: "x:3" }),
  ];
  const desc = unifiedDedupeAndRank(corpus, {
    query: "",
    intents: [],
    scoreEvidence: () => 10,
  });
  const asc = unifiedDedupeAndRank(corpus, {
    query: "",
    intents: [],
    scoreEvidence: () => 10,
    turnIndexSortDirection: "asc",
  });
  assert.deepEqual(
    desc.map((r) => r.turnIndex),
    [3, 2, 1],
  );
  assert.deepEqual(
    asc.map((r) => r.turnIndex),
    [1, 2, 3],
  );
});
