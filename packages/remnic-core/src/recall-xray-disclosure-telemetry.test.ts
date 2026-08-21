/**
 * Tests for the disclosure-telemetry surface added to Recall X-ray in
 * issue #677 PR 3/4.  Covers:
 *
 *   - `estimateRecallTokens()` heuristic edge cases.
 *   - Per-result `disclosure` + `estimatedTokens` round-trip through
 *     `cloneResult` / `buildXraySnapshot`.
 *   - `summarizeDisclosureTokens()` aggregation across all four buckets.
 *   - Markdown renderer emits the per-disclosure summary table only
 *     when at least one result carries a disclosure level.
 *
 * No real recall data is exercised here; fixtures are synthetic.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildXraySnapshot,
  estimateRecallTokens,
  summarizeDisclosureTokens,
  type RecallXrayResult,
} from "./recall-xray.js";
import { renderXrayMarkdown } from "./recall-xray-renderer.js";

function makeResult(overrides: Partial<RecallXrayResult>): RecallXrayResult {
  return {
    memoryId: overrides.memoryId ?? "mem-1",
    path: overrides.path ?? "/tmp/mem-1.md",
    servedBy: overrides.servedBy ?? "hybrid",
    scoreDecomposition: overrides.scoreDecomposition ?? { final: 0.5 },
    admittedBy: overrides.admittedBy ?? [],
    ...overrides,
  };
}

test("estimateRecallTokens: empty / null / undefined returns 0", () => {
  assert.equal(estimateRecallTokens(""), 0);
  assert.equal(estimateRecallTokens(null), 0);
  assert.equal(estimateRecallTokens(undefined), 0);
});

test("estimateRecallTokens: ~4 chars/token heuristic, ceiling rounded", () => {
  // 8 chars → 2 tokens
  assert.equal(estimateRecallTokens("abcdefgh"), 2);
  // 9 chars → 3 tokens (ceil 9/4)
  assert.equal(estimateRecallTokens("abcdefghi"), 3);
  // 1 char → 1 token (rounding up from 0.25)
  assert.equal(estimateRecallTokens("x"), 1);
});

test("estimateRecallTokens: rejects non-string input gracefully", () => {
  // TypeScript blocks this at the type system but we still want
  // runtime safety for surfaces that pass through unknown payloads.
  assert.equal(estimateRecallTokens(42 as unknown as string), 0);
  assert.equal(estimateRecallTokens({} as unknown as string), 0);
});

test("buildXraySnapshot preserves disclosure + estimatedTokens on results", () => {
  const snap = buildXraySnapshot({
    query: "q",
    results: [
      makeResult({ memoryId: "a", disclosure: "chunk", estimatedTokens: 50 }),
      makeResult({ memoryId: "b", disclosure: "section", estimatedTokens: 200 }),
      makeResult({ memoryId: "c", disclosure: "raw", estimatedTokens: 800 }),
    ],
  });
  assert.equal(snap.results.length, 3);
  assert.equal(snap.results[0]?.disclosure, "chunk");
  assert.equal(snap.results[0]?.estimatedTokens, 50);
  assert.equal(snap.results[1]?.disclosure, "section");
  assert.equal(snap.results[2]?.estimatedTokens, 800);
});

test("buildXraySnapshot drops invalid disclosure + tokens silently (poison guard)", () => {
  const snap = buildXraySnapshot({
    query: "q",
    results: [
      makeResult({
        memoryId: "bad-disc",
        disclosure: "FULL" as unknown as RecallXrayResult["disclosure"],
        estimatedTokens: 100,
      }),
      makeResult({
        memoryId: "neg-tokens",
        disclosure: "chunk",
        estimatedTokens: -5,
      }),
      makeResult({
        memoryId: "nan-tokens",
        disclosure: "chunk",
        estimatedTokens: NaN,
      }),
    ],
  });
  // Invalid disclosure dropped; tokens still preserved (>= 0).
  assert.equal(snap.results[0]?.disclosure, undefined);
  assert.equal(snap.results[0]?.estimatedTokens, 100);
  // Negative tokens dropped; disclosure preserved.
  assert.equal(snap.results[1]?.disclosure, "chunk");
  assert.equal(snap.results[1]?.estimatedTokens, undefined);
  // NaN tokens dropped.
  assert.equal(snap.results[2]?.estimatedTokens, undefined);
});

test("summarizeDisclosureTokens: empty results yield zeroed buckets", () => {
  const summary = summarizeDisclosureTokens([]);
  assert.deepStrictEqual(summary, {
    chunk: { count: 0, estimatedTokens: 0 },
    section: { count: 0, estimatedTokens: 0 },
    raw: { count: 0, estimatedTokens: 0 },
    unspecified: { count: 0, estimatedTokens: 0 },
  });
});

test("summarizeDisclosureTokens: aggregates across buckets including unspecified", () => {
  const results = [
    makeResult({ memoryId: "1", disclosure: "chunk", estimatedTokens: 10 }),
    makeResult({ memoryId: "2", disclosure: "chunk", estimatedTokens: 20 }),
    makeResult({ memoryId: "3", disclosure: "section", estimatedTokens: 100 }),
    makeResult({ memoryId: "4", disclosure: "raw", estimatedTokens: 500 }),
    makeResult({ memoryId: "5" /* no disclosure */, estimatedTokens: 7 }),
    makeResult({ memoryId: "6" /* no disclosure, no tokens */ }),
  ];
  const summary = summarizeDisclosureTokens(results);
  assert.deepStrictEqual(summary, {
    chunk: { count: 2, estimatedTokens: 30 },
    section: { count: 1, estimatedTokens: 100 },
    raw: { count: 1, estimatedTokens: 500 },
    unspecified: { count: 2, estimatedTokens: 7 },
  });
});

test("renderXrayMarkdown: emits token-spend table when any result has disclosure", () => {
  const snap = buildXraySnapshot({
    query: "test",
    results: [
      makeResult({ memoryId: "a", disclosure: "chunk", estimatedTokens: 50 }),
      makeResult({ memoryId: "b", disclosure: "section", estimatedTokens: 200 }),
    ],
  });
  const md = renderXrayMarkdown(snap);
  assert.match(md, /## Results/);
  assert.match(md, /### Token spend by disclosure/);
  assert.match(md, /\| chunk \| 1 \| 50 \|/);
  assert.match(md, /\| section \| 1 \| 200 \|/);
  assert.match(md, /\| raw \| 0 \| 0 \|/);
});

test("renderXrayMarkdown: omits token-spend table when no result has disclosure", () => {
  const snap = buildXraySnapshot({
    query: "test",
    results: [
      makeResult({ memoryId: "a" }),
      makeResult({ memoryId: "b" }),
    ],
  });
  const md = renderXrayMarkdown(snap);
  assert.match(md, /## Results/);
  assert.doesNotMatch(md, /Token spend by disclosure/);
});

test("renderXrayMarkdown: per-result line surfaces disclosure + token estimate", () => {
  const snap = buildXraySnapshot({
    query: "test",
    results: [
      makeResult({ memoryId: "alpha", disclosure: "raw", estimatedTokens: 800 }),
    ],
  });
  const md = renderXrayMarkdown(snap);
  assert.match(md, /\*\*Disclosure:\*\* `raw` \(~800 tokens\)/);
});

test("renderXrayMarkdown: unspecified-disclosure tokens shown as own line", () => {
  const snap = buildXraySnapshot({
    query: "test",
    results: [
      makeResult({ memoryId: "lone", estimatedTokens: 42 }),
    ],
  });
  const md = renderXrayMarkdown(snap);
  assert.match(md, /\*\*Estimated tokens:\*\* 42/);
});
