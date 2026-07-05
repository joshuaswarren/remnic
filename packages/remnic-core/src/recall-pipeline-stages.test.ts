// Issue #1539 PR2 — unit tests for the recall pipeline spine module.
//
// These tests verify `unifiedDedupeAndRank` produces the correct results for
// each declared divergence dimension, WITHOUT changing any existing pipeline.
// PRs 3–6 will migrate each pipeline to call this function; at that point the
// characterization snapshots (tests/recall-pipeline-unified.test.ts) verify
// end-to-end byte-for-byte parity.

import assert from "node:assert/strict";
import test from "node:test";

import type { EvidencePackItem } from "./evidence-pack.js";
import {
  unifiedDedupeAndRank,
  type RankedEvidenceItem,
} from "./recall-pipeline-stages.js";

const NO_INTENTS: never[] = [];
const constantScorer = (_item: EvidencePackItem): number => 10;

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

test("unifiedDedupeAndRank: dedup collapses identical ids", () => {
  const items = [
    item(3, "Content A"),
    item(3, "Content A"), // same id → deduped
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.turnIndex, 3);
});

test("unifiedDedupeAndRank: dedup collapses identical normalized content under different ids", () => {
  const items = [
    item(10, "My monthly expenses are $2,400."),
    item(11, "MY   MONTHLY   EXPENSES ARE $2,400."), // same normalized content
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer,
  });
  assert.equal(result.length, 1, "expected content dedup to collapse the two items");
  assert.equal(result[0]?.turnIndex, 10, "first-seen wins");
});

test("unifiedDedupeAndRank: DESC sort (default) orders turnIndex descending on score ties", () => {
  const items = [
    item(2, "Oldest"),
    item(5, "Middle"),
    item(9, "Newest"),
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer, // all tied → turnIndex DESC
  });
  const turns = result.map((r) => r.turnIndex);
  assert.deepEqual(turns, [9, 5, 2]);
});

test("unifiedDedupeAndRank: ASC sort orders turnIndex ascending on score ties", () => {
  const items = [
    item(30, "Latest"),
    item(10, "Earliest"),
    item(20, "Middle"),
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer,
    turnIndexSortDirection: "asc",
  });
  const turns = result.map((r) => r.turnIndex);
  assert.deepEqual(turns, [10, 20, 30]);
});

test("unifiedDedupeAndRank: rank primary key is always DESC regardless of turnIndex direction", () => {
  const items = [
    item(1, "Low rank", { score: 0 }),
    item(2, "High rank", { score: 0 }),
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: (i) => (i.turnIndex === 2 ? 100 : 1),
    turnIndexSortDirection: "asc",
  });
  // rank DESC wins over turnIndex ASC: turn 2 (rank 100) comes first despite ASC.
  assert.equal(result[0]?.turnIndex, 2);
  assert.equal(result[1]?.turnIndex, 1);
});

test("unifiedDedupeAndRank: rankThreshold drops items below the declared threshold", () => {
  const items = [
    item(1, "Weak", { score: 0 }),
    item(2, "Strong", { score: 0 }),
    item(3, "Medium", { score: 0 }),
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: (i) => {
      if (i.turnIndex === 1) return 3;
      if (i.turnIndex === 2) return 10;
      return 6;
    },
    rankThreshold: 6,
  });
  const turns = result.map((r) => r.turnIndex).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(turns, [2, 3], "turn 1 (rank 3) is below threshold 6 and dropped");
});

test("unifiedDedupeAndRank: transformContent is applied to output but NOT to scorer input", () => {
  const items = [item(5, "original content")];
  let scorerSawTransformed = false;
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: (i) => {
      if (i.content.includes("APPENDED CUE")) scorerSawTransformed = true;
      return 5;
    },
    transformContent: (content) => `${content}\nAPPENDED CUE`,
  });
  assert.equal(scorerSawTransformed, false, "scorer must see ORIGINAL content");
  assert.ok(result[0]?.content.includes("APPENDED CUE"), "output must have transformed content");
});

test("unifiedDedupeAndRank: undefined turnIndex sorts to the bottom of DESC (-1 sentinel)", () => {
  const items = [
    item(5, "Has turn"),
    { id: "s1:x", sessionId: "s1", role: "user", content: "No turn" }, // no turnIndex
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer,
    // default DESC
  });
  assert.equal(result[1]?.id, "s1:x", "undefined-turnIndex item sorts last in DESC");
});

test("unifiedDedupeAndRank: undefined turnIndex sorts to the bottom of ASC (MAX sentinel)", () => {
  const items = [
    item(5, "Has turn"),
    { id: "s1:x", sessionId: "s1", role: "user", content: "No turn" },
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer,
    turnIndexSortDirection: "asc",
  });
  assert.equal(result[1]?.id, "s1:x", "undefined-turnIndex item sorts last in ASC");
});

test("unifiedDedupeAndRank: DESC tertiary tiebreaker is score DESC", () => {
  // Same rank (all tied via constantScorer) AND same turnIndex → score breaks the tie.
  const items = [
    item(5, "Low score", { score: 10 }),
    item(5, "High score", { score: 90 }), // same turn, deduped by content? No — different content
  ];
  // Wait — both have turn 5 so same id "s1:5" → second is deduped. Use different sessions.
  const itemsDistinct: EvidencePackItem[] = [
    { id: "s1:5", sessionId: "s1", turnIndex: 5, role: "user", content: "A", score: 10 },
    { id: "s2:5", sessionId: "s2", turnIndex: 5, role: "user", content: "B", score: 90 },
  ];
  const result = unifiedDedupeAndRank(itemsDistinct, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer, // rank tied → turnIndex tied → score DESC
  });
  assert.equal(result[0]?.id, "s2:5", "higher score (90) ranks first on DESC tertiary");
  assert.equal(result[1]?.id, "s1:5");
});

test("unifiedDedupeAndRank: ASC tertiary tiebreaker is content.localeCompare", () => {
  const items: EvidencePackItem[] = [
    { id: "s2:5", sessionId: "s2", turnIndex: 5, role: "user", content: "Banana" },
    { id: "s1:5", sessionId: "s1", turnIndex: 5, role: "user", content: "Apple" },
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer, // rank tied → turnIndex tied → content localeCompare
    turnIndexSortDirection: "asc",
  });
  assert.equal(result[0]?.content, "Apple", "localeCompare ASC: Apple < Banana");
  assert.equal(result[1]?.content, "Banana");
});

test("unifiedDedupeAndRank: RankedEvidenceItem carries the computed rank", () => {
  const items = [item(1, "content")];
  const result: RankedEvidenceItem[] = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: () => 42,
  });
  assert.equal(result[0]?.rank, 42);
});

test("unifiedDedupeAndRank: fallback id uses sessionId:turnIndex when id is absent", () => {
  const items: EvidencePackItem[] = [
    { sessionId: "s1", turnIndex: 7, role: "user", content: "No explicit id" },
    { sessionId: "s1", turnIndex: 7, role: "user", content: "Same fallback id → deduped" },
  ];
  const result = unifiedDedupeAndRank(items, {
    query: "q",
    intents: NO_INTENTS,
    scoreEvidence: constantScorer,
  });
  assert.equal(result.length, 1, "fallback id dedup must collapse the two items");
});
