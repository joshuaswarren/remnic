import assert from "node:assert/strict";
import test from "node:test";

import { findVocabularyGaps } from "../scripts/check-nav-link-vocabularies.mjs";

test("agreeing vocabularies report no gaps", () => {
  const gaps = findVocabularyGaps({
    stepper: ["supports", "supersedes"],
    persisted: ["supports", "related"],
    parser: ["supports", "supersedes", "related", "extra"],
  });
  assert.deepEqual(gaps, [], "a parser superset is the healthy state");
});

// This is the exact divergence that took two review rounds on #1956: the
// shared parser knew the navigation-only names but not the persisted ones,
// so a traversal over real frontmatter silently dropped those neighbors.
test("the original pre-fix divergence is caught", () => {
  const gaps = findVocabularyGaps({
    stepper: ["supports", "contradicts", "elaborates", "causes", "supersedes"],
    persisted: ["follows", "references", "contradicts", "supports", "related"],
    parser: ["supports", "contradicts", "elaborates", "causes", "caused_by"],
  });
  assert.deepEqual(
    gaps.map((gap) => `${gap.missing}:${gap.requiredBy}`),
    [
      "follows:persisted",
      "references:persisted",
      "related:persisted",
      "supersedes:stepper",
    ],
    "every missing type is reported with the list that requires it",
  );
});

test("a stepper-only gap is attributed to the stepper", () => {
  const gaps = findVocabularyGaps({
    stepper: ["supports", "supersedes"],
    persisted: ["supports"],
    parser: ["supports"],
  });
  assert.deepEqual(gaps, [{ missing: "supersedes", requiredBy: "stepper" }]);
});

test("gap order is deterministic regardless of input order", () => {
  const forward = findVocabularyGaps({
    stepper: ["zeta", "alpha"],
    persisted: ["mid"],
    parser: [],
  });
  const reversed = findVocabularyGaps({
    stepper: ["alpha", "zeta"],
    persisted: ["mid"],
    parser: [],
  });
  assert.deepEqual(forward, reversed);
  assert.deepEqual(
    forward.map((gap) => gap.missing),
    ["alpha", "mid", "zeta"],
  );
});

test("a type required by both lists is reported once per requiring list", () => {
  const gaps = findVocabularyGaps({
    stepper: ["shared"],
    persisted: ["shared"],
    parser: [],
  });
  assert.deepEqual(gaps, [
    { missing: "shared", requiredBy: "persisted" },
    { missing: "shared", requiredBy: "stepper" },
  ]);
});
