import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSurprise,
  DEFAULT_SURPRISE_K,
  type RecentMemoryLike,
} from "./buffer-surprise.js";

// -----------------------------------------------------------------------------
// Deterministic mock embedFn
// -----------------------------------------------------------------------------
//
// We use two complementary mock embedders so that tests are fully reproducible
// and do not depend on any real embedding model.
//
// 1. `hashEmbedder(dim)` — a character-hash "bag of codepoints" embedder.
//    Identical strings produce identical vectors (perfect cosine = 1).
//    Distinct strings produce vectors whose similarity reflects character
//    overlap. Deterministic, pure, and independent across calls.
//
// 2. `fixtureEmbedder(map)` — returns caller-supplied canned vectors for
//    specific texts. Used when a test needs exactly orthogonal vectors or
//    precisely-tuned near-duplicates.

function hashEmbedder(dim = 16) {
  return async (text: string): Promise<readonly number[]> => {
    const vec = new Array<number>(dim).fill(0);
    const normalized = text.toLowerCase();
    for (let i = 0; i < normalized.length; i += 1) {
      const code = normalized.charCodeAt(i);
      // Non-negative bucket, plus a small per-position weight so the embedder
      // is sensitive to character order (not just character frequency).
      const bucket = code % dim;
      vec[bucket] = (vec[bucket] ?? 0) + 1 + (i % 3) * 0.01;
    }
    return vec;
  };
}

function fixtureEmbedder(
  map: Record<string, readonly number[]>,
  fallback: readonly number[] | null = null,
) {
  return async (text: string): Promise<readonly number[]> => {
    if (Object.prototype.hasOwnProperty.call(map, text)) {
      // Defensive copy so callers can't see mutations across calls.
      return [...map[text]!];
    }
    if (fallback) return [...fallback];
    throw new Error(`fixtureEmbedder: no fixture for ${JSON.stringify(text)}`);
  };
}

function mem(id: string, content: string): RecentMemoryLike {
  return { id, content };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("computeSurprise returns 1.0 when recentMemories is empty", async () => {
  const score = await computeSurprise("anything", [], {
    embedFn: hashEmbedder(),
  });
  assert.equal(score, 1);
});

test("computeSurprise returns 1.0 when recentMemories is empty (no embedFn call)", async () => {
  // The empty-memories case should not need to embed the turn; the short
  // circuit lets callers skip the network round-trip.
  let calls = 0;
  const embedFn = async () => {
    calls += 1;
    return [1, 0];
  };
  const score = await computeSurprise("hello", [], { embedFn });
  assert.equal(score, 1);
  assert.equal(calls, 0, "embedFn should not be called for empty corpus");
});

test("computeSurprise returns ~0 for a single identical memory", async () => {
  const memories = [mem("a", "user likes espresso")];
  const score = await computeSurprise("user likes espresso", memories, {
    embedFn: hashEmbedder(),
  });
  // Identical text under the hash embedder → cosine 1 → surprise 0.
  assert.ok(
    Math.abs(score - 0) < 1e-9,
    `expected surprise ~0, got ${score}`,
  );
});

test("computeSurprise returns ~1 for orthogonal memories", async () => {
  // Construct vectors that are exactly orthogonal to the turn.
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    A: [0, 1, 0, 0],
    B: [0, 0, 1, 0],
    C: [0, 0, 0, 1],
  });
  const memories = [mem("a", "A"), mem("b", "B"), mem("c", "C")];
  const score = await computeSurprise("TURN", memories, { embedFn: embed });
  assert.equal(score, 1);
});

test("computeSurprise is monotonic: adding a more-similar memory decreases the score", async () => {
  // Fixture: turn points along the x-axis. The "far" memory is orthogonal
  // (cosine 0). The "near" memory is highly aligned with the turn (cosine
  // close to 1). Averaging with k=2 over [far, near] should produce a
  // strictly lower surprise than averaging over [far] alone.
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    FAR: [0, 1, 0, 0],
    NEAR: [0.99, 0.01, 0, 0],
  });

  const farOnly = [mem("far", "FAR")];
  const farAndNear = [mem("far", "FAR"), mem("near", "NEAR")];

  const scoreFarOnly = await computeSurprise("TURN", farOnly, {
    embedFn: embed,
    k: 2,
  });
  const scoreFarAndNear = await computeSurprise("TURN", farAndNear, {
    embedFn: embed,
    k: 2,
  });
  assert.ok(
    scoreFarAndNear < scoreFarOnly,
    `expected adding a near memory to decrease surprise; farOnly=${scoreFarOnly}, farAndNear=${scoreFarAndNear}`,
  );
});

test("computeSurprise clamps k to the number of memories when k > n", async () => {
  // With 3 memories and k=10, the score must equal the score computed with
  // k=3 (because the top-k average over 3 similarities is the average of
  // all of them in both cases).
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    A: [0.9, 0.1, 0, 0],
    B: [0.5, 0.5, 0, 0],
    C: [0.1, 0.9, 0, 0],
  });
  const memories = [mem("a", "A"), mem("b", "B"), mem("c", "C")];

  const kHuge = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: 10,
  });
  const kExact = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: 3,
  });
  assert.ok(
    Math.abs(kHuge - kExact) < 1e-12,
    `expected k=10 and k=3 to match when n=3; kHuge=${kHuge}, kExact=${kExact}`,
  );
});

test("computeSurprise clamps k to >= 1 when caller passes 0 or negative", async () => {
  // k=0 or k=-1 must not short-circuit to "no neighbors considered";
  // the docstring says k is clamped to [1, n].
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    A: [1, 0, 0, 0], // identical direction → cos 1 → surprise 0
  });
  const memories = [mem("a", "A")];

  const kZero = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: 0,
  });
  const kNeg = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: -5,
  });
  const kOne = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: 1,
  });
  assert.equal(kZero, kOne);
  assert.equal(kNeg, kOne);
  assert.equal(kOne, 0);
});

test("computeSurprise uses top-k nearest, not all memories, when k < n", async () => {
  // With k=1, the score should reflect ONLY the single most-similar memory.
  // A corpus of [very-similar, far, far, far] at k=1 must yield ~0 surprise
  // (because the nearest memory is very close), whereas k=4 over the same
  // corpus yields a much higher surprise (because the average dilutes the
  // single near hit with three far ones).
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    NEAR: [0.99, 0.01, 0, 0],
    FAR1: [0, 1, 0, 0],
    FAR2: [0, 0, 1, 0],
    FAR3: [0, 0, 0, 1],
  });
  const memories = [
    mem("near", "NEAR"),
    mem("far1", "FAR1"),
    mem("far2", "FAR2"),
    mem("far3", "FAR3"),
  ];

  const kOne = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: 1,
  });
  const kAll = await computeSurprise("TURN", memories, {
    embedFn: embed,
    k: 4,
  });
  assert.ok(kOne < 0.05, `k=1 should be ~0, got ${kOne}`);
  assert.ok(kAll > 0.5, `k=4 should dilute toward ~0.75, got ${kAll}`);
  assert.ok(kAll > kOne, "larger k should not decrease surprise here");
});

test("computeSurprise propagates embedFn rejections", async () => {
  const boom = new Error("embedding service unavailable");
  const embedFn = async () => {
    throw boom;
  };
  await assert.rejects(
    () =>
      computeSurprise("turn", [mem("a", "something")], {
        embedFn,
      }),
    /embedding service unavailable/,
  );
});

test("computeSurprise treats zero-norm embeddings as similarity 0", async () => {
  // A zero vector has no direction; cosine is undefined. We document that
  // these pairs contribute similarity 0 (maximally surprising), not NaN.
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    ZERO: [0, 0, 0, 0],
  });
  const score = await computeSurprise("TURN", [mem("z", "ZERO")], {
    embedFn: embed,
  });
  assert.equal(score, 1);
});

test("computeSurprise returns 0 when embedding-length mismatch (treated as sim 0)", async () => {
  // We intentionally do NOT silently truncate to the shorter vector —
  // mismatched dims almost always mean a config bug. They should surface
  // as "no similarity" (surprise = 1), not a quietly-wrong score.
  const embed = fixtureEmbedder({
    TURN: [1, 0, 0, 0],
    SHORT: [1, 0],
  });
  const score = await computeSurprise("TURN", [mem("s", "SHORT")], {
    embedFn: embed,
  });
  assert.equal(score, 1);
});

test("computeSurprise default k is 5 (docstring matches constant)", async () => {
  assert.equal(DEFAULT_SURPRISE_K, 5);

  // Behavioral check: when n=5 and we omit k, we should get the same answer
  // as passing k=5 explicitly.
  const embed = hashEmbedder(8);
  const memories = [
    mem("a", "alpha content"),
    mem("b", "beta content"),
    mem("c", "gamma content"),
    mem("d", "delta content"),
    mem("e", "epsilon content"),
  ];
  const noK = await computeSurprise("zeta content", memories, {
    embedFn: embed,
  });
  const k5 = await computeSurprise("zeta content", memories, {
    embedFn: embed,
    k: 5,
  });
  assert.equal(noK, k5);
});

test("computeSurprise is deterministic for the same inputs and embedFn", async () => {
  const embed = hashEmbedder();
  const memories = [
    mem("a", "deterministic test fixture one"),
    mem("b", "another canned memory fragment"),
    mem("c", "third entry with different content"),
  ];
  const a = await computeSurprise("query about something new", memories, {
    embedFn: embed,
  });
  const b = await computeSurprise("query about something new", memories, {
    embedFn: embed,
  });
  assert.equal(a, b);
});

test("computeSurprise result is always in [0, 1]", async () => {
  const embed = hashEmbedder();
  const corpora: RecentMemoryLike[][] = [
    [],
    [mem("a", "single memory")],
    [mem("a", "foo"), mem("b", "bar"), mem("c", "foo")],
  ];
  for (const memories of corpora) {
    for (const turn of ["foo", "bar", "novel question", ""]) {
      const score = await computeSurprise(turn, memories, { embedFn: embed });
      assert.ok(
        score >= 0 && score <= 1,
        `score out of range for turn=${JSON.stringify(turn)} len=${memories.length}: ${score}`,
      );
    }
  }
});

test("computeSurprise throws TypeError when embedFn is missing", async () => {
  await assert.rejects(
    () =>
      // biome-ignore lint: intentionally passing a malformed options object
      computeSurprise("turn", [mem("a", "x")], {} as any),
    /embedFn/,
  );
});

test("computeSurprise throws TypeError when turn is not a string", async () => {
  await assert.rejects(
    () =>
      computeSurprise(
        // biome-ignore lint: intentionally passing wrong type
        42 as any,
        [mem("a", "x")],
        { embedFn: hashEmbedder() },
      ),
    /must be a string/,
  );
});
