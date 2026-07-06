/**
 * Regression tests for issue #1674 — concurrent recall requests serialize on
 * the JS main thread because the cold-fallback archive scan is a synchronous,
 * unbounded, CPU-bound loop.
 *
 * These tests prove:
 *   1. CORRECTNESS: the extracted pure scoring function produces the right
 *      results, and both strategies (sync + off-thread) are equivalent.
 *   2. PROVE-FAIL (old serialization): SyncArchiveScoring serializes K
 *      concurrent calls — they take ~K× the single-call latency because the
 *      synchronous loop blocks the event loop for its entire duration.
 *   3. PASS (new parallelism): OffThreadArchiveScoring parallelizes K
 *      concurrent calls via worker_threads — they complete in ~1× (not K×)
 *      the single-call latency.
 *
 * The prove-fail/pass pair directly demonstrates the fix: concurrent recalls
 * no longer serialize on the main thread.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  type ArchiveScoreItem,
  OffThreadArchiveScoring,
  SyncArchiveScoring,
  memoryFileToScoreItem,
  scoreArchiveMemories,
} from "../packages/remnic-core/src/recall/archive-scoring.js";
import type { MemoryFile } from "../packages/remnic-core/src/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a set of heavy score items so each scoring pass takes MEASURABLE time
 * (tens of ms). Each item's content is padded with ~200 KB of filler so the
 * `haystack.includes(token)` inner loop is expensive enough to distinguish
 * serial from parallel execution.
 */
function makeHeavyItems(count: number, matchEveryNth: number): ArchiveScoreItem[] {
  const filler = "the quick brown fox jumps over the lazy dog ".repeat(5_000);
  const items: ArchiveScoreItem[] = [];
  for (let i = 0; i < count; i++) {
    const isMatch = i % matchEveryNth === 0;
    items.push({
      id: `mem-${i.toString().padStart(4, "0")}`,
      path: `/synthetic/archive/mem-${i.toString().padStart(4, "0")}.md`,
      content: isMatch ? `important target keyword discovery ${filler}` : `nothing relevant here at all ${filler}`,
      category: "fact",
      tags: isMatch ? ["discovery", "target"] : ["misc"],
    });
  }
  return items;
}

const HEAVY_ITEMS = makeHeavyItems(40, 5);
const QUERY_TOKENS = ["important", "target", "keyword", "discovery"];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Correctness — pure scoring function
// ─────────────────────────────────────────────────────────────────────────────

test("scoreArchiveMemories: returns scored results for matching memories", () => {
  const items: ArchiveScoreItem[] = [
    {
      id: "a",
      path: "/a.md",
      content: "the alpha beta gamma keyword",
      category: "fact",
      tags: ["alpha"],
    },
    {
      id: "b",
      path: "/b.md",
      content: "no match here",
      category: "preference",
      tags: [],
    },
    {
      id: "c",
      path: "/c.md",
      content: "keyword and alpha both keyword",
      category: "decision",
      tags: ["alpha", "keyword"],
    },
  ];
  const tokens = ["keyword", "alpha"];
  const results = scoreArchiveMemories(items, tokens);
  // Item b has zero hits → dropped. Items a and c each match both tokens.
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.score > 0));
  // Snippets are first 400 chars, newlines collapsed.
  assert.ok(results[0].snippet.length <= 400);
});

test("scoreArchiveMemories: empty inputs return empty", () => {
  assert.deepEqual(scoreArchiveMemories([], ["token"]), []);
  assert.deepEqual(scoreArchiveMemories(HEAVY_ITEMS, []), []);
  assert.deepEqual(scoreArchiveMemories([], []), []);
});

test("scoreArchiveMemories: score is hits/tokens.length", () => {
  const items: ArchiveScoreItem[] = [
    {
      id: "partial",
      path: "/p.md",
      content: "alpha charlie delta",
      category: "fact",
      tags: [],
    },
  ];
  // 1 hit out of 2 tokens = 0.5 (alpha matches, beta does not)
  const results = scoreArchiveMemories(items, ["alpha", "beta"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 0.5);
});

test("memoryFileToScoreItem: projects MemoryFile to serializable shape", () => {
  const memory: MemoryFile = {
    path: "/synthetic/test.md",
    content: "test content",
    frontmatter: {
      id: "test-id",
      category: "fact",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      source: "test",
      confidence: 1,
      confidenceTier: "explicit",
      tags: ["a", "b"],
    },
  };
  const item = memoryFileToScoreItem(memory);
  assert.equal(item.id, "test-id");
  assert.equal(item.path, "/synthetic/test.md");
  assert.equal(item.content, "test content");
  assert.equal(item.category, "fact");
  assert.deepEqual(item.tags, ["a", "b"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Strategy equivalence — sync and off-thread produce identical results
// ─────────────────────────────────────────────────────────────────────────────

test("OffThreadArchiveScoring produces identical results to SyncArchiveScoring", async (t) => {
  const sync = new SyncArchiveScoring();
  const offThread = new OffThreadArchiveScoring();
  t.after(async () => {
    await offThread.terminate();
  });

  const syncResults = await sync.score(HEAVY_ITEMS, QUERY_TOKENS);
  const offThreadResults = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);

  // Same count, same scores, same paths (order may differ only by score ties).
  assert.equal(offThreadResults.length, syncResults.length);
  const syncById = new Map(syncResults.map((r) => [r.docid, r]));
  for (const result of offThreadResults) {
    const syncResult = syncById.get(result.docid);
    assert.ok(syncResult, `off-thread result ${result.docid} not in sync results`);
    assert.equal(result.score, syncResult.score);
    assert.equal(result.path, syncResult.path);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PROVE-FAIL: SyncArchiveScoring serializes K concurrent calls (K× latency)
// ─────────────────────────────────────────────────────────────────────────────

test("SyncArchiveScoring serializes K concurrent calls (~K× single-call latency)", async () => {
  const K = 4;
  const sync = new SyncArchiveScoring();

  // Measure single call.
  const t0 = performance.now();
  await sync.score(HEAVY_ITEMS, QUERY_TOKENS);
  const singleMs = performance.now() - t0;

  // Measure K concurrent calls.
  const t1 = performance.now();
  await Promise.all(Array.from({ length: K }, () => sync.score(HEAVY_ITEMS, QUERY_TOKENS)));
  const concurrentMs = performance.now() - t1;

  const ratio = concurrentMs / singleMs;
  // PROVE-FAIL: sync scoring blocks the event loop, so K concurrent calls
  // serialize — concurrent time should be >= 2.5× single (theoretical K=4×,
  // allowing scheduling slack). This is the behavior that caused issue #1674.
  assert.ok(
    ratio >= 2.5,
    `Sync scoring should serialize K=${K} concurrent calls (expected ratio >= 2.5, got ${ratio.toFixed(2)}; single=${singleMs.toFixed(0)}ms concurrent=${concurrentMs.toFixed(0)}ms)`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PASS: OffThreadArchiveScoring parallelizes K concurrent calls (~1× latency)
// ─────────────────────────────────────────────────────────────────────────────

test("OffThreadArchiveScoring parallelizes K concurrent calls (~1× single-call latency)", async (t) => {
  const K = 4;
  const offThread = new OffThreadArchiveScoring();
  t.after(async () => {
    await offThread.terminate();
  });

  // Measure single call.
  const t0 = performance.now();
  await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);
  const singleMs = performance.now() - t0;

  // Measure K concurrent calls.
  const t1 = performance.now();
  await Promise.all(Array.from({ length: K }, () => offThread.score(HEAVY_ITEMS, QUERY_TOKENS)));
  const concurrentMs = performance.now() - t1;

  const ratio = concurrentMs / singleMs;
  // PASS: off-thread scoring dispatches to separate workers, so K concurrent
  // calls run in parallel — concurrent time should be < 2.0× single (well
  // below the K=4× serialization of sync scoring). This proves the fix.
  assert.ok(
    ratio < 2.0,
    `Off-thread scoring should parallelize K=${K} concurrent calls (expected ratio < 2.0, got ${ratio.toFixed(2)}; single=${singleMs.toFixed(0)}ms concurrent=${concurrentMs.toFixed(0)}ms)`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Abort signal — both strategies respect abort at boundaries
// ─────────────────────────────────────────────────────────────────────────────

test("SyncArchiveScoring respects pre-existing abort signal", async () => {
  const sync = new SyncArchiveScoring();
  const controller = new AbortController();
  controller.abort();
  const results = await sync.score(HEAVY_ITEMS, QUERY_TOKENS, controller.signal);
  assert.deepEqual(results, []);
});

test("OffThreadArchiveScoring respects pre-existing abort signal", async (t) => {
  const offThread = new OffThreadArchiveScoring();
  t.after(async () => {
    await offThread.terminate();
  });
  const controller = new AbortController();
  controller.abort();
  const results = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS, controller.signal);
  assert.deepEqual(results, []);
});
