import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertFullComparableRun,
  assertPublicComparableBeamResult,
  findSplitSota,
  normalizeAccuracy,
  normalizeBeamMode,
  readResult,
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

test("AMB comparator rejects malformed public accuracy rows", () => {
  assert.throws(
    () =>
      findSplitSota([
        {
          dataset: "beam",
          split: "100k",
          mode: "rag",
          accuracy: "not-a-number",
        },
      ], "100k", "rag"),
    /public BEAM row accuracy must be a finite number/,
  );
  assert.throws(
    () =>
      findSplitSota([
        {
          dataset: "beam",
          split: "100k",
          mode: "rag",
          accuracy: null,
        },
      ], "100k", "rag"),
    /public BEAM row accuracy must be a finite number/,
  );
});

test("AMB comparator normalizes numeric public accuracy strings", () => {
  const sota = findSplitSota([
    {
      dataset: "beam",
      split: "100k",
      mode: "rag",
      accuracy: "0.74",
    },
  ], "100k", "rag");

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

test("AMB comparator rejects null accuracy instead of coercing it to zero", () => {
  assert.throws(
    () => normalizeAccuracy({ accuracy: null }),
    /result\.accuracy must be a finite number/,
  );
  assert.throws(
    () => normalizeAccuracy({ accuracy: "0.9" }),
    /result\.accuracy must be a finite number/,
  );
  assert.equal(normalizeAccuracy({ accuracy: 0 }), 0);
});

test("AMB comparator rejects JSON files that are not objects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-amb-compare-"));
  const file = path.join(dir, "result.json");

  try {
    await writeFile(file, "null", "utf8");
    assert.throws(
      () => readResult(file),
      /result file must contain a JSON object/,
    );

    await writeFile(file, "[]", "utf8");
    assert.throws(
      () => readResult(file),
      /result file must contain a JSON object/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
