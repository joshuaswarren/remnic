import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicComparableBeamResult,
  findSplitSota,
  normalizeBeamMode,
} from "../integrations/amb/compare-beam-result.mjs";

test("AMB comparator treats current rag mode as public single-query mode", () => {
  assert.equal(normalizeBeamMode("rag"), "single-query");
  assert.equal(normalizeBeamMode("single-query"), "single-query");
});

test("AMB comparator rejects non-comparable BEAM modes", () => {
  assert.throws(
    () =>
      assertPublicComparableBeamResult({
        dataset: "beam",
        split: "100k",
        mode: "agentic-rag",
      }),
    /expected mode=rag or mode=single-query/,
  );
});

test("AMB comparator finds SOTA for the normalized single-query mode only", () => {
  const sota = findSplitSota([
    {
      dataset: "beam",
      split: "100k",
      mode: "agentic-rag",
      accuracy: 0.99,
    },
    {
      dataset: "beam",
      split: "100k",
      mode: "single-query",
      accuracy: 0.73,
    },
    {
      dataset: "beam",
      split: "100k",
      mode: "rag",
      accuracy: 0.74,
    },
  ], "100k", "rag");

  assert.equal(sota.mode, "rag");
  assert.equal(sota.accuracy, 0.74);
});
