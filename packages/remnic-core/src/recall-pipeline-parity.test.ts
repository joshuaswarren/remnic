//

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
// ---------------------------------------------------------------------------

test("parity targeted-fact: DESC ordering on score ties (latest turnIndex first)", () => {
  const items = [
    item(1, "early turn"),
    item(5, "late turn"),
    item(3, "middle turn"),
  ];
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
  assert.deepEqual(
    ranked.map((r) => r.turnIndex),
    [3, 1],
  );
});

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

test("parity explicit-cue: preserveInsertionOrder keeps collection order intact", () => {
  const items = [
    item(2, "explicit cue b", { id: "s:2" }),
    item(4, "explicit cue a", { id: "s:4" }),
    item(1, "explicit cue c", { id: "s:1" }),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 0,
    dedupByContent: false,
    preserveInsertionOrder: true,
  });
  assert.deepEqual(
    ranked.map((r) => r.turnIndex),
    [2, 4, 1],
  );
});

test("parity explicit-cue: id-only dedup (dedupByContent false) keeps distinct turns", () => {
  const items = [
    item(1, "same body", { id: "s:1" }),
    item(2, "same body", { id: "s:2" }),
  ];
  const ranked = unifiedDedupeAndRank(items, {
    query: "",
    intents: [],
    scoreEvidence: () => 0,
    dedupByContent: false,
    preserveInsertionOrder: true,
  });
  assert.equal(ranked.length, 2);
});

// ---------------------------------------------------------------------------
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
  assert.deepEqual(
    ranked.map((r) => r.content),
    ["strong", "borderline"],
  );
});

// ---------------------------------------------------------------------------
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
