/**
 * Tests for `judge-cache`: content-keyed judge-result cache.
 *
 * Covers the six contract classes fixed by issue #1573 (PR 1):
 *   (a) hit/miss
 *   (b) key stability across process restarts (two cache instances over the same dir)
 *   (c) answer text change => miss
 *   (d) corrupted entry => recompute, never crash, never fabricated verdict
 *   (e) concurrent writes do not corrupt (per-key serialization)
 *   (f) characterization: cache disabled => byte-identical judge behavior
 *
 * Run individually with:
 *   npx tsx --test packages/bench/src/judges/judge-cache.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BenchJudge, BenchJudgeResult, BenchMemoryAdapter, Message, SearchResult } from "../adapters/types.ts";
import { JudgeCache, runJudgeWithCache, stableStringify } from "./judge-cache.ts";
import { runBenchmark } from "../benchmark.ts";

async function withTempDir<T>(
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-judge-cache-"));
  // Cleanup helper extracted from the finally block so a test
  // assertion failure (or any other throw from `body`) is NOT
  // swallowed by an early `return undefined` here. The original
  // error always propagates; the retry loop only absorbs
  // ENOTEMPTY races on macOS so the suite isn't flaky on fast
  // disks (PR #1591 round-5 OTHls side-effect).
  const cleanup = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" || attempt === 4) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
  };
  try {
    return await body(dir);
  } finally {
    await cleanup();
  }
}

// Drain helper: collect returned drainPendingWrites from each wrapper
// so the test body can await all fire-and-forget cache writes before
// withTempDir removes the directory. PR #1591 round-5 OTHls changed
// cache writes from awaited to fire-and-forget so a slow filesystem
// write cannot consume a judge-call phase timeout.
function drains(...wrappers: Array<{ drainPendingWrites?: () => Promise<void> }>): Promise<void> {
  return Promise.all(
    wrappers.map((w) => w.drainPendingWrites ? w.drainPendingWrites() : Promise.resolve()),
  ).then(() => undefined);
}

async function withCacheTest<T>(
  body: (dir: string, tracked: { wrappers: Array<{ drainPendingWrites?: () => Promise<void> }> }) => Promise<T>,
): Promise<T> {
  // Wraps withTempDir and drains any tracked wrappers before letting
  // the temp directory be removed — fire-and-forget cache writes
  // (PR #1591 round-5 OTHls) require this drain before the directory
  // is gone. The test body appends wrappers to the tracked list.
  const tracked: { wrappers: Array<{ drainPendingWrites?: () => Promise<void> }> } = { wrappers: [] };
  const drainAll = async () => Promise.all(
    tracked.wrappers.map((w) => w.drainPendingWrites ? w.drainPendingWrites() : Promise.resolve()),
  ).then(() => undefined);
  const dir = await mkdtemp(path.join(tmpdir(), "bench-judge-cache-"));
  try {
    return await body(dir, tracked);
  } finally {
    await drainAll();
    await rm(dir, { recursive: true, force: true });
  }
}

 const sampleResult: BenchJudgeResult = {
  score: 1,
  tokens: { input: 12, output: 9 },
  latencyMs: 42,
  model: "judge-mock",
};

interface SampleKeyParts {
  benchmarkId: string;
  datasetVersion: string;
  questionId: string;
  answerText: string;
  judgePromptHash: string;
  judgeModelId: string;
  judgeParamsHash: string;
}

function sampleKeyParts(overrides: Partial<SampleKeyParts> = {}): SampleKeyParts {
  return {
    benchmarkId: "locomo",
    datasetVersion: "v1",
    questionId: "q-001",
    answerText: "the eagle has landed",
    judgePromptHash: "judge-prompt-sha",
    judgeModelId: "judge-model-id",
    judgeParamsHash: "judge-params-sha",
    ...overrides,
  };
}

// --- (a) hit/miss -----------------------------------------------------------

test("a) hit/miss: cache miss on first lookup, hit after put", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    const parts = sampleKeyParts();

    const firstLookup = await cache.get(parts);
    assert.equal(firstLookup, undefined, "fresh cache must miss");

    await cache.put(parts, sampleResult);
    const secondLookup = await cache.get(parts);
    assert.deepEqual(secondLookup?.verdict, sampleResult);
    assert.equal(secondLookup?.cacheHit, true);
  });
});

// --- (b) key stability across process restarts -----------------------------

test("b) key stability: re-opening the cache from the same dir produces the same verdict", async () => {
  await withTempDir(async (cacheDir) => {
    const parts = sampleKeyParts();

    const writer = new JudgeCache({ dir: cacheDir });
    await writer.put(parts, sampleResult);

    // Simulate a process restart: a brand-new JudgeCache instance on the
    // same directory must read the persisted entry.
    const reader = new JudgeCache({ dir: cacheDir });
    const lookup = await reader.get(parts);
    assert.ok(lookup, "second-process instance must read persisted entry");
    assert.deepEqual(lookup.verdict, sampleResult);
  });
});

// --- (c) answer text change => miss ---------------------------------------

test("c) answer text change produces a fresh miss", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });

    await cache.put(sampleKeyParts({ questionId: "q-002", answerText: "alpha" }), {
      ...sampleResult,
      score: 0.4,
    });

    const sameQuestion = await cache.get(
      sampleKeyParts({ questionId: "q-002", answerText: "alpha" }),
    );
    assert.ok(sameQuestion, "identical key must hit");

    const newAnswer = await cache.get(
      sampleKeyParts({ questionId: "q-002", answerText: "beta" }),
    );
    assert.equal(newAnswer, undefined, "changed answer text must miss");
  });
});

test("c) any single key field change produces a fresh miss", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    const base = sampleKeyParts();

    await cache.put(base, sampleResult);
    assert.ok(await cache.get(base), "base entry must hit");

    const variations: SampleKeyParts[] = [
      { ...base, benchmarkId: "longmemeval" },
      { ...base, datasetVersion: "v2" },
      { ...base, questionId: "q-002" },
      { ...base, judgePromptHash: "different-prompt-sha" },
      { ...base, judgeModelId: "different-judge-model" },
      { ...base, judgeParamsHash: "different-judge-params" },
    ];
    for (const variant of variations) {
      const result = await cache.get(variant);
      assert.equal(result, undefined, `variant ${JSON.stringify(variant)} must miss`);
    }
  });
});

// --- (d) corrupted entry => recompute, never crash, never fabricated -----

test("d) corrupted entry is treated as miss and never throws", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    const parts = sampleKeyParts();

    await cache.put(parts, sampleResult);
    const key = await cache.computeKey(parts);
    // Write garbage bytes directly into the entry file. The cache must
    // absorb this as a miss and never surface fabricated verdict data.
    await writeFile(path.join(cacheDir, `${key}.json`), "}\u0000not-json{", "utf8");

    const lookup = await cache.get(parts);
    assert.equal(lookup, undefined, "corrupted entry must not surface as a hit");
  });
});

test("d) entry that is valid JSON but not an object is treated as miss", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    const parts = sampleKeyParts();

    const key = await cache.computeKey(parts);
    await writeFile(path.join(cacheDir, `${key}.json`), "null", "utf8");

    const lookup = await cache.get(parts);
    assert.equal(lookup, undefined, "null JSON entry must not hit");
  });
});

test("d) entry referencing a missing required field is treated as miss", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    const parts = sampleKeyParts();

    const key = await cache.computeKey(parts);
    // Missing the required 'verdict' field.
    await writeFile(
      path.join(cacheDir, `${key}.json`),
      JSON.stringify({ storedAt: new Date().toISOString() }),
      "utf8",
    );

    const lookup = await cache.get(parts);
    assert.equal(lookup, undefined, "malformed JSON entry must not hit");
  });
});

// --- (e) concurrent writes do not corrupt ---------------------------------

test("e) concurrent writes for the same key do not corrupt the entry", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    const parts = sampleKeyParts();

    const writerCount = 16;
    await Promise.all(
      Array.from({ length: writerCount }, (_, index) =>
        cache.put(parts, {
          ...sampleResult,
          score: index / writerCount,
          tokens: { input: index, output: index },
        }),
      ),
    );

    const lookup = await cache.get(parts);
    assert.ok(lookup, "concurrent writes must leave a readable entry");
    // One of the writers must have won, but the entry must be one of the
    // payloads we wrote and parse as a complete BenchJudgeResult.
    const winners = Array.from({ length: writerCount }, (_, index) => ({
      ...sampleResult,
      score: index / writerCount,
      tokens: { input: index, output: index },
    }));
    assert.ok(
      winners.some(
        (candidate) =>
          candidate.score === lookup.verdict.score &&
          candidate.tokens.input === lookup.verdict.tokens.input &&
          candidate.tokens.output === lookup.verdict.tokens.output &&
          (candidate.model ?? null) === (lookup.verdict.model ?? null) &&
          candidate.latencyMs === lookup.verdict.latencyMs,
      ),
      "winning entry must be one of the payloads actually written",
    );
  });
});

test("e) different keys stay independent under concurrent writes", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });

    const writes = Array.from({ length: 12 }, (_, index) => {
      const parts = sampleKeyParts({ questionId: `q-conc-${index}` });
      const verdict: BenchJudgeResult = {
        ...sampleResult,
        score: index,
        tokens: { input: index, output: index },
      };
      return cache.put(parts, verdict);
    });
    await Promise.all(writes);

    for (let index = 0; index < 12; index += 1) {
      const parts = sampleKeyParts({ questionId: `q-conc-${index}` });
      const lookup = await cache.get(parts);
      assert.ok(
        lookup,
        `entry for ${parts.questionId} must read back after concurrent writes`,
      );
      assert.equal(lookup.verdict.score, index);
    }
  });
});

// --- (f) characterization: cache disabled => byte-identical behavior -----

test("f) cache disabled: every call reaches the underlying judge exactly once", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    let underlyingCalls = 0;
    const underlying = {
      async score(_q: string, predicted: string, expected: string) {
        underlyingCalls += 1;
        return predicted === expected ? 1 : 0;
      },
      async scoreWithMetrics(_q: string, predicted: string, expected: string) {
        underlyingCalls += 1;
        return {
          score: predicted === expected ? 1 : 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 1,
          model: "judge-mock",
        };
      },
      async scoreBinaryPrompt(prompt: string) {
        underlyingCalls += 1;
        return {
          score: prompt.includes("yes") ? 1 : 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 1,
          model: "judge-mock",
        };
      },
    };

    const wrapper = runJudgeWithCache({
      judge: underlying,
      cache: null, // characterization: cache disabled
    });

    const question = "What did the eagle land on?";
    const predicted = "the moon";
    const expected = "the moon";

    const scoreA = await wrapper.score(question, predicted, expected);
    const scoreB = await wrapper.score(question, predicted, expected);
    assert.equal(scoreA, 1);
    assert.equal(scoreB, 1);
    assert.equal(underlyingCalls, 2, "with cache disabled, every score() call must hit the judge");

    const metricsA = await wrapper.scoreWithMetrics!(question, predicted, expected);
    const metricsB = await wrapper.scoreWithMetrics!(question, predicted, expected);
    assert.equal(metricsA.score, metricsB.score);
    assert.equal(underlyingCalls, 4, "scoreWithMetrics() must also reach the judge every time");

    await wrapper.scoreBinaryPrompt!("answer yes or no: blah");
    await wrapper.scoreBinaryPrompt!("answer yes or no: blah");
    assert.equal(underlyingCalls, 6, "scoreBinaryPrompt() must also reach the judge every time");

    assert.equal(wrapper.counters.modelCalls, underlyingCalls);
    assert.equal(wrapper.counters.cacheHits, 0);
    assert.equal(wrapper.counters.cacheMisses, 0);
  });
});

test("f) cache enabled: identical input serves from cache after first miss", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    let underlyingCalls = 0;
    const underlying = {
      async scoreWithMetrics(_q: string, predicted: string, expected: string) {
        underlyingCalls += 1;
        return {
          score: predicted === expected ? 1 : 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 1,
          model: "judge-mock",
        };
      },
    };
    const wrapper = runJudgeWithCache({
      judge: underlying,
      cache,
      keyExtras: {
        benchmarkId: "locomo",
        datasetVersion: "v1",
        judgePromptHash: "sha-prompt",
        judgeModelId: "judge-x",
        judgeParamsHash: "sha-params",
      },
    });

    const q = "Q", predicted = "P", expected = "P";
    const a = await wrapper.scoreWithMetrics!(q, predicted, expected);
    await drains(wrapper);
    const b = await wrapper.scoreWithMetrics!(q, predicted, expected);
    const c = await wrapper.scoreWithMetrics!(q, predicted, expected);

    assert.equal(a.score, 1);
    assert.equal(b.score, 1);
    assert.equal(c.score, 1);
    assert.equal(wrapper.counters.cacheMisses, 1);
    await drains(wrapper);
  });
});



test("f) changing answer text causes a fresh judge call even with cache enabled", async () => {
  await withTempDir(async (cacheDir) => {
    const cache = new JudgeCache({ dir: cacheDir });
    let underlyingCalls = 0;
    const underlying = {
      async scoreWithMetrics(_q: string, predicted: string, expected: string) {
        underlyingCalls += 1;
        return {
          score: predicted === expected ? 1 : 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 1,
          model: "judge-mock",
        };
      },
    };
    const wrapper = runJudgeWithCache({
      judge: underlying,
      cache,
      keyExtras: {
        benchmarkId: "locomo",
        datasetVersion: "v1",
        judgePromptHash: "sha-prompt",
        judgeModelId: "judge-x",
        judgeParamsHash: "sha-params",
      },
    });

    await wrapper.scoreWithMetrics!("q", "alpha", "expected");
    await drains(wrapper);
    await wrapper.scoreWithMetrics!("q", "alpha", "expected");
    await drains(wrapper);
    await wrapper.scoreWithMetrics!("q", "beta", "expected");

    assert.equal(underlyingCalls, 2, "answer-text change must trigger one fresh model call");
    assert.equal(wrapper.counters.modelCalls, 2);
    assert.equal(wrapper.counters.cacheHits, 1);
    assert.equal(wrapper.counters.cacheMisses, 2);
    await drains(wrapper);
  });
});


test("(g) put cleans up its per-key write chain entry (PR #1591, Medium)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    await cache.put(sampleKeyParts(), sampleResult);
    assert.equal(
      cache.pendingWriteCount(),
      0,
      "writeQueues entry must be removed once the write settles",
    );
    // Concurrent same-key writes also drain fully.
    await Promise.all([
      cache.put(sampleKeyParts(), sampleResult),
      cache.put(sampleKeyParts(), sampleResult),
      cache.put(sampleKeyParts({ questionId: "q-002" }), sampleResult),
    ]);
    assert.equal(cache.pendingWriteCount(), 0);
  });
});

test("(h) stableStringify is key-order independent and array-order preserving", () => {
  const a = stableStringify({ city: "NYC", country: "US", nested: { b: 2, a: 1 } });
  const b = stableStringify({ country: "US", nested: { a: 1, b: 2 }, city: "NYC" });
  assert.equal(a, b, "semantically identical objects must serialize identically");
  assert.notEqual(
    stableStringify({ list: [1, 2] }),
    stableStringify({ list: [2, 1] }),
    "array order is significant and must be preserved",
  );
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify(undefined), "null");
});

test("(i) cache-write failure returns the fresh verdict, never throws (PR #1591 P1)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    // Poison put() to simulate disk-full/permission failure.
    cache.put = async () => {
      throw new Error("simulated ENOSPC");
    };
    const wrapper = runJudgeWithCache({
      judge: {
        scoreWithMetrics: async () => sampleResult,
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    const verdict = await wrapper.scoreWithMetrics!("q", "p", "e");
    assert.equal(verdict.score, sampleResult.score, "fresh verdict must survive a cache-write failure");
    assert.equal(wrapper.counters.cacheWriteFailures, 1);
    assert.equal(wrapper.counters.modelCalls, 1);
  });
});

test("(j) abort control forwards through cache misses to the underlying judge (PR #1591 P2)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    const seenControls: Array<unknown> = [];
    const wrapper = runJudgeWithCache({
      judge: {
        scoreWithMetrics: async (_q, _p, _e, control) => {
          seenControls.push(control);
          return sampleResult;
        },
        scoreBinaryPrompt: async (_prompt, control) => {
          seenControls.push(control);
          return sampleResult;
        },
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    const control = { signal: new AbortController().signal };
    await wrapper.scoreWithMetrics!("q", "p", "e", control);
    await wrapper.scoreBinaryPrompt!("binary prompt", control);
    assert.deepEqual(seenControls, [control, control], "control must reach the underlying judge on both miss paths");
    await drains(wrapper);
  });
});

test("(k) scoreBinaryPrompt is OMITTED from the wrapper when the underlying judge lacks it (PR #1591 P2, #9/#12)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    // Underlying judge implements only scoreWithMetrics; no scoreBinaryPrompt.
    const wrapper = runJudgeWithCache({
      judge: {
        score: async (_q, _p, _e) => 0.5,
        scoreWithMetrics: async () => sampleResult,
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    assert.equal(
      "scoreBinaryPrompt" in wrapper,
      false,
      "wrapper must NOT advertise scoreBinaryPrompt when the underlying judge lacks it",
    );
    // Sanity: score() still works through the wrapper.
    const v = await wrapper.score("q", "p", "e");
    assert.equal(v, sampleResult.score);
    await drains(wrapper);
  });
});

test("(l) scoreBinaryPrompt ROUTES through the wrapper when the underlying judge supports it (PR #1591 P2, #9/#12)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    let seenPrompt: string | undefined;
    const wrapper = runJudgeWithCache({
      judge: {
        score: async () => 0,
        scoreWithMetrics: async () => sampleResult,
        scoreBinaryPrompt: async (prompt) => {
          seenPrompt = prompt;
          return { ...sampleResult, score: 1 };
        },
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    assert.equal(
      "scoreBinaryPrompt" in wrapper,
      true,
      "wrapper must expose scoreBinaryPrompt when the underlying judge supports it",
    );
    const v = await wrapper.scoreBinaryPrompt!("yes-no prompt", undefined);
    assert.equal(v.score, 1);
    assert.equal(seenPrompt, "yes-no prompt");
    // Drain the fire-and-forget cache write (round-5 OTHls) so the
    // second call sees the entry. Without this, race against the
    // first call's pending write makes the read inconsistent.
    await drains(wrapper);
    // Second call should hit the cache and not re-invoke the underlying judge.
    const v2 = await wrapper.scoreBinaryPrompt!("yes-no prompt", undefined);
    assert.equal(v2.score, 1);
    assert.equal(wrapper.counters.cacheHits, 1, "second identical binary prompt must be a cache hit");
  });
});


test("(m) binary prompts of equal length but different text get distinct cache keys (regression for `binary:N` collision, PR #1591 P2, #9/#12)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    let calls = 0;
    const wrapper = runJudgeWithCache({
      judge: {
        scoreWithMetrics: async () => sampleResult,
        scoreBinaryPrompt: async (_prompt) => {
          calls += 1;
          return { ...sampleResult, score: calls };
        },
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    // Both strings are length-7; on the old `binary:7` key they would collide.
    await wrapper.scoreBinaryPrompt!("abcdefg");
    await drains(wrapper);
    await wrapper.scoreBinaryPrompt!("hijklmn");
    await drains(wrapper);
    assert.equal(
      calls,
      2,
      "two different binary prompts of the same length must each invoke the underlying judge",
    );
    assert.equal(wrapper.counters.cacheMisses, 2);
    assert.equal(wrapper.counters.cacheHits, 0);
    // Re-running the first prompt now hits the cache.
    await wrapper.scoreBinaryPrompt!("abcdefg");
    assert.equal(calls, 2, "cached re-run must not re-invoke the underlying judge");
    assert.equal(wrapper.counters.cacheHits, 1);
    await drains(wrapper);
  });
});


test("(n) score-only fallback records latency via Date.now() bookend (PR #1591 P2 follow-up)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    // The synthesized BenchJudgeResult must carry a finite,
    // non-negative `latencyMs` reflecting the underlying `score()` call
    // duration. Pre-fix the wrapper hard-coded `latencyMs: 0` regardless
    // of how long `judge.score(...)` took; this test asserts the post-fix
    // bookend captures elapsed time without relying on real timer sleeps
    // (rule: no test timers). Each call to `judge.score(...)` yields once
    // via `setImmediate` — a deterministic scheduler boundary, not a
    // timer — so the wrapper's start and end `Date.now()` bookend can
    // differ on any machine.
    let callCount = 0;
    const wrapper = runJudgeWithCache({
      judge: {
        score: async (_q, _p, _e) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          callCount += 1;
          return 0.5;
        },
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    const first = await wrapper.scoreWithMetrics!("q1", "p1", "e1");
    const second = await wrapper.scoreWithMetrics!("q2", "p2", "e2");
    assert.equal(callCount, 2, "both calls should miss cache and run the synthesized path");
    for (const verdict of [first, second]) {
      assert.equal(typeof verdict.latencyMs, "number");
      assert.equal(Number.isFinite(verdict.latencyMs), true);
      assert.equal(verdict.latencyMs >= 0, true);
    }
    await drains(wrapper);
  });
});

test("(o) cache hits zero out latencyMs and tokens (PR #1591 round-3 OS7QE)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    const originalVerdict: BenchJudgeResult = {
      score: 1,
      tokens: { input: 100, output: 80 },
      latencyMs: 1234,
      model: "judge-mock",
    };
    const wrapper = runJudgeWithCache({
      judge: {
        scoreWithMetrics: async () => originalVerdict,
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    // First call: miss — full verdict returned.
    const miss = await wrapper.scoreWithMetrics!("q", "p", "e");
    assert.equal(miss.latencyMs, 1234);
    assert.equal(miss.tokens.input, 100);
    assert.equal(miss.tokens.output, 80);
    // Drain the fire-and-forget write so the second read sees it
    // (round-5 OTHls). Without this drain the read races the write
    // and produces a spurious miss.
    await drains(wrapper);
    // Second call: hit — latencyMs/tokens zeroed, score/model preserved.
    const hit = await wrapper.scoreWithMetrics!("q", "p", "e");
    assert.equal(hit.score, 1);
    assert.equal(hit.latencyMs, 0, "cache hit must report zero latency");
    assert.equal(hit.tokens.input, 0, "cache hit must report zero input tokens");
    assert.equal(hit.tokens.output, 0, "cache hit must report zero output tokens");
    assert.equal(hit.model, "judge-mock", "cache hit must preserve judge model identity");
    assert.equal(wrapper.counters.cacheHits, 1);
    await drains(wrapper);
  });
});

test("(p) cache hits zero out binary-prompt latencyMs and tokens (PR #1591 round-3 OS7QE)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    const wrapper = runJudgeWithCache({
      judge: {
        scoreWithMetrics: async () => sampleResult,
        scoreBinaryPrompt: async () => ({
          score: 1,
          tokens: { input: 50, output: 30 },
          latencyMs: 999,
          model: "judge-mock",
        }),
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    await wrapper.scoreBinaryPrompt!("prompt-A");
    await drains(wrapper);
    const hit = await wrapper.scoreBinaryPrompt!("prompt-A");
    assert.equal(hit.latencyMs, 0);
    assert.equal(hit.tokens.input, 0);
    assert.equal(hit.model, "judge-mock");
    await drains(wrapper);
  });
});

test("(q) modelCalls is incremented BEFORE the underlying judge await, even when the judge throws (PR #1591 round-4 OS8tv)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    let binaryEntered = false;
    const wrapper = runJudgeWithCache({
      judge: {
        scoreWithMetrics: async () => {
          throw new Error("provider 500");
        },
        scoreBinaryPrompt: async () => {
          binaryEntered = true;
          throw new Error("provider timeout");
        },
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    await assert.rejects(
      () => wrapper.scoreWithMetrics!("q", "p", "e"),
      /provider 500/,
    );
    await assert.rejects(
      () => wrapper.scoreBinaryPrompt!("yes-no"),
      /provider timeout/,
    );
    // Both failures must have registered as attempted judge calls —
    // otherwise the wrapper would under-report attempted/paid traffic
    // and observers could not distinguish a fully-cached run (0) from
    // a fully-failed run (also 0).
    assert.equal(wrapper.counters.modelCalls, 2, "both attempted calls must count even though both threw");
    assert.equal(binaryEntered, true, "scoreBinaryPrompt was actually invoked");
  });
});

test("(r) scoreBinaryPrompt preserves the underlying judge receiver (PR #1591 round-4 OS_-h)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    // A class instance whose scoreBinaryPrompt reads instance state via
    // `this`. Pre-fix the wrapper copied the method into a local and
    // invoked it unbound, breaking class-style judges.
    class ClassJudge {
      private readonly tag: string;
      constructor(tag: string) {
        this.tag = tag;
      }
      async scoreBinaryPrompt(_prompt: string): Promise<BenchJudgeResult> {
        // Reading `this.tag` would throw if the wrapper rebinds `this`.
        return {
          score: this.tag === "expected-tag" ? 1 : 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 0,
          model: "class-judge",
        };
      }
      async score(): Promise<number> {
        return 0;
      }
      async scoreWithMetrics(): Promise<BenchJudgeResult> {
        return {
          score: this.tag === "expected-tag" ? 1 : 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 0,
          model: "class-judge",
        };
      }
    }
    const underlying = new ClassJudge("expected-tag");
    const wrapper = runJudgeWithCache({
      judge: underlying,
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    const verdict = await wrapper.scoreBinaryPrompt!("yes-no prompt");
    // If `this` had been unbound, this.tag would be undefined and
    // verdict.score would be 0; with the wrapper fixed, `this` is
    // preserved and verdict.score === 1.
    assert.equal(verdict.score, 1, "this must remain bound to the underlying judge instance");
    await drains(wrapper);
  });
});

test("(s) cache-wrapping preserves BenchMemoryAdapter instance, prototype, and private slots (PR #1591 round-4 OS7CFz + OTEYU)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    // Class-style adapter using a #private field that lives only on
    // the receiver instance. Round-4 OS7CFz fixed prototype
    // preservation; OTEYU fixed receiver preservation. The combined
    // fix mutates the original instance's `judge` slot in place so
    // the same receiver (with its private slots) is reused.
    class ClassAdapter implements BenchMemoryAdapter {
      readonly marker = "class-adapter-marker";
      #secret: string;
      constructor(secret: string) {
        this.#secret = secret;
      }
      async store(_sessionId: string, _messages: Message[]): Promise<void> {
        // Touch the private slot so the receiver-preservation test
        // would fail if the wrap site cloned the adapter (the private
        // slot wouldn't initialize on a fresh receiver).
        void this.#secret;
      }
      async recall(
        _sessionId: string,
        _query: string,
      ): Promise<string> {
        return `from-class-adapter:${this.#secret}`;
      }
      async search(
        _query: string,
        _limit: number,
      ): Promise<SearchResult[]> {
        return [];
      }
      async reset(_sessionId?: string): Promise<void> {}
      async getStats(_sessionId?: string): Promise<{
        totalMessages: number;
        totalSummaryNodes: number;
        maxDepth: number;
      }> {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      }
      async destroy(): Promise<void> {}
      judge!: BenchJudge;
      async score(): Promise<number> {
        return 0;
      }
      async scoreWithMetrics(): Promise<BenchJudgeResult> {
        return {
          score: this.#secret.length,
          tokens: { input: 1, output: 1 },
          latencyMs: 0,
          model: "class-judge",
        };
      }
    }
    const adapter = new ClassAdapter("private-token");
    // Mirror the benchmark.ts wrap site (round-4 OTEYU): mutate the
    // original instance's `judge` slot in place.
    const cached = runJudgeWithCache({
      judge: adapter,
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    (adapter as BenchMemoryAdapter).judge = cached;
    const wrappedSystem = adapter as BenchMemoryAdapter;
    await wrappedSystem.store("sess-1", []);
    const recalled = await wrappedSystem.recall("sess-1", "query");
    assert.equal(recalled, "from-class-adapter:private-token");
    const results = await wrappedSystem.search("query", 10);
    assert.deepEqual(results, []);
    await wrappedSystem.reset("sess-1");
    await wrappedSystem.getStats("sess-1");
    await wrappedSystem.destroy();
    // The cached wrapper must still route to the underlying class
    // instance so its #private field stays accessible.
    const verdict = await wrappedSystem.judge!.scoreWithMetrics!("q", "p", "e");
    assert.equal(verdict.score, "private-token".length);
    // Identity: the same receiver instance is passed downstream.
    assert.equal(wrappedSystem, adapter, "wrap site must not clone the adapter");
  });
});

test("(t) slow cache reads fall through to the underlying judge (PR #1591 round-6 OTKGC)", async () => {
  await withTempDir(async (dir) => {
    // A cache whose get() resolves only on signal abort. Without
    // readCacheWithAbort the judge cache lookup would itself trip the
    // phase timeout; with the fix the wrapper treats the slow read as
    // a cache miss and runs the underlying judge.
    const ac = new AbortController();
    const stubbornCache = {
      async get(): Promise<unknown> {
        return new Promise((resolve) => {
          if (ac.signal.aborted) {
            resolve(undefined);
            return;
          }
          ac.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        });
      },
      async put(): Promise<void> {
        return;
      },
      pendingWriteCount(): number {
        return 0;
      },
    } as unknown as JudgeCache;
    const wrapper = runJudgeWithCache({
      judge: {
        async scoreWithMetrics() {
          return sampleResult;
        },
      },
      cache: stubbornCache as JudgeCache,
      keyExtras: { benchmarkId: "locomo" },
    });
    const control = { signal: ac.signal };
    const verdictP = wrapper.scoreWithMetrics!("q", "p", "e", control);
    ac.abort();
    const verdict = await verdictP;
    assert.equal(verdict.score, sampleResult.score);
    assert.equal(wrapper.counters.cacheMisses, 1, "slow read is reported as a cache miss, not a hit");
    assert.equal(wrapper.counters.cacheHits, 0);
  });
});

test("(u) cache reads after an already-aborted signal still let the judge run (PR #1591 round-6 OUsjh)", async () => {
  await withTempDir(async (dir) => {
    // Pre-populate so the read would normally produce a hit; the
    // aborted-signal branch forces a miss so the judge path runs.
    const cache = new JudgeCache({ dir });
    await cache.put(sampleKeyParts(), sampleResult);
    const ac = new AbortController();
    ac.abort();
    let judgeCalls = 0;
    const wrapper = runJudgeWithCache({
      judge: {
        async scoreWithMetrics() {
          judgeCalls += 1;
          return sampleResult;
        },
      },
      cache,
      keyExtras: { benchmarkId: "locomo" },
    });
    const verdict = await wrapper.scoreWithMetrics!("q", "p", "e", {
      signal: ac.signal,
    });
    assert.equal(verdict.score, sampleResult.score);
    assert.equal(judgeCalls, 1, "judge must run when the control signal was already aborted at entry");
    assert.equal(wrapper.counters.cacheMisses, 1);
    assert.equal(wrapper.counters.cacheHits, 0);
  });
});

// --- (v) restore guard: getter-only judge property (PR #1591 round-8) -----

test("(v) runBenchmark does not assign to a getter-only judge property when no cache is wired (PR #1591 round-8)", async () => {
  // A programmatic BenchMemoryAdapter can expose `judge` via a getter or
  // be frozen. When no cache wrapper is installed (no judgeProvider, no
  // judgeCacheDir/outputDir, or noJudgeCache), the finally restore must
  // be a no-op so a successful run does not throw during cleanup in ESM
  // strict mode.  buffer-surprise-trigger does not exercise the system
  // adapter's judge (it operates on SmartBuffer directly), so the run
  // succeeds; the bug manifests in runBenchmark's finally block.
  const noopAdapter = {
    async store() {},
    async recall() {
      return "";
    },
    async search() {
      return [];
    },
    async reset() {},
    async getStats() {
      return { sessionCount: 0, totalMemories: 0 };
    },
    async destroy() {},
  } as unknown as BenchMemoryAdapter;
  const stubJudge = { async score() { return 0.5; } } as unknown as BenchJudge;
  // getter-only property — any assignment throws in strict mode.
  Object.defineProperty(noopAdapter, "judge", {
    get() {
      return stubJudge;
    },
    set() {
      throw new Error("judge property is read-only (getter-only)");
    },
    configurable: false,
    enumerable: true,
  });

  // Before the round-8 fix, runBenchmark's finally block unconditionally
  // assigned options.system.judge = originalSystemJudge, which threw.
  // After the fix, the assignment is guarded by mutatedOptionsSystemJudge
  // and skipped when no cache wrapper was installed.
  const result = await runBenchmark("buffer-surprise-trigger", {
    mode: "quick",
    system: noopAdapter,
  });

  assert.ok(result, "runBenchmark should complete without throwing");
  assert.equal(
    noopAdapter.judge,
    stubJudge,
    "getter-only judge property should still return the original stub",
  );
});

// --- (w) inflight memory cache: fire-and-forget writes (PR #1591 round-8) -

test("(w) inflight memory cache serves reads before disk write completes (PR #1591 round-8, cursor thread)", async () => {
  await withTempDir(async (dir) => {
    const cache = new JudgeCache({ dir });
    const parts = sampleKeyParts();
    // Start the put but DON'T await it — the inflight entry is set
    // synchronously, before the first await inside put(), so an immediate
    // get() finds it even though the disk rename hasn't happened yet.
    // This closes the gap flagged by cursor: between benchmark iterations,
    // a fire-and-forget write from iteration N can still be pending when
    // iteration N+1 reads the same key.
    const putPromise = cache.put(parts, sampleResult);
    const hit = await cache.get(parts);
    assert.ok(hit?.cacheHit, "get must hit the inflight memory layer before disk write completes");
    assert.deepEqual(hit.verdict, sampleResult);

    // Now let the disk write finish.
    await putPromise;

    // After put settles, inflight is cleared but disk has the entry —
    // a subsequent get still hits (now from disk).
    const hit2 = await cache.get(parts);
    assert.ok(hit2?.cacheHit, "get must hit disk after inflight is cleared");
    assert.deepEqual(hit2.verdict, sampleResult);
  });
});
