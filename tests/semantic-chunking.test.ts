import test from "node:test";
import assert from "node:assert/strict";
import {
  cosineSimilarity,
  mean,
  stddev,
  movingAverage,
  findLocalMinima,
  semanticChunkContent,
  DEFAULT_SEMANTIC_CHUNKING_CONFIG,
  type EmbedFn,
  type SemanticChunkingConfig,
} from "../packages/remnic-core/src/semantic-chunking.js";

// ---------------------------------------------------------------------------
// Helpers — deterministic mock embedding functions
// ---------------------------------------------------------------------------

/**
 * Returns a mock embedFn that maps sentences to one of two clusters.
 * Sentences containing any keyword from `topicBKeywords` get vectorB;
 * all others get vectorA. This creates a clear topic boundary.
 */
function twoTopicEmbedFn(
  topicBKeywords: string[],
  vectorA: number[] = [1, 0, 0],
  vectorB: number[] = [0, 1, 0],
): EmbedFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      const lower = t.toLowerCase();
      return topicBKeywords.some((kw) => lower.includes(kw))
        ? [...vectorB]
        : [...vectorA];
    });
}

/** An embedFn that always throws, simulating an unavailable embedding service. */
const failingEmbedFn: EmbedFn = async () => {
  throw new Error("embedding service unavailable");
};

/** An embedFn that returns all-identical vectors (no topic change). */
const uniformEmbedFn: EmbedFn = async (texts: string[]) =>
  texts.map(() => [1, 0, 0]);

// ---------------------------------------------------------------------------
// Math utility tests
// ---------------------------------------------------------------------------

test("cosineSimilarity: identical vectors return 1.0", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([3, 4], [3, 4]), 1);
});

test("cosineSimilarity: orthogonal vectors return 0.0", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors return -1.0", () => {
  const sim = cosineSimilarity([1, 0, 0], [-1, 0, 0]);
  assert.ok(Math.abs(sim - -1) < 1e-10);
});

test("cosineSimilarity: zero vector returns 0", () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test("cosineSimilarity: empty vectors return 0", () => {
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity: mismatched lengths throw", () => {
  assert.throws(
    () => cosineSimilarity([1, 2], [1, 2, 3]),
    /vector length mismatch/,
  );
});

test("mean: known series", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([10]), 10);
  assert.equal(mean([]), 0);
});

test("stddev: known series", () => {
  // [2, 4, 6]: mean = 4, variance = ((4+0+4)/3) = 8/3, stddev = sqrt(8/3)
  const sd = stddev([2, 4, 6]);
  assert.ok(Math.abs(sd - Math.sqrt(8 / 3)) < 1e-10);
});

test("stddev: uniform series returns 0", () => {
  assert.equal(stddev([5, 5, 5]), 0);
});

test("stddev: empty series returns 0", () => {
  assert.equal(stddev([]), 0);
});

test("movingAverage: known series with window 3", () => {
  // Series: [1, 3, 5, 3, 1]
  // Window 3 (halfW=1):
  //   i=0: avg(1,3) = 2          (clamped left)
  //   i=1: avg(1,3,5) = 3
  //   i=2: avg(3,5,3) = 3.667
  //   i=3: avg(5,3,1) = 3
  //   i=4: avg(3,1) = 2          (clamped right)
  const result = movingAverage([1, 3, 5, 3, 1], 3);
  assert.equal(result.length, 5);
  assert.ok(Math.abs(result[0] - 2) < 1e-10);
  assert.ok(Math.abs(result[1] - 3) < 1e-10);
  assert.ok(Math.abs(result[2] - 11 / 3) < 1e-10);
  assert.ok(Math.abs(result[3] - 3) < 1e-10);
  assert.ok(Math.abs(result[4] - 2) < 1e-10);
});

test("movingAverage: window 1 returns original series", () => {
  const series = [10, 20, 30];
  const result = movingAverage(series, 1);
  assert.deepEqual(result, [10, 20, 30]);
});

test("movingAverage: empty series returns empty", () => {
  assert.deepEqual(movingAverage([], 3), []);
});

test("findLocalMinima: detects dips below threshold", () => {
  // Series with a clear dip at index 2
  const series = [0.9, 0.8, 0.2, 0.85, 0.9];
  const m = mean(series);
  const s = stddev(series);
  const threshold = m - 0.5 * s;
  const minima = findLocalMinima(series, threshold);
  assert.deepEqual(minima, [2]);
});

test("findLocalMinima: no minima when series is flat", () => {
  assert.deepEqual(findLocalMinima([0.5, 0.5, 0.5, 0.5], 0.4), []);
});

test("findLocalMinima: empty or short series returns empty", () => {
  assert.deepEqual(findLocalMinima([], 0.5), []);
  assert.deepEqual(findLocalMinima([0.5], 0.5), []);
  assert.deepEqual(findLocalMinima([0.5, 0.3], 0.5), []);
});

test("findLocalMinima: multiple dips", () => {
  const series = [0.9, 0.1, 0.9, 0.1, 0.9];
  // Both index 1 and 3 are local minima and well below any reasonable threshold
  const minima = findLocalMinima(series, 0.5);
  assert.deepEqual(minima, [1, 3]);
});

// ---------------------------------------------------------------------------
// Semantic chunking integration tests
// ---------------------------------------------------------------------------

test("semanticChunkContent: empty input returns empty result", async () => {
  const result = await semanticChunkContent("", uniformEmbedFn);
  assert.equal(result.chunked, false);
  assert.equal(result.chunks.length, 0);
  assert.equal(result.method, "semantic");
});

test("semanticChunkContent: whitespace-only input returns empty result", async () => {
  const result = await semanticChunkContent("   \n\t  ", uniformEmbedFn);
  assert.equal(result.chunked, false);
  assert.equal(result.chunks.length, 0);
});

test("semanticChunkContent: single sentence returns single unchunked result", async () => {
  const result = await semanticChunkContent("Hello world.", uniformEmbedFn);
  assert.equal(result.chunked, false);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.boundaries.length, 0);
  assert.equal(result.method, "semantic");
});

test("semanticChunkContent: two sentences returns single unchunked result when short", async () => {
  const result = await semanticChunkContent(
    "Hello world. How are you?",
    uniformEmbedFn,
  );
  assert.equal(result.chunked, false);
  assert.equal(result.chunks.length, 1);
});

test("semanticChunkContent: no topic changes produces single chunk", async () => {
  // Generate enough text so it would be chunked if boundaries existed,
  // but all sentences are about the same topic.
  const sentences = Array.from(
    { length: 20 },
    (_, i) => `The cat sat on mat number ${i}.`,
  );
  const text = sentences.join(" ");

  const result = await semanticChunkContent(text, uniformEmbedFn, {
    targetTokens: 50,
    minTokens: 30,
    maxTokens: 200,
  });

  // With uniform embeddings, cosine similarity between adjacent pairs is 1.0.
  // No local minima should be detected, so no boundaries, hence one chunk.
  assert.equal(result.chunked, false);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.method, "semantic");
});

test("semanticChunkContent: clear topic change produces multiple chunks", async () => {
  // First half about cooking, second half about programming
  const cookingSentences = Array.from(
    { length: 8 },
    (_, i) => `The chef prepared dish number ${i} with fresh ingredients.`,
  );
  const programmingSentences = Array.from(
    { length: 8 },
    (_, i) => `The developer wrote function number ${i} in TypeScript.`,
  );
  const text = [...cookingSentences, ...programmingSentences].join(" ");

  const embedFn = twoTopicEmbedFn(
    ["developer", "function", "typescript"],
    [1, 0, 0],
    [0, 1, 0],
  );

  // Use smoothingWindowSize: 1 because mock embeddings produce a sharp binary
  // transition (cos=0 at exactly one point). With window > 1 the smoothing
  // spreads the dip into a flat plateau that findLocalMinima's strict less-than
  // check does not recognize as a single minimum. Real embeddings produce
  // gradual shifts that smooth gracefully.
  const result = await semanticChunkContent(text, embedFn, {
    targetTokens: 50,
    minTokens: 30,
    maxTokens: 600,
    smoothingWindowSize: 1,
  });

  assert.equal(result.chunked, true);
  assert.ok(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
  assert.ok(result.boundaries.length >= 1, "Expected at least 1 boundary");
  assert.equal(result.method, "semantic");

  // Verify each chunk has required fields
  for (const chunk of result.chunks) {
    assert.ok(typeof chunk.content === "string");
    assert.ok(typeof chunk.index === "number");
    assert.ok(typeof chunk.tokenCount === "number");
    assert.ok(typeof chunk.boundaryScore === "number");
  }
});

test("semanticChunkContent: fallback to recursive when embedFn throws", async () => {
  const longText = Array.from(
    { length: 20 },
    (_, i) => `Sentence number ${i} is here.`,
  ).join(" ");

  const result = await semanticChunkContent(longText, failingEmbedFn, {
    fallbackToRecursive: true,
    targetTokens: 40,
    minTokens: 20,
  });

  assert.equal(result.method, "recursive-fallback");
  assert.ok(result.chunks.length >= 1);
  // Each chunk from fallback should have boundaryScore = 0
  for (const chunk of result.chunks) {
    assert.equal(chunk.boundaryScore, 0);
  }
});

test("semanticChunkContent: throws when embedFn fails and fallback disabled", async () => {
  const text = "Sentence one. Sentence two. Sentence three. Sentence four.";

  await assert.rejects(
    () =>
      semanticChunkContent(text, failingEmbedFn, {
        fallbackToRecursive: false,
        minTokens: 5,
      }),
    /embedding function threw and fallbackToRecursive is disabled/,
  );
});

test("semanticChunkContent: merge short segments below minTokens", async () => {
  // Create text with many short topic segments that should be merged
  // Topic A (2 sentences) -> Topic B (2 sentences) -> Topic A again
  const text = [
    "Alpha one is here.",
    "Alpha two is here.",
    "Beta three code is here.",
    "Beta four code is here.",
    "Alpha five is here.",
    "Alpha six is here.",
    "Beta seven code is here.",
    "Beta eight code is here.",
    "Alpha nine is here.",
    "Alpha ten is here.",
  ].join(" ");

  const embedFn = twoTopicEmbedFn(["beta", "code"], [1, 0, 0], [0, 1, 0]);

  const result = await semanticChunkContent(text, embedFn, {
    targetTokens: 50,
    minTokens: 40, // High enough to force merging of 2-sentence segments
    maxTokens: 300,
    smoothingWindowSize: 1,
  });

  // All chunks should have at least minTokens worth of content
  // (or be the last/only chunk)
  for (let i = 0; i < result.chunks.length; i++) {
    const chunk = result.chunks[i];
    assert.ok(typeof chunk.tokenCount === "number");
    assert.ok(chunk.tokenCount > 0);
  }
});

test("semanticChunkContent: split long segments above maxTokens", async () => {
  // Create a long single-topic block that exceeds maxTokens
  const longSentences = Array.from(
    { length: 30 },
    (_, i) =>
      `This is a very long sentence number ${i} that contributes substantially to the total token count of this paragraph.`,
  );
  const text = longSentences.join(" ");

  const result = await semanticChunkContent(text, uniformEmbedFn, {
    targetTokens: 50,
    minTokens: 30,
    maxTokens: 100, // Very low max to force recursive splitting
  });

  // The single topic block should still be split since it exceeds maxTokens
  assert.ok(
    result.chunks.length >= 2,
    `Expected multiple chunks from long segment, got ${result.chunks.length}`,
  );
});

test("semanticChunkContent: batching respects embeddingBatchSize", async () => {
  let callCount = 0;
  const countingEmbedFn: EmbedFn = async (texts: string[]) => {
    callCount++;
    return texts.map(() => [1, 0, 0]);
  };

  const sentences = Array.from(
    { length: 10 },
    (_, i) => `Sentence ${i}.`,
  );
  const text = sentences.join(" ");

  await semanticChunkContent(text, countingEmbedFn, {
    embeddingBatchSize: 3,
    minTokens: 5,
  });

  // 10 sentences with batch size 3 should produce ceil(10/3) = 4 calls
  assert.equal(callCount, 4);
});

test("semanticChunkContent: config defaults applied correctly", () => {
  const cfg = DEFAULT_SEMANTIC_CHUNKING_CONFIG;
  assert.equal(cfg.targetTokens, 200);
  assert.equal(cfg.minTokens, 100);
  assert.equal(cfg.maxTokens, 400);
  assert.equal(cfg.smoothingWindowSize, 3);
  assert.equal(cfg.boundaryThresholdStdDevs, 1.0);
  assert.equal(cfg.embeddingBatchSize, 32);
  assert.equal(cfg.fallbackToRecursive, true);
});

test("semanticChunkContent: boundary indices are in ascending order", async () => {
  const cookingSentences = Array.from(
    { length: 6 },
    (_, i) => `The chef prepared meal ${i} today.`,
  );
  const codeSentences = Array.from(
    { length: 6 },
    (_, i) => `The developer deployed release ${i} to production.`,
  );
  const cookingSentences2 = Array.from(
    { length: 6 },
    (_, i) => `The chef baked cake ${i} for dessert.`,
  );

  const text = [
    ...cookingSentences,
    ...codeSentences,
    ...cookingSentences2,
  ].join(" ");

  const embedFn = twoTopicEmbedFn(
    ["developer", "deployed", "production"],
    [1, 0, 0],
    [0, 1, 0],
  );

  const result = await semanticChunkContent(text, embedFn, {
    targetTokens: 50,
    minTokens: 30,
    maxTokens: 600,
    smoothingWindowSize: 1,
  });

  // Verify boundaries are sorted ascending
  for (let i = 1; i < result.boundaries.length; i++) {
    assert.ok(
      result.boundaries[i] > result.boundaries[i - 1],
      `Boundary ${i} (${result.boundaries[i]}) should be > boundary ${i - 1} (${result.boundaries[i - 1]})`,
    );
  }
});

test("semanticChunkContent: chunk indices are sequential", async () => {
  const text = Array.from(
    { length: 20 },
    (_, i) =>
      i < 10
        ? `The scientist studied molecule ${i}.`
        : `The musician played song ${i}.`,
  ).join(" ");

  const embedFn = twoTopicEmbedFn(
    ["musician", "played", "song"],
    [1, 0, 0],
    [0, 1, 0],
  );

  const result = await semanticChunkContent(text, embedFn, {
    targetTokens: 40,
    minTokens: 20,
    maxTokens: 300,
    smoothingWindowSize: 1,
  });

  for (let i = 0; i < result.chunks.length; i++) {
    assert.equal(result.chunks[i].index, i);
  }
});

test("semanticChunkContent: partial config merges with defaults", async () => {
  const text = "One sentence. Two sentence.";
  const result = await semanticChunkContent(text, uniformEmbedFn, {
    targetTokens: 500,
    // Other fields should come from defaults
  });
  assert.ok(result);
  assert.equal(result.method, "semantic");
});

test("semanticChunkContent: embeddingBatchSize 0 does not cause infinite loop", async () => {
  let callCount = 0;
  const countingEmbedFn: EmbedFn = async (texts: string[]) => {
    callCount++;
    return texts.map(() => [1, 0, 0]);
  };

  const sentences = Array.from({ length: 5 }, (_, i) => `Sentence ${i}.`);
  const text = sentences.join(" ");

  // batchSize 0 should be clamped to 1, resulting in 5 calls (one per sentence)
  const result = await semanticChunkContent(text, countingEmbedFn, {
    embeddingBatchSize: 0,
    minTokens: 5,
  });

  assert.ok(result);
  assert.equal(callCount, 5);
});

test("semanticChunkContent: two sentences exceeding maxTokens triggers recursive split", async () => {
  // Two long sentences whose combined token count exceeds maxTokens
  const longA = "A".repeat(200) + ".";
  const longB = "B".repeat(200) + ".";
  const text = `${longA} ${longB}`;

  const result = await semanticChunkContent(text, uniformEmbedFn, {
    maxTokens: 50, // Very low to force splitting
    targetTokens: 25,
    minTokens: 10,
  });

  // Should fall back to recursive splitting since the 2-sentence chunk exceeds maxTokens
  assert.equal(result.method, "recursive-fallback");
  assert.ok(result.chunks.length >= 2, `Expected multiple chunks, got ${result.chunks.length}`);
});

// ---------------------------------------------------------------------------
// Finding 2 (PR #420): splitLongSegment caps targetTokens to maxTokens
// ---------------------------------------------------------------------------

test("semanticChunkContent: recursive split respects maxTokens when targetTokens is larger", async () => {
  // Create a long single-topic text that will be split recursively.
  // targetTokens=500 with maxTokens=100 should produce chunks much
  // smaller than 500 tokens because splitLongSegment now caps
  // targetTokens to maxTokens.
  const longSentences = Array.from(
    { length: 40 },
    (_, i) =>
      `This is sentence number ${i} and it contributes to the total count.`,
  );
  const text = longSentences.join(" ");

  const result = await semanticChunkContent(text, uniformEmbedFn, {
    targetTokens: 500,
    minTokens: 10,
    maxTokens: 100,
  });

  // Without the maxTokens cap, splitLongSegment would forward
  // targetTokens=500 to the recursive chunker, producing 1-2 huge chunks.
  // With the cap, it uses targetTokens=100 instead, producing many smaller
  // chunks.  Verify that we got multiple chunks and none approaches 500.
  assert.ok(
    result.chunks.length >= 3,
    `Expected >= 3 chunks when maxTokens caps targetTokens, got ${result.chunks.length}`,
  );
  for (const chunk of result.chunks) {
    assert.ok(
      chunk.tokenCount < 400,
      `Chunk token count ${chunk.tokenCount} is near uncapped targetTokens (500). ` +
        `splitLongSegment should have capped targetTokens to maxTokens=100.`,
    );
  }
});

// ---------------------------------------------------------------------------
// PR #439 post-merge: buildRecursiveFallback must also cap targetTokens
// ---------------------------------------------------------------------------

test("semanticChunkContent: recursive fallback path caps targetTokens to maxTokens", async () => {
  // When embedFn fails and fallbackToRecursive=true, buildRecursiveFallback
  // is used. It must cap targetTokens to maxTokens the same way
  // splitLongSegment does (cursor[bot] finding on PR #439).
  const longText = Array.from(
    { length: 40 },
    (_, i) =>
      `This is sentence number ${i} and it contributes to the total count.`,
  ).join(" ");

  const result = await semanticChunkContent(longText, failingEmbedFn, {
    fallbackToRecursive: true,
    targetTokens: 500,
    minTokens: 10,
    maxTokens: 100,
  });

  assert.equal(result.method, "recursive-fallback");
  assert.ok(
    result.chunks.length >= 3,
    `Expected >= 3 chunks when maxTokens caps targetTokens in fallback, got ${result.chunks.length}`,
  );
  for (const chunk of result.chunks) {
    assert.ok(
      chunk.tokenCount < 400,
      `Fallback chunk token count ${chunk.tokenCount} is near uncapped targetTokens (500). ` +
        `buildRecursiveFallback should cap targetTokens to maxTokens=100.`,
    );
  }
});

test("semanticChunkContent: mismatched embedding dimensions fall back when enabled", async () => {
  const text = [
    "Alpha planning details span enough words to require semantic processing.",
    "Alpha implementation notes continue the same topic for comparison.",
    "Beta release details switch topics after the malformed embedding.",
  ].join(" ");
  const mismatchedEmbedFn: EmbedFn = async () => [[1, 0], [1], [0, 1]];

  const result = await semanticChunkContent(text, mismatchedEmbedFn, {
    fallbackToRecursive: true,
    minTokens: 1,
    targetTokens: 20,
    maxTokens: 40,
  });

  assert.equal(result.method, "recursive-fallback");
});

test("semanticChunkContent: mismatched embedding dimensions reject when fallback is disabled", async () => {
  const text = [
    "Alpha planning details span enough words to require semantic processing.",
    "Alpha implementation notes continue the same topic for comparison.",
    "Beta release details switch topics after the malformed embedding.",
  ].join(" ");
  const mismatchedEmbedFn: EmbedFn = async () => [[1, 0], [1], [0, 1]];

  await assert.rejects(
    () =>
      semanticChunkContent(text, mismatchedEmbedFn, {
        fallbackToRecursive: false,
        minTokens: 1,
        targetTokens: 20,
        maxTokens: 40,
      }),
    /embedding vectors have mismatched dimensions \(2 vs 1 at index 1\)/,
  );
});

// ---------------------------------------------------------------------------
// Finding 4 (PR #420): even window sizes are rounded up to odd
// ---------------------------------------------------------------------------

test("movingAverage: even windowSize is rounded up to next odd", () => {
  // With windowSize=4, it should be treated as windowSize=5 (halfW=2).
  // With windowSize=5, halfW=2, so the two should produce identical results.
  const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const resultEven = movingAverage(series, 4);
  const resultOdd = movingAverage(series, 5);
  assert.deepEqual(
    resultEven,
    resultOdd,
    "Even windowSize=4 should produce the same result as odd windowSize=5",
  );
});

test("movingAverage: windowSize=2 behaves as windowSize=3", () => {
  const series = [10, 20, 30, 40, 50];
  const resultTwo = movingAverage(series, 2);
  const resultThree = movingAverage(series, 3);
  assert.deepEqual(
    resultTwo,
    resultThree,
    "Even windowSize=2 should be rounded to 3",
  );
});
