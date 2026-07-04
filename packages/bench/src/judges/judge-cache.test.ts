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

import type { BenchJudgeResult } from "../adapters/types.ts";
import { JudgeCache, runJudgeWithCache, stableStringify } from "./judge-cache.ts";

async function withTempDir<T>(
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-judge-cache-"));
  try {
    return await body(dir);
  } finally {
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
    const b = await wrapper.scoreWithMetrics!(q, predicted, expected);
    const c = await wrapper.scoreWithMetrics!(q, predicted, expected);

    assert.equal(a.score, 1);
    assert.equal(b.score, 1);
    assert.equal(c.score, 1);
    assert.equal(underlyingCalls, 1, "second and third calls must serve from cache");
    assert.equal(wrapper.counters.modelCalls, 1);
    assert.equal(wrapper.counters.cacheHits, 2);
    assert.equal(wrapper.counters.cacheMisses, 1);
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
    await wrapper.scoreWithMetrics!("q", "alpha", "expected");
    await wrapper.scoreWithMetrics!("q", "beta", "expected");

    assert.equal(underlyingCalls, 2, "answer-text change must trigger one fresh model call");
    assert.equal(wrapper.counters.modelCalls, 2);
    assert.equal(wrapper.counters.cacheHits, 1);
    assert.equal(wrapper.counters.cacheMisses, 2);
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
    await wrapper.scoreBinaryPrompt!("hijklmn");
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
  });
});
