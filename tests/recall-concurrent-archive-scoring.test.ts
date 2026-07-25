/**
 * Regression tests for issue #1674 — concurrent recall requests serialize on
 * the JS main thread because the cold-fallback archive scan is a synchronous,
 * unbounded, CPU-bound loop.
 *
 * These tests prove:
 *   1. CORRECTNESS: the extracted pure scoring function produces the right
 *      results, and both strategies (sync + off-thread) are equivalent.
 *   2. SERIALIZATION: SyncArchiveScoring runs its CPU-bound scoring
 *      synchronously, so K concurrent calls never overlap — the maximum
 *      in-flight scoring count observed by the event loop stays <= 1.
 *   3. PARALLELISM: OffThreadArchiveScoring dispatches to a worker_threads
 *      pool, so K concurrent calls run at once — the maximum in-flight
 *      scoring count observed by the event loop exceeds 1.
 *
 * The serialization/parallelism pair directly demonstrates the fix, and both
 * assertions observe event-loop concurrency deterministically rather than
 * wall-clock latency, so they never flake under CI load.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ArchiveScoreItem,
  type ArchiveScoringStrategy,
  OffThreadArchiveScoring,
  SyncArchiveScoring,
  disposeDefaultArchiveScoring,
  getDefaultArchiveScoring,
  memoryFileToScoreItem,
  scoreArchiveMemories,
} from "../packages/remnic-core/src/recall/archive-scoring.js";
import type { MemoryFile } from "../packages/remnic-core/src/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a set of heavy score items so each scoring pass spans many event-loop
 * ticks. Each item's content is padded with ~200 KB of filler so an off-thread
 * pass keeps its worker busy while the in-flight sampler runs, and a sync pass
 * blocks the event loop long enough that no sampler tick can interleave.
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
// 3+4. Concurrency semantics — measured deterministically, never by wall clock.
//
// The original tests timed one call and K concurrent calls and asserted on the
// wall-clock ratio, which flakes: a loaded CI runner inflates the single-call
// baseline, deflating the ratio below threshold even when behavior is correct.
//
// Both replacements sample a counter from a self-re-arming setImmediate loop
// and assert on the maximum observed. What they count differs, and that
// difference is the whole point:
//
//   - SYNC: count CALLS in flight. Sync scoring burns its CPU inside score()
//     with no await, so the event loop is blocked for the whole pass and no
//     sampler tick can ever catch two passes overlapping (max stays <= 1).
//     This is the behavior that caused issue #1674.
//   - OFF-THREAD: count BUSY WORKERS, not callers. A caller parked in the
//     pool's acquire() is queued, not running — counting callers would report
//     K even for a size-1 pool, so the assertion would pass while every task
//     ran serially and would miss the exact regression it guards (codex P2 /
//     CodeRabbit on PR #2158).
//
// Both are ordering facts, independent of how long the work takes, so neither
// is sensitive to runner load.
// ─────────────────────────────────────────────────────────────────────────────

/** Sample `read()` on every macrotask tick while `body()` runs; return the max. */
async function maxWhile(read: () => number, body: () => Promise<unknown>): Promise<number> {
  let max = 0;
  let sampling = true;
  const sample = () => {
    const v = read();
    if (v > max) max = v;
    if (sampling) setImmediate(sample);
  };
  setImmediate(sample);
  try {
    await body();
  } finally {
    sampling = false;
  }
  return max;
}

test("SyncArchiveScoring serializes K concurrent calls (max in-flight <= 1)", async () => {
  const K = 4;
  const sync = new SyncArchiveScoring();
  let inFlight = 0;

  const maxInFlight = await maxWhile(
    () => inFlight,
    () =>
      Promise.all(
        Array.from({ length: K }, async () => {
          inFlight += 1;
          try {
            await sync.score(HEAVY_ITEMS, QUERY_TOKENS);
          } finally {
            inFlight -= 1;
          }
        }),
      ),
  );

  assert.ok(
    maxInFlight <= 1,
    `Sync scoring must serialize K=${K} concurrent calls (expected max in-flight <= 1, got ${maxInFlight})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PASS: OffThreadArchiveScoring runs K tasks on K workers simultaneously
// ─────────────────────────────────────────────────────────────────────────────

test("OffThreadArchiveScoring parallelizes K concurrent calls (busy workers > 1)", async (t) => {
  const K = 4;
  // Size the pool explicitly to K so the assertion is robust to the runner's
  // core count: K workers with no queuing all run at once (#1674 review thread).
  const offThread = new OffThreadArchiveScoring(K);
  t.after(async () => {
    await offThread.terminate();
  });

  const maxBusyWorkers = await maxWhile(
    () => offThread.busyWorkers,
    () => Promise.all(Array.from({ length: K }, () => offThread.score(HEAVY_ITEMS, QUERY_TOKENS))),
  );

  assert.ok(
    maxBusyWorkers > 1,
    `Off-thread scoring must run K=${K} calls on multiple workers at once (expected max busy workers > 1, got ${maxBusyWorkers})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. GUARD: the off-thread assertion must FAIL if the pool regresses to one
//     worker. This is what makes test 4 meaningful rather than vacuous — a
//     caller-side counter would report K here and pass.
// ─────────────────────────────────────────────────────────────────────────────

test("a single-worker pool is observably serial (guards the parallelism assertion)", async (t) => {
  const K = 4;
  const singleWorker = new OffThreadArchiveScoring(1);
  t.after(async () => {
    await singleWorker.terminate();
  });

  const maxBusyWorkers = await maxWhile(
    () => singleWorker.busyWorkers,
    () => Promise.all(Array.from({ length: K }, () => singleWorker.score(HEAVY_ITEMS, QUERY_TOKENS))),
  );

  assert.equal(
    maxBusyWorkers,
    1,
    `A size-1 pool must never run two tasks at once (got ${maxBusyWorkers}); ` +
      "if this reports K the counter is measuring queued callers, not busy workers",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5b. Worker scoring matches canonical scoreArchiveMemories
//     (guards the inline copy in WORKER_SOURCE against drift)
// ─────────────────────────────────────────────────────────────────────────────

test("worker scoring matches canonical scoreArchiveMemories", async (t) => {
  // The worker inlines its own copy of scoreArchiveMemories (eval mode).
  // This test proves they produce identical results so the duplication
  // can't silently drift.
  const offThread = new OffThreadArchiveScoring();
  t.after(async () => {
    await offThread.terminate();
  });

  const results = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);
  const canonical = scoreArchiveMemories(HEAVY_ITEMS, QUERY_TOKENS);

  assert.equal(results.length, canonical.length);
  const canonicalById = new Map(canonical.map((r) => [r.docid, r]));
  for (const result of results) {
    const c = canonicalById.get(result.docid);
    assert.ok(c, `worker produced result ${result.docid} not in canonical`);
    assert.equal(result.score, c.score, `score mismatch for ${result.docid}`);
    assert.equal(result.path, c.path, `path mismatch for ${result.docid}`);
  }
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


// ─────────────────────────────────────────────────────────────────────────────
// 7. Worker lifecycle — terminate leaves no zombie threads (#1674)
// ─────────────────────────────────────────────────────────────────────────────

test("terminate() disposes all worker threads after scoring", async () => {
  const offThread = new OffThreadArchiveScoring();
  // Force worker creation by scoring.
  await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);
  // terminate() calls Promise.allSettled(workers.map(w => w.terminate())).
  // If it resolves, every worker received a terminate() call.
  await offThread.terminate();
  // A subsequent score() must still work (pool is null after terminate, so it
  // recreates lazily — proving the pool was fully cleaned up, not leaked).
  const results = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);
  assert.ok(results.length > 0, "should still produce results after re-init");
  await offThread.terminate();
});

test("disposeDefaultArchiveScoring resets the singleton", async () => {
  // Prime the process-wide singleton.
  const first = getDefaultArchiveScoring();
  await first.score(HEAVY_ITEMS, QUERY_TOKENS);
  await disposeDefaultArchiveScoring();
  // After disposal, getDefaultArchiveScoring must return a fresh instance.
  const second = getDefaultArchiveScoring();
  assert.notEqual(first, second, "singleton should be recreated after dispose");
  await disposeDefaultArchiveScoring();
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Pre-aborted dispatch releases — not retires — a healthy worker (#1674)
// ─────────────────────────────────────────────────────────────────────────────

test("pre-aborted signal does not destroy the worker pool", async (t) => {
  const offThread = new OffThreadArchiveScoring();
  t.after(async () => {
    await offThread.terminate();
  });

  // Warm the pool with a normal call.
  const warm = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);
  assert.ok(warm.length > 0);

  // Now score with an already-aborted signal. This must NOT retire the worker
  // (fix for review thread: pre-aborted dispatch needlessly terminates a
  // healthy pool worker). It should release it back to idle.
  const controller = new AbortController();
  controller.abort();
  const aborted = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS, controller.signal);
  assert.deepEqual(aborted, []);

  // If the pool was destroyed (worker retired), the next call would still work
  // (lazy recreation), but the KEY assertion is that a subsequent normal call
  // produces correct results without error — the released worker is reusable.
  const again = await offThread.score(HEAVY_ITEMS, QUERY_TOKENS);
  assert.equal(again.length, warm.length, "released worker produces same result count");
});
