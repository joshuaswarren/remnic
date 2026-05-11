import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFullComparableRun,
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
        answer_llm: "gemini:gemini-3.1-pro-preview",
        judge_llm: "gemini:gemini-2.5-flash-lite",
      }),
    /expected mode=rag or mode=single-query/,
  );
});

test("AMB comparator requires public-comparable model identities", () => {
  assert.throws(
    () =>
      assertPublicComparableBeamResult({
        dataset: "beam",
        split: "100k",
        mode: "rag",
        answer_llm: "gemini:gemini-2.5-flash",
        judge_llm: "gemini:gemini-2.5-flash-lite",
      }),
    /expected answer_llm=gemini:gemini-3\.1-pro-preview/,
  );
  assert.doesNotThrow(() =>
    assertPublicComparableBeamResult({
      dataset: "beam",
      split: "100k",
      mode: "rag",
      answer_llm: "gemini:gemini-3.1-pro-preview",
      judge_llm: "gemini:gemini-2.5-flash-lite",
    }),
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

test("AMB comparator rejects partial query-limit results", () => {
  assert.throws(
    () =>
      assertFullComparableRun(
        {
          split: "100k",
          total_queries: 20,
          results: Array.from({ length: 20 }, (_, index) => ({ query_id: String(index) })),
        },
        { total_queries: 400 },
      ),
    /expected full split with total_queries=400/,
  );
});

test("AMB comparator rejects mismatched result counts", () => {
  assert.throws(
    () =>
      assertFullComparableRun(
        {
          split: "100k",
          total_queries: 400,
          results: Array.from({ length: 399 }, (_, index) => ({ query_id: String(index) })),
        },
        { total_queries: 400 },
      ),
    /result\.results length 399 does not match total_queries=400/,
  );
});
