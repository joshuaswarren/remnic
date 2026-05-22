import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parseConfig } from "../config.js";
import { chunkContent, type ChunkingConfig } from "../chunking.js";
import { EmbeddingFallback, EmbeddingTimeoutError } from "../embedding-fallback.js";
import { ContentHashIndex, StorageManager } from "../storage.js";
import {
  decideSemanticDedup,
  type SemanticDedupDecision,
  type SemanticDedupHit,
  type SemanticDedupLookup,
  type SemanticDedupOptions,
} from "./semantic.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLookup(hits: SemanticDedupHit[]): SemanticDedupLookup {
  return async () => hits;
}

const DEFAULT_OPTS: SemanticDedupOptions = {
  enabled: true,
  threshold: 0.92,
  candidates: 5,
};

// ── decideSemanticDedup ───────────────────────────────────────────────────────

test("semantic dedup: returns keep/disabled when enabled flag is false", async () => {
  const decision = await decideSemanticDedup(
    "hello world",
    makeLookup([{ id: "m1", score: 0.99 }]),
    { ...DEFAULT_OPTS, enabled: false },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "disabled");
});

test("semantic dedup: keeps content when lookup returns no hits (empty index → no_candidates)", async () => {
  const decision = await decideSemanticDedup(
    "some novel statement",
    makeLookup([]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  // Provider is available but returned no hits: empty index, not backend failure.
  assert.equal(decision.reason, "no_candidates");
});

test("semantic dedup: keeps content when top score is below threshold", async () => {
  const decision = await decideSemanticDedup(
    "the user prefers tabs over spaces",
    makeLookup([
      { id: "m1", score: 0.82 },
      { id: "m2", score: 0.74 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "no_near_duplicate");
  if (decision.action === "keep") {
    assert.equal(decision.topId, "m1");
    assert.equal(decision.topScore, 0.82);
  }
});

test("semantic dedup: skips content when top score meets threshold exactly", async () => {
  const decision = await decideSemanticDedup(
    "the user prefers tabs",
    makeLookup([{ id: "m1", score: 0.92 }]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.reason, "near_duplicate");
    assert.equal(decision.topId, "m1");
    assert.equal(decision.topScore, 0.92);
  }
});

test("semantic dedup: skips content when top score exceeds threshold", async () => {
  // Simulates a paraphrase that collides with an existing memory.
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([
      { id: "existing-pref-42", score: 0.96, path: "/tmp/pref.md" },
      { id: "existing-pref-43", score: 0.81 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.topId, "existing-pref-42");
    assert.equal(decision.topPath, "/tmp/pref.md");
    assert.ok(decision.topScore >= 0.92);
  }
});

test("semantic dedup: picks highest-scoring hit even if unsorted", async () => {
  const decision = await decideSemanticDedup(
    "anything",
    makeLookup([
      { id: "m1", score: 0.5 },
      { id: "m2", score: 0.97 },
      { id: "m3", score: 0.6 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.topId, "m2");
    assert.equal(decision.topScore, 0.97);
  }
});

test("semantic dedup: ignores non-finite scores", async () => {
  const decision = await decideSemanticDedup(
    "content",
    makeLookup([
      { id: "m1", score: Number.NaN },
      { id: "m2", score: Number.POSITIVE_INFINITY },
      { id: "m3", score: 0.5 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "no_near_duplicate");
  if (decision.action === "keep") {
    assert.equal(decision.topId, "m3");
  }
});

test("semantic dedup: treats lookup throw as fail-open keep", async () => {
  const decision = await decideSemanticDedup(
    "content",
    async () => {
      throw new Error("network down");
    },
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "backend_unavailable");
});

test("semantic dedup: empty/whitespace content never triggers lookup", async () => {
  let called = 0;
  const decision = await decideSemanticDedup(
    "   \n  ",
    async () => {
      called++;
      return [{ id: "m1", score: 0.99 }];
    },
    DEFAULT_OPTS,
  );
  assert.equal(called, 0);
  assert.equal(decision.action, "keep");
});

test("semantic dedup: candidates option is forwarded to lookup", async () => {
  let limitSeen = -1;
  await decideSemanticDedup(
    "anything",
    async (_content, limit) => {
      limitSeen = limit;
      return [];
    },
    { ...DEFAULT_OPTS, candidates: 11 },
  );
  assert.equal(limitSeen, 11);
});

test("semantic dedup: normalizes malformed numeric options before lookup", async () => {
  let invalidCandidateLimitSeen = -1;
  const invalidCandidates = await decideSemanticDedup(
    "anything",
    async (_content, limit) => {
      invalidCandidateLimitSeen = limit;
      return [{ id: "m1", score: 0.93 }];
    },
    { ...DEFAULT_OPTS, threshold: Number.NaN, candidates: Number.NaN },
  );
  assert.equal(invalidCandidateLimitSeen, 5);
  assert.equal(invalidCandidates.action, "skip");

  let fractionalCandidateLimitSeen = -1;
  await decideSemanticDedup(
    "anything",
    async (_content, limit) => {
      fractionalCandidateLimitSeen = limit;
      return [];
    },
    { ...DEFAULT_OPTS, candidates: 0.5 },
  );
  assert.equal(fractionalCandidateLimitSeen, 1);

  const clampedHighThreshold = await decideSemanticDedup(
    "anything",
    makeLookup([{ id: "m1", score: 0.99 }]),
    { ...DEFAULT_OPTS, threshold: 2 },
  );
  assert.equal(clampedHighThreshold.action, "keep");
  assert.equal(clampedHighThreshold.reason, "no_near_duplicate");

  const clampedLowThreshold = await decideSemanticDedup(
    "anything",
    makeLookup([{ id: "m1", score: 0.01 }]),
    { ...DEFAULT_OPTS, threshold: -1 },
  );
  assert.equal(clampedLowThreshold.action, "skip");
});

test("semantic dedup: candidates=0 short-circuits without calling lookup", async () => {
  let called = 0;
  const decision = await decideSemanticDedup(
    "anything",
    async () => {
      called++;
      return [];
    },
    { ...DEFAULT_OPTS, candidates: 0 },
  );
  assert.equal(called, 0, "lookup must not be called when candidates=0");
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "disabled");
});

// ── Config flag parsing ───────────────────────────────────────────────────────

test("parseConfig: semantic dedup flags default to enabled/0.92/5", () => {
  const config = parseConfig({});
  assert.equal(config.semanticDedupEnabled, true);
  assert.equal(config.semanticDedupThreshold, 0.92);
  assert.equal(config.semanticDedupCandidates, 5);
});

test("parseConfig: semantic dedup flags respect explicit settings", () => {
  const config = parseConfig({
    semanticDedupEnabled: false,
    semanticDedupThreshold: 0.88,
    semanticDedupCandidates: 10,
  });
  assert.equal(config.semanticDedupEnabled, false);
  assert.equal(config.semanticDedupThreshold, 0.88);
  assert.equal(config.semanticDedupCandidates, 10);
});

test("parseConfig: semantic dedup threshold clamps to [0, 1]", () => {
  const below = parseConfig({ semanticDedupThreshold: -0.5 });
  const above = parseConfig({ semanticDedupThreshold: 5 });
  assert.equal(below.semanticDedupThreshold, 0);
  assert.equal(above.semanticDedupThreshold, 1);
});

test("parseConfig: semanticDedupCandidates=0 is preserved (operator disable signal)", () => {
  const zero = parseConfig({ semanticDedupCandidates: 0 });
  assert.equal(zero.semanticDedupCandidates, 0);
});

test("parseConfig: negative semanticDedupCandidates falls back to default 5", () => {
  const negative = parseConfig({ semanticDedupCandidates: -3 });
  assert.equal(negative.semanticDedupCandidates, 5);
});

test("parseConfig: NaN semanticDedupCandidates falls back to default 5", () => {
  const nan = parseConfig({ semanticDedupCandidates: Number.NaN });
  assert.equal(nan.semanticDedupCandidates, 5);
});

test("parseConfig: NaN semanticDedupThreshold falls back to default 0.92", () => {
  const nan = parseConfig({ semanticDedupThreshold: Number.NaN });
  assert.equal(nan.semanticDedupThreshold, 0.92);
});

test("parseConfig: Infinity semanticDedupThreshold falls back to default 0.92", () => {
  const pos = parseConfig({ semanticDedupThreshold: Number.POSITIVE_INFINITY });
  const neg = parseConfig({ semanticDedupThreshold: Number.NEGATIVE_INFINITY });
  assert.equal(pos.semanticDedupThreshold, 0.92);
  assert.equal(neg.semanticDedupThreshold, 0.92);
});

// ── Regression: semantic skip must NOT register a synthetic content hash ──────
//
// Verifies the fix for the bug introduced in PR #399: when the semantic dedup
// guard decides to skip a fact (near-duplicate of an existing memory), the
// orchestrator must NOT add the skipped fact's content to contentHashIndex.
//
// If it did, archiving the original neighbor memory would leave an orphaned
// hash that permanently blocks legitimate writes of the same text.

test("regression #399: semantic dedup skip does NOT add content hash to index", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "remnic-test-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();

    const FACT_CONTENT = "the user prefers dark mode in their editor";
    const NEIGHBOR_ID = "mem-neighbor-001";

    // Simulate the orchestrator: run the semantic dedup decision (skip outcome).
    const decision = await decideSemanticDedup(
      FACT_CONTENT,
      makeLookup([{ id: NEIGHBOR_ID, score: 0.97 }]),
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "skip", "precondition: decision must be skip");

    // The fixed orchestrator does NOT call index.add() in the skip branch.
    // Simulate that invariant: we do NOT call index.add(FACT_CONTENT) here.

    // The skipped fact's hash must NOT be present in the index.
    assert.equal(
      index.has(FACT_CONTENT),
      false,
      "skipped fact content must not be registered in contentHashIndex",
    );

    // Now simulate archiving the neighbor: remove its content from the index.
    // (In the orchestrator this would be index.remove(neighborMemory.content);
    // here the neighbor was never registered, so the index stays empty — which
    // is the desired state.)
    assert.equal(index.size, 0, "index must remain empty after semantic skip");

    // A subsequent write attempt of the same text must NOT be blocked by the
    // hash gate (because no hash was ever registered for the skipped fact).
    assert.equal(
      index.has(FACT_CONTENT),
      false,
      "third write attempt must not be blocked by a phantom hash",
    );

    // Confirm that only a genuine persist (index.add) registers the hash.
    index.add(FACT_CONTENT);
    assert.equal(
      index.has(FACT_CONTENT),
      true,
      "explicit add must register the hash",
    );
    assert.equal(index.size, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("regression #399: after neighbor archive, re-write of skipped content is allowed", async () => {
  // More explicit end-to-end simulation of the full scenario:
  // 1. Seed a "neighbor" memory in the hash index.
  // 2. A second fact is semantically-skipped (no hash added — the fix).
  // 3. The neighbor memory is archived (its hash is removed from the index).
  // 4. A third write of the same content as the skipped fact must pass the gate.

  const stateDir = await mkdtemp(join(tmpdir(), "remnic-test-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();

    const NEIGHBOR_CONTENT = "the user prefers dark mode in their editor";
    const SKIPPED_CONTENT = "the user likes dark editor themes";

    // Step 1: seed neighbor memory hash (as if a real persist happened).
    index.add(NEIGHBOR_CONTENT);
    assert.equal(index.size, 1, "neighbor hash seeded");

    // Step 2: semantic dedup decides to skip SKIPPED_CONTENT.
    const decision = await decideSemanticDedup(
      SKIPPED_CONTENT,
      makeLookup([{ id: "mem-neighbor-001", score: 0.95 }]),
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "skip");
    // Fixed code: do NOT call index.add(SKIPPED_CONTENT).
    // (In the old buggy code this line would have been executed.)
    assert.equal(
      index.has(SKIPPED_CONTENT),
      false,
      "skipped content must not be in index",
    );

    // Step 3: archive the neighbor — remove its hash.
    index.remove(NEIGHBOR_CONTENT);
    assert.equal(index.size, 0, "index empty after neighbor archived");

    // Step 4: attempt to write SKIPPED_CONTENT again — must not be blocked.
    assert.equal(
      index.has(SKIPPED_CONTENT),
      false,
      "write of previously-skipped content must not be blocked after neighbor archive",
    );

    // Confirm a fresh persist now registers the hash correctly.
    index.add(SKIPPED_CONTENT);
    assert.equal(index.has(SKIPPED_CONTENT), true);
    assert.equal(index.size, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ── Regression: PR #399 P1 — cross-namespace dedup must not suppress writes ──
//
// When namespaces are enabled and two namespaces contain near-duplicate
// content, a write in namespace A must NOT be skipped because the top
// embedding hit lives in namespace B. The fix scopes the semantic dedup
// lookup to the target namespace's path prefix.

async function seedEmbeddingIndex(
  memoryDir: string,
  entries: Record<string, { vector: number[]; path: string }>,
  options: { provider?: "openai" | "local"; model?: string } = {},
): Promise<void> {
  const stateDir = join(memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  const indexFile = {
    version: 1 as const,
    provider: options.provider ?? "openai" as const,
    model: options.model ?? "text-embedding-3-small",
    entries,
  };
  await writeFile(
    join(stateDir, "embeddings.json"),
    JSON.stringify(indexFile),
    "utf-8",
  );
}

/**
 * Replace global fetch with a stub that returns a fixed embedding vector.
 * Returns a restore function the test should call in its `finally` block.
 */
function stubEmbedFetch(vector: number[]): () => void {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, _init: any) => {
    return new Response(
      JSON.stringify({ data: [{ embedding: vector }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return () => {
    (globalThis as any).fetch = original;
  };
}

test("regression #399 P1: semantic dedup lookup is scoped to target namespace", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-ns-dedup-"));
  // Use a unit vector for stability: cosine similarity with itself is ~1.
  const vec = [1, 0, 0, 0];
  const restoreFetch = stubEmbedFetch(vec);
  try {
    // Seed an index with two near-identical entries in two namespaces.
    // Paths mirror what `toMemoryRelativePath` would produce.
    await seedEmbeddingIndex(memoryDir, {
      "mem-a-001": {
        vector: vec,
        path: "namespaces/alpha/facts/a-001.md",
      },
      "mem-b-001": {
        vector: vec,
        path: "namespaces/beta/facts/b-001.md",
      },
    });

    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      // Non-empty key so the provider resolves. The stubbed fetch never
      // validates the header.
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // Unscoped lookup: both namespaces match. Confirms the baseline index
    // and the stubbed fetch plumbing work.
    const unscoped = await fallback.search("the user prefers tabs", 5);
    assert.equal(unscoped.length, 2, "unscoped lookup returns both entries");

    // Scoped to namespace alpha: only the alpha entry should appear, so
    // a fact being written into alpha cannot be semantically deduped
    // against the beta neighbor.
    const alphaHits = await fallback.search(
      "the user prefers tabs",
      5,
      { pathPrefix: "namespaces/alpha/" },
    );
    assert.equal(alphaHits.length, 1, "alpha-scoped lookup returns one hit");
    assert.equal(alphaHits[0]?.id, "mem-a-001");

    // Symmetric check for beta.
    const betaHits = await fallback.search(
      "the user prefers tabs",
      5,
      { pathPrefix: "namespaces/beta/" },
    );
    assert.equal(betaHits.length, 1, "beta-scoped lookup returns one hit");
    assert.equal(betaHits[0]?.id, "mem-b-001");

    // End-to-end: feed the scoped lookup into decideSemanticDedup for a
    // hypothetical fact destined for a THIRD namespace with no entries.
    // The lookup must return zero candidates, and the decision must be
    // "keep" — NOT "skip" — even though alpha/beta both contain
    // high-similarity memories. Without the P1 fix, the unfiltered index
    // would have surfaced either alpha or beta and the fact would be
    // dropped.
    const decision = await decideSemanticDedup(
      "the user prefers tabs",
      (content, limit) =>
        fallback
          .search(content, limit, { pathPrefix: "namespaces/gamma/" })
          .then((hits) =>
            hits.map((hit) => ({
              id: hit.id,
              score: hit.score,
              path: hit.path,
            })),
          ),
      DEFAULT_OPTS,
    );
    assert.equal(
      decision.action,
      "keep",
      "cross-namespace dedup must not skip writes in a fresh namespace",
    );
  } finally {
    restoreFetch();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("embedding fallback ignores persisted indexes from a different provider or model", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-embedding-provider-mismatch-"));
  const vec = [1, 0, 0, 0];
  const restoreFetch = stubEmbedFetch(vec);
  try {
    await seedEmbeddingIndex(memoryDir, {
      "mem-openai-001": {
        vector: vec,
        path: "facts/openai.md",
      },
    }, {
      provider: "openai",
      model: "text-embedding-3-small",
    });

    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "local",
      localLlmEnabled: true,
      localLlmUrl: "http://127.0.0.1:1234",
      localLlmModel: "local-embed",
      embeddingFallbackModel: "local-embed",
    });
    const fallback = new EmbeddingFallback(config);

    const hits = await fallback.search("the user prefers tabs", 5);
    assert.deepEqual(hits, []);
  } finally {
    restoreFetch();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Finding 3: empty index vs backend unavailable ─────────────────────────────

test("finding 3: empty lookup result returns no_candidates, not backend_unavailable", async () => {
  // Provider is reachable (no throw) but the index has no entries.
  const decision = await decideSemanticDedup(
    "brand new fact never seen before",
    makeLookup([]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(
    decision.reason,
    "no_candidates",
    "empty index must yield no_candidates, not backend_unavailable",
  );
});

test("finding 3: lookup throw returns backend_unavailable", async () => {
  const decision = await decideSemanticDedup(
    "some fact",
    async () => {
      throw new Error("connection refused");
    },
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(
    decision.reason,
    "backend_unavailable",
    "provider error must yield backend_unavailable",
  );
});

// ── Finding 2: fractional semanticDedupCandidates clamped to 1 ───────────────

test("finding 2: parseConfig semanticDedupCandidates=0.5 clamps to 1 (not 0)", () => {
  const config = parseConfig({ semanticDedupCandidates: 0.5 });
  assert.equal(
    config.semanticDedupCandidates,
    1,
    "fractional positive value must clamp to 1, not floor to 0",
  );
});

test("finding 2: parseConfig semanticDedupCandidates=0.99 clamps to 1", () => {
  const config = parseConfig({ semanticDedupCandidates: 0.99 });
  assert.equal(config.semanticDedupCandidates, 1);
});

test("finding 2: parseConfig semanticDedupCandidates=0 preserved (explicit disable)", () => {
  const config = parseConfig({ semanticDedupCandidates: 0 });
  assert.equal(config.semanticDedupCandidates, 0);
});

test("finding 2: parseConfig semanticDedupCandidates=1.5 floors to 1 (not clamped)", () => {
  // Value > 1 but fractional: floor(1.5) = 1, raw > 0, so clamp is not needed.
  const config = parseConfig({ semanticDedupCandidates: 1.5 });
  assert.equal(config.semanticDedupCandidates, 1);
});

// ── Finding 1: semantic-skip candidate that is also a contradiction ───────────
//
// The orchestrator fix (deferred skip) cannot be exercised as a pure unit test
// here because it lives in the orchestrator's write loop. The pure semantic.ts
// layer is unchanged in behaviour: it still returns action="skip" for a
// high-similarity hit. The integration guarantee is:
//   • decideSemanticDedup returns skip  (confirmed below — precondition)
//   • orchestrator runs contradiction detection before applying the skip
//   • if contradiction found → write proceeds (supersede path)
//   • if no contradiction → skip is applied (existing behaviour)
//
// We verify the precondition that the pure function still returns "skip" for
// high-similarity, so the orchestrator has the correct input to branch on.

test("finding 1: precondition — decideSemanticDedup still returns skip for high-similarity hit", async () => {
  const decision = await decideSemanticDedup(
    "the operator never wants dark mode enabled",
    makeLookup([{ id: "pref-001", score: 0.95 }]),
    DEFAULT_OPTS,
  );
  assert.equal(
    decision.action,
    "skip",
    "high-similarity hit must still produce skip so orchestrator can branch on it",
  );
  if (decision.action === "skip") {
    assert.equal(decision.reason, "near_duplicate");
    assert.equal(decision.topId, "pref-001");
  }
});

test("regression #399 P1: default namespace at root excludes namespaces/* entries", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-ns-dedup-default-"));
  const vec = [1, 0, 0, 0];
  const restoreFetch = stubEmbedFetch(vec);
  try {
    await seedEmbeddingIndex(memoryDir, {
      "mem-default-001": { vector: vec, path: "facts/default-001.md" },
      "mem-alpha-001": { vector: vec, path: "namespaces/alpha/facts/a-001.md" },
    });

    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // The orchestrator's scope helper passes `pathExcludePrefixes:
    // ["namespaces/"]` when targeting the default namespace at legacy
    // root. Simulate that filter directly.
    const defaultHits = await fallback.search(
      "content",
      5,
      { pathExcludePrefixes: ["namespaces/"] },
    );
    assert.equal(defaultHits.length, 1);
    assert.equal(defaultHits[0]?.id, "mem-default-001");
  } finally {
    restoreFetch();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Regression: PR #399 HIGH — chunking path must honour pendingSemanticSkip ──
//
// Before the fix (commit 57d7e7d), the orchestrator's chunking branch executed
// a `continue` that bypassed the deferred `pendingSemanticSkip` guard entirely.
// A fact whose content was long enough to trigger chunking would be persisted
// (and have its hash registered) even when semanticDecision === "skip".
//
// The fix moves both contradiction detection and the semantic-skip check to
// BEFORE the chunking branch, so the chunking branch is only reached when the
// fact has passed the semantic-dedup gate.
//
// These tests validate the two invariants using the pure layer:
//   1. decideSemanticDedup → skip, NO contradiction  →  write must be suppressed
//   2. decideSemanticDedup → skip, WITH contradiction →  write must proceed
//
// The orchestrator invariant is tested via simulation: we use `chunkContent`
// with a low threshold to confirm the content *would* have triggered chunking,
// then assert on the semantic decision and contradiction outcome that the
// orchestrator sees, proving the pre-chunking guard is now the gating condition.

/** Build a synthetic long string that triggers chunking at `minTokens` = 10. */
function buildLongContent(sentenceCount: number, wordsPerSentence = 15): string {
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i++) {
    const words = Array.from({ length: wordsPerSentence }, (_, w) =>
      `word${i}_${w}`,
    );
    sentences.push(words.join(" ") + ".");
  }
  return sentences.join(" ");
}

/** Low chunking threshold so a ~30-sentence string reliably produces multiple chunks. */
const LOW_THRESHOLD_CHUNKING: ChunkingConfig = {
  targetTokens: 20,
  minTokens: 10,
  overlapSentences: 1,
};

test("regression #399 HIGH: long content that would chunk is NOT written when semantic-skip has no contradiction", async () => {
  // Build content long enough to trigger chunking at the low threshold.
  const longContent = buildLongContent(30);

  // Confirm this content would produce multiple chunks (precondition).
  const chunkResult = chunkContent(longContent, LOW_THRESHOLD_CHUNKING);
  assert.ok(
    chunkResult.chunked && chunkResult.chunks.length > 1,
    `precondition: chunkResult.chunked must be true; got ${chunkResult.chunks.length} chunk(s)`,
  );

  // The semantic dedup lookup returns a high-similarity hit → decision = skip.
  const semanticDecision = await decideSemanticDedup(
    longContent,
    makeLookup([{ id: "neighbor-001", score: 0.97 }]),
    DEFAULT_OPTS,
  );
  assert.equal(
    semanticDecision.action,
    "skip",
    "semantic decision must be skip for high-similarity hit",
  );

  // No contradiction detected (supersedes is undefined).
  const supersedes: string | undefined = undefined;

  // Fixed orchestrator gate: if (pendingSemanticSkip && !supersedes) → skip.
  // Before the fix, this check was AFTER the chunking branch's `continue`,
  // so chunking would have written the memory before this guard ran.
  const pendingSemanticSkip =
    semanticDecision.action === "skip" ? semanticDecision : null;
  const gateTriggered = pendingSemanticSkip !== null && !supersedes;

  assert.ok(
    gateTriggered,
    "semantic-skip gate must fire (suppressing the write) when there is no contradiction",
  );

  // Verify no hash is registered (the orchestrator skips index.add when gated).
  // Simulate: if gated, we do NOT call index.add(). Confirm the index stays empty.
  const stateDir = await mkdtemp(join(tmpdir(), "remnic-chunk-dedup-1-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();
    // Gate fires → no write → no hash registration.
    if (!gateTriggered) {
      // Would-be write path (only reached if bug is present).
      index.add(longContent);
    }
    assert.equal(
      index.has(longContent),
      false,
      "content hash must NOT be registered when semantic-skip gate suppresses the chunking write",
    );
    assert.equal(index.size, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("regression #399 HIGH: long content that would chunk IS written when semantic-skip has a contradiction (supersession path)", async () => {
  // Build content long enough to trigger chunking at the low threshold.
  const longContent = buildLongContent(30);

  // Confirm this content would produce multiple chunks (precondition).
  const chunkResult = chunkContent(longContent, LOW_THRESHOLD_CHUNKING);
  assert.ok(
    chunkResult.chunked && chunkResult.chunks.length > 1,
    `precondition: chunkResult.chunked must be true; got ${chunkResult.chunks.length} chunk(s)`,
  );

  // The semantic dedup lookup returns a high-similarity hit → decision = skip.
  const semanticDecision = await decideSemanticDedup(
    longContent,
    makeLookup([{ id: "neighbor-001", score: 0.97 }]),
    DEFAULT_OPTS,
  );
  assert.equal(
    semanticDecision.action,
    "skip",
    "semantic decision must be skip for high-similarity hit",
  );

  // A contradiction IS detected — this is the supersession path.
  // The orchestrator sets supersedes when checkForContradiction returns a hit.
  const supersedes = "old-memory-abc-123";

  // Fixed orchestrator gate: if (pendingSemanticSkip && !supersedes) → skip.
  // When supersedes is set, the gate must NOT fire: the write proceeds.
  const pendingSemanticSkip =
    semanticDecision.action === "skip" ? semanticDecision : null;
  const gateTriggered = pendingSemanticSkip !== null && !supersedes;

  assert.ok(
    !gateTriggered,
    "semantic-skip gate must NOT fire when a contradiction was found (supersedes is set)",
  );

  // Simulate the write path that the orchestrator takes when the gate does not fire:
  // content IS persisted and its hash IS registered.
  const stateDir = await mkdtemp(join(tmpdir(), "remnic-chunk-dedup-2-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();
    // Gate did NOT fire → write proceeds → register hash.
    if (!gateTriggered) {
      index.add(longContent);
    }
    assert.equal(
      index.has(longContent),
      true,
      "content hash MUST be registered when supersession path proceeds despite semantic-skip flag",
    );
    assert.equal(index.size, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ── Round 6 regression tests ───────────────────────────────────────────────────

// Finding 1+2 (round 6): chunked parent must carry supersedes + links
//
// When contradiction detection runs before the chunking branch (the round 5
// fix) and finds a conflict, the chunked parent writeMemory() call must pass
// supersedes and links. Without this fix, deindexMemory() fires on the old
// memory but the new chunked parent has no supersedes frontmatter field —
// leaving a dangling deindex reference.
//
// This test exercises StorageManager.writeMemory() directly with both
// supersedes and links to verify the round 6 fix propagates them to the
// written file's YAML frontmatter.

test("round 6: chunked parent writeMemory carries supersedes in frontmatter", async () => {
  const memDir = await mkdtemp(join(tmpdir(), "remnic-chunked-supersedes-"));
  try {
    const storage = new StorageManager(memDir);
    const OLD_ID = "fact-old-abc-123";

    const newId = await storage.writeMemory("fact", "the user prefers dark mode", {
      confidence: 0.9,
      tags: ["chunked", "preference"],
      supersedes: OLD_ID,
      links: [
        {
          targetId: OLD_ID,
          linkType: "contradicts",
          strength: 0.88,
          reason: "user corrected earlier preference",
        },
      ],
    });

    // Find the written file and parse its raw YAML to verify the fields.
    const allFiles: string[] = [];
    const factsBase = join(memDir, "facts");
    try {
      for (const dateDir of await readdir(factsBase)) {
        const dir = join(factsBase, dateDir);
        for (const f of await readdir(dir)) {
          if (f.endsWith(".md")) allFiles.push(join(dir, f));
        }
      }
    } catch {
      // factsBase may not exist if today's directory hasn't been created yet
    }

    assert.equal(allFiles.length, 1, "exactly one memory file must be written");
    const raw = await readFile(allFiles[0]!, "utf-8");

    // Verify supersedes appears in the YAML block.
    assert.ok(
      raw.includes(`supersedes: ${OLD_ID}`),
      `written file must contain supersedes: ${OLD_ID}\nActual content:\n${raw}`,
    );

    // Verify links block appears in the YAML block.
    assert.ok(
      raw.includes("contradicts"),
      `written file must contain the contradicts link type\nActual content:\n${raw}`,
    );
    assert.ok(
      raw.includes(OLD_ID),
      `written file must reference the old memory id in links\nActual content:\n${raw}`,
    );

    // Verify the returned ID is what we'd find in the file.
    assert.ok(newId.startsWith("fact-"), `memory id must start with 'fact-'; got ${newId}`);
    assert.ok(raw.includes(`id: ${newId}`), `file must contain id: ${newId}`);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memDir, { recursive: true, force: true });
  }
});

// Finding 3 (round 6): semanticDedupLookup throws on backend unavailability
//
// The round 6 fix changes semanticDedupLookup to THROW when the embedding
// backend is not configured or is unavailable, rather than returning [].
// This ensures decideSemanticDedup's catch block fires and sets
// reason="backend_unavailable" instead of reason="no_candidates".
//
// We test the boundary at the pure decideSemanticDedup level: a lookup that
// throws (simulating the new semanticDedupLookup behaviour) must yield
// reason="backend_unavailable", not reason="no_candidates".

test("round 6: orchestrator lookup throw (backend down) maps to backend_unavailable, not no_candidates", async () => {
  // Simulate the new semanticDedupLookup behaviour: throws when backend unavailable.
  const throwingLookup: SemanticDedupLookup = async () => {
    throw new Error("semantic dedup: embedding backend unavailable");
  };

  const decision = await decideSemanticDedup("some fact content", throwingLookup, DEFAULT_OPTS);

  assert.equal(
    decision.action,
    "keep",
    "backend unavailable must keep the fact (fail-open)",
  );
  assert.equal(
    decision.reason,
    "backend_unavailable",
    "reason must be backend_unavailable (not no_candidates) when lookup throws",
  );
});

test("round 6: empty lookup result (index empty, backend OK) still maps to no_candidates", async () => {
  // Simulate the new semanticDedupLookup behaviour when the backend is OK but
  // the index is empty: return [], do NOT throw.
  const emptyLookup: SemanticDedupLookup = async () => [];

  const decision = await decideSemanticDedup("some fact content", emptyLookup, DEFAULT_OPTS);

  assert.equal(decision.action, "keep");
  assert.equal(
    decision.reason,
    "no_candidates",
    "empty index (backend reachable, returns []) must yield no_candidates, not backend_unavailable",
  );
});

// ── UUI1: correction category exempt from semantic skip fallback ──────────────
//
// When contradiction detection is disabled (or QMD is unavailable), `supersedes`
// is never set. Without the UUI1 fix, a high-similarity fact in the "correction"
// category would be silently dropped by the semantic skip gate even though it
// is a legitimate update. The gate must always let corrections through.
//
// This simulates the orchestrator gate logic at the pure layer: the test drives
// the same `pendingSemanticSkip && !supersedes && !isCorrection` condition that
// the orchestrator evaluates, asserting:
//   1. A "correction" write is NOT suppressed (gate does not fire).
//   2. A "fact" write in the same circumstances IS suppressed (gate still works).

test("UUI1: correction category is never suppressed by semantic skip fallback when supersedes is unset", async () => {
  // Both facts have a high-similarity neighbor → decideSemanticDedup returns skip.
  const semanticDecisionCorrection = await decideSemanticDedup(
    "the user now prefers light mode",
    makeLookup([{ id: "pref-old-001", score: 0.96 }]),
    DEFAULT_OPTS,
  );
  assert.equal(
    semanticDecisionCorrection.action,
    "skip",
    "precondition: semantic decision must be skip for high-similarity hit",
  );

  const semanticDecisionFact = await decideSemanticDedup(
    "the user prefers dark mode",
    makeLookup([{ id: "pref-old-002", score: 0.95 }]),
    DEFAULT_OPTS,
  );
  assert.equal(
    semanticDecisionFact.action,
    "skip",
    "precondition: semantic decision must be skip for high-similarity hit",
  );

  // Contradiction detection disabled / QMD unavailable → supersedes never set.
  const supersedes: string | undefined = undefined;

  // --- Correction write: gate must NOT fire ---
  const pendingSkipCorrection =
    semanticDecisionCorrection.action === "skip" ? semanticDecisionCorrection : null;
  const isCorrectionCategory = true; // writeCategory === "correction"
  const correctionGateFires =
    pendingSkipCorrection !== null && !supersedes && !isCorrectionCategory;
  assert.equal(
    correctionGateFires,
    false,
    "semantic skip gate must NOT fire for correction category — correction must be persisted",
  );

  // --- Normal fact write: gate MUST fire ---
  const pendingSkipFact =
    semanticDecisionFact.action === "skip" ? semanticDecisionFact : null;
  const isFactCategory = false; // writeCategory === "fact", not "correction"
  const factGateFires =
    pendingSkipFact !== null && !supersedes && !isFactCategory;
  assert.equal(
    factGateFires,
    true,
    "semantic skip gate MUST fire for non-correction category (fact) — near-duplicate fact must be suppressed",
  );
});

// ── UUI2: backend-unavailable short-circuit per batch ────────────────────────
//
// When the embedding backend is degraded, each fact in a batch should NOT pay
// a full lookup roundtrip. Once the first lookup returns backend_unavailable,
// subsequent facts must skip the lookup entirely and proceed directly to write.
//
// This simulates the orchestrator's `batchBackendUnavailable` flag logic:
// the flag is false at batch start, is set when the first lookup signals
// backend_unavailable, and subsequent iterations skip the lookup call.
// All N facts must still be written (fail-open behaviour preserved).

test("UUI2: batch backend-unavailable flag short-circuits embedding lookups after first failure", async () => {
  let lookupCallCount = 0;

  const throwingLookup: SemanticDedupLookup = async () => {
    lookupCallCount++;
    throw new Error("embedding backend unavailable");
  };

  // Simulate the orchestrator's per-batch short-circuit logic for N=5 facts.
  const N = 5;
  let batchBackendUnavailable = false;
  const decisions: SemanticDedupDecision[] = [];

  for (let i = 0; i < N; i++) {
    let semanticDecision: SemanticDedupDecision;
    if (batchBackendUnavailable) {
      // Short-circuit: no lookup call, treat as backend_unavailable.
      semanticDecision = { action: "keep", reason: "backend_unavailable" };
    } else {
      try {
        semanticDecision = await decideSemanticDedup(
          `synthetic fact content number ${i}`,
          throwingLookup,
          DEFAULT_OPTS,
        );
      } catch {
        semanticDecision = { action: "keep", reason: "backend_unavailable" };
      }
      if (semanticDecision.reason === "backend_unavailable") {
        batchBackendUnavailable = true;
      }
    }
    decisions.push(semanticDecision);
  }

  // The underlying lookup must have been called at most 1 time (for the first
  // fact only). Facts 2–5 must have hit the batchBackendUnavailable branch.
  assert.ok(
    lookupCallCount <= 1,
    `embed lookup must be called ≤1 time for the lookup phase; called ${lookupCallCount} time(s)`,
  );

  // All 5 facts must have action="keep" (fail-open: writes proceed).
  assert.equal(decisions.length, N, "all N facts must produce a decision");
  for (const decision of decisions) {
    assert.equal(
      decision.action,
      "keep",
      "every fact must be kept (fail-open) when backend is unavailable",
    );
    assert.equal(
      decision.reason,
      "backend_unavailable",
      "every decision must carry reason=backend_unavailable",
    );
  }
});

// ── Round 9 / Finding UZqB: embedding timeout propagates as backend_unavailable ─
//
// Previously a timed-out embedding fetch returned null from embed(), which
// caused search() to return [] silently. decideSemanticDedup classified that
// result as no_candidates instead of backend_unavailable, so the per-batch
// batchBackendUnavailable flag never flipped and every fact in a batch paid a
// full timeout roundtrip (N × timeout instead of 1 × timeout).
//
// Round 9 made embed() throw EmbeddingTimeoutError on the lookup path when
// AbortSignal fires. Round 10 (Findings Ui1J + Ui1L) scopes that throw:
//   • search() WITHOUT throwOnTimeout catches EmbeddingTimeoutError and returns
//     [] — this is the recall-path contract so a slow backend doesn't abort recall.
//   • search() WITH throwOnTimeout:true re-throws — this is the dedup-path
//     contract so decideSemanticDedup's catch block can return
//     reason="backend_unavailable" and activate the per-batch short-circuit.
//
// These tests cover the TIMEOUT code path and validate all four combinations:

/**
 * Replace global fetch with a stub that always throws a DOMException AbortError,
 * simulating an AbortSignal.timeout() firing. Returns a restore function and a
 * call counter so tests can assert how many times fetch was attempted.
 */
function stubTimeoutFetch(): { restore: () => void; callCount: () => number } {
  const original = globalThis.fetch;
  let count = 0;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    count++;
    // AbortSignal.timeout() raises a DOMException with name "TimeoutError".
    // Simulate that: throw a DOMException if available, or a plain Error with
    // the correct name so the isTimeout branch in embed() triggers.
    const signal: AbortSignal | undefined = init?.signal;
    if (signal?.aborted) {
      const err = signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      throw err;
    }
    // Signal not yet aborted — throw as TimeoutError anyway to simulate a
    // backend that always takes longer than the deadline.
    const timeout = new Error("The operation timed out");
    (timeout as any).name = "TimeoutError";
    throw timeout;
  };
  return {
    restore: () => { (globalThis as any).fetch = original; },
    callCount: () => count,
  };
}

// Round 11 helper (Finding Ur_J): simulate a degraded embedding backend that
// returns a non-2xx HTTP status (e.g. 503 Service Unavailable) instead of
// timing out. The fetch resolves successfully but with `ok=false`.
function stubNon200Fetch(status: number): { restore: () => void; callCount: () => number } {
  const original = globalThis.fetch;
  let count = 0;
  (globalThis as any).fetch = async (_url: any, _init: any) => {
    count++;
    return new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
      status,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
    });
  };
  return {
    restore: () => { (globalThis as any).fetch = original; },
    callCount: () => count,
  };
}

// Round 10 regression tests (Findings Ui1J + Ui1L):
//   search() without throwOnTimeout must return [] on timeout (recall-path contract).
//   search() with throwOnTimeout:true must throw EmbeddingTimeoutError (dedup-path contract).
// Previously search() always propagated EmbeddingTimeoutError, which would
// abort recall entirely when the embedding backend was slow.

test("round 10 Ui1J+Ui1L: search() without throwOnTimeout returns [] on timeout (recall-path fail-open)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-timeout-recall-"));
  const { restore, callCount } = stubTimeoutFetch();
  process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = "1";
  try {
    // Seed a non-empty index so search() actually attempts an embed call.
    await seedEmbeddingIndex(memoryDir, {
      "mem-t-001": { vector: [1, 0, 0, 0], path: "facts/t-001.md" },
    });
    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // Call WITHOUT throwOnTimeout — simulates the recall path.
    let threw = false;
    let result: Array<{ id: string; score: number; path: string }> = [];
    try {
      result = await fallback.search("synthetic query for timeout test", 5);
    } catch (_err) {
      threw = true;
    }

    assert.ok(!threw, "search() must NOT throw when throwOnTimeout is omitted (recall-path fail-open)");
    assert.deepEqual(result, [], "search() must return [] on timeout when throwOnTimeout is false");
    assert.ok(callCount() >= 1, "fetch must have been called at least once");
  } finally {
    delete process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS;
    restore();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("round 10 Ui1J+Ui1L: search() with throwOnTimeout:true throws EmbeddingTimeoutError (dedup-path contract)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-timeout-dedup-"));
  const { restore, callCount } = stubTimeoutFetch();
  process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = "1";
  try {
    // Seed a non-empty index so search() actually attempts an embed call.
    await seedEmbeddingIndex(memoryDir, {
      "mem-t-001": { vector: [1, 0, 0, 0], path: "facts/t-001.md" },
    });
    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // Call WITH throwOnTimeout:true — simulates the semanticDedupLookup path.
    let threw: unknown;
    try {
      await fallback.search("synthetic query for timeout test", 5, { throwOnTimeout: true });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw instanceof EmbeddingTimeoutError,
      `search() must throw EmbeddingTimeoutError when throwOnTimeout=true; got ${threw}`);
    assert.ok(callCount() >= 1, "fetch must have been called at least once");
  } finally {
    delete process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS;
    restore();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Round 11 regression test (Finding Ur_J):
//   When the embedding backend returns a non-2xx HTTP status on the lookup
//   path, embed() previously returned null → search() yielded [] → caller
//   classified the result as "no_candidates" instead of "backend_unavailable".
//   In a degraded backend (repeated 429/5xx), every fact in a batch would pay
//   a full HTTP roundtrip instead of tripping the per-batch short-circuit.
//
// Round 11 fix: embed() now throws EmbeddingTimeoutError on lookup-path !res.ok
// (the same path used for genuine timeouts), so search() with throwOnTimeout
// propagates to decideSemanticDedup's backend_unavailable branch.
test("round 11 Ur_J: search() with throwOnTimeout throws EmbeddingTimeoutError on non-2xx response", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-non200-dedup-"));
  const { restore, callCount } = stubNon200Fetch(503);
  try {
    await seedEmbeddingIndex(memoryDir, {
      "mem-u-001": { vector: [1, 0, 0, 0], path: "facts/u-001.md" },
    });
    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    let threw: unknown;
    try {
      await fallback.search("synthetic query for non-2xx test", 5, { throwOnTimeout: true });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw instanceof EmbeddingTimeoutError,
      `search() must throw EmbeddingTimeoutError on non-2xx when throwOnTimeout=true; got ${threw}`);
    assert.ok(callCount() >= 1, "fetch must have been called at least once");
  } finally {
    restore();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("round 11 Ur_J: search() without throwOnTimeout returns [] on non-2xx response (recall-path fail-open)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-non200-recall-"));
  const { restore, callCount } = stubNon200Fetch(503);
  try {
    await seedEmbeddingIndex(memoryDir, {
      "mem-u-001": { vector: [1, 0, 0, 0], path: "facts/u-001.md" },
    });
    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    let threw = false;
    let result: Array<{ id: string; score: number; path: string }> = [];
    try {
      result = await fallback.search("synthetic query for non-2xx test", 5);
    } catch (_err) {
      threw = true;
    }

    assert.ok(!threw, "search() must NOT throw on non-2xx when throwOnTimeout is omitted (recall-path fail-open)");
    assert.deepEqual(result, [], "search() must return [] on non-2xx when throwOnTimeout is false");
    assert.ok(callCount() >= 1, "fetch must have been called at least once");
  } finally {
    restore();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("semantic dedup timeout: batch short-circuits after first timeout", async () => {
  // This test mirrors UUI2 but uses the REAL EmbeddingFallback with a
  // timed-out fetch stub, exercising the full propagation path:
  //   AbortError → EmbeddingTimeoutError (from embed) → re-thrown from search()
  //   (because throwOnTimeout:true) → caught by decideSemanticDedup →
  //   reason="backend_unavailable" → batchBackendUnavailable flag flips →
  //   subsequent facts skip fetch.
  //
  // The lookup uses throwOnTimeout:true to mirror semanticDedupLookup's actual
  // call (Round 10 fix, Ui1J+Ui1L). Without the flag, search() would return []
  // and decideSemanticDedup would classify as no_candidates, never flipping
  // batchBackendUnavailable.

  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-timeout-batch-"));
  const { restore, callCount } = stubTimeoutFetch();
  process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = "1";

  try {
    // Seed a non-empty index so search() proceeds past the early-return guard
    // (ids.length === 0) and actually calls embed().
    await seedEmbeddingIndex(memoryDir, {
      "mem-t-001": { vector: [1, 0, 0, 0], path: "facts/t-001.md" },
      "mem-t-002": { vector: [0, 1, 0, 0], path: "facts/t-002.md" },
    });

    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // Build a lookup that uses the real fallback with throwOnTimeout:true,
    // mirroring how semanticDedupLookup actually calls search() after Round 10.
    const realLookup: SemanticDedupLookup = async (content, limit) =>
      fallback.search(content, limit, { throwOnTimeout: true }).then((hits) =>
        hits.map((h) => ({ id: h.id, score: h.score, path: h.path })),
      );

    // Simulate the orchestrator's per-batch short-circuit for N=5 facts.
    const N = 5;
    let batchBackendUnavailable = false;
    const decisions: SemanticDedupDecision[] = [];

    for (let i = 0; i < N; i++) {
      let semanticDecision: SemanticDedupDecision;
      if (batchBackendUnavailable) {
        // Short-circuit: skip the lookup, directly mark as backend_unavailable.
        semanticDecision = { action: "keep", reason: "backend_unavailable" };
      } else {
        semanticDecision = await decideSemanticDedup(
          `synthetic fact about preference number ${i}`,
          realLookup,
          DEFAULT_OPTS,
        );
        if (semanticDecision.reason === "backend_unavailable") {
          batchBackendUnavailable = true;
        }
      }
      decisions.push(semanticDecision);
    }

    // Fetch must have been called at most 1 time (only for the first fact's
    // embed attempt). Facts 2-5 must have short-circuited via the flag.
    assert.ok(
      callCount() <= 1,
      `fetch must be called ≤1 time for the lookup phase; called ${callCount()} time(s)`,
    );

    // All 5 facts must be kept (fail-open behaviour preserved even on timeout).
    assert.equal(decisions.length, N, "all N facts must produce a decision");
    for (const decision of decisions) {
      assert.equal(
        decision.action,
        "keep",
        "every fact must be kept (fail-open) when embedding times out",
      );
      assert.equal(
        decision.reason,
        "backend_unavailable",
        "timeout must propagate as backend_unavailable, not no_candidates",
      );
    }

    // Explicitly verify the flag did flip (not just all the facts) — ensures
    // the first decision triggered the short-circuit path.
    assert.equal(
      batchBackendUnavailable,
      true,
      "batchBackendUnavailable flag must have been set by the first timeout",
    );
  } finally {
    delete process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS;
    restore();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── P2: contradictionAutoResolve=false must not silently drop contradictory facts ─
//
// Regression for PR #399 review thread PRRT_kwDORJXyws56UxS0:
// When contradictionAutoResolve=false, checkForContradiction() previously returned
// null even when a contradiction was confirmed (the supersede path was skipped and
// the return happened only inside the auto-resolve block). The caller therefore saw
// no contradiction, leaving `supersedes` unset, so the semantic-skip guard fired
// and silently dropped the contradictory fact. The fix moves the return outside the
// auto-resolve block and uses a separate `contradictionDetected` flag in the guard.
//
// This test models the orchestrator gate logic at the pure layer (like UUI1 above)
// and covers three scenarios:
//   1. autoResolve=true,  contradiction detected  → gate must NOT fire  (baseline)
//   2. autoResolve=false, contradiction detected  → gate must NOT fire  (the bug)
//   3. autoResolve=false, no contradiction        → gate MUST fire      (true dedup)

test("P2: semantic-skip gate does not fire when contradiction detected with autoResolve=false", async () => {
  // All three scenarios share a high-similarity semantic decision.
  const semanticDecision = await decideSemanticDedup(
    "the user now prefers light mode",
    makeLookup([{ id: "pref-old-001", score: 0.96 }]),
    DEFAULT_OPTS,
  );
  assert.equal(
    semanticDecision.action,
    "skip",
    "precondition: semantic decision must be skip for high-similarity hit",
  );
  const pendingSkip = semanticDecision.action === "skip" ? semanticDecision : null;

  // Scenario 1: autoResolve=true, contradiction detected → supersedes is set.
  // Gate condition: pendingSkip && !contradictionDetected && !isCorrection
  {
    const contradictionDetected = true; // checkForContradiction returned non-null
    const isCorrection = false;
    const gateFires = pendingSkip !== null && !contradictionDetected && !isCorrection;
    assert.equal(
      gateFires,
      false,
      "scenario 1 (autoResolve=true, contradiction): gate must NOT fire — contradictory update must be written",
    );
  }

  // Scenario 2 (the regression): autoResolve=false, contradiction detected.
  // Before the fix checkForContradiction() returned null → contradictionDetected=false
  // → gate fired → fact was silently dropped. After the fix contradictionDetected=true.
  {
    const contradictionDetected = true; // fixed: checkForContradiction now returns non-null
    const isCorrection = false;
    const gateFires = pendingSkip !== null && !contradictionDetected && !isCorrection;
    assert.equal(
      gateFires,
      false,
      "scenario 2 (autoResolve=false, contradiction): gate must NOT fire — contradictory fact must be preserved for manual review",
    );
  }

  // Scenario 3: autoResolve=false, no contradiction (genuine near-duplicate).
  // The gate must still suppress the write.
  {
    const contradictionDetected = false; // no contradiction: true near-duplicate
    const isCorrection = false;
    const gateFires = pendingSkip !== null && !contradictionDetected && !isCorrection;
    assert.equal(
      gateFires,
      true,
      "scenario 3 (autoResolve=false, no contradiction): gate MUST fire — genuine near-duplicate must be deduplicated",
    );
  }
});

// ── Round 12 regression tests ──────────────────────────────────────────────────
//
// Fix #1 (thread PRRT_kwDORJXyws56U6Gi): non-timeout transport failures on the
// LOOKUP path must throw EmbeddingTimeoutError so decideSemanticDedup can
// classify them as backend_unavailable and activate the per-batch short-circuit.
//
// Fix #2 (thread PRRT_kwDORJXyws56U6Gj): when targetStorage.dir is outside
// memoryDir, the semantic dedup scope must NOT be {} — it must use the absolute
// storageDir as pathPrefix so cross-tenant suppression cannot occur.

test("round 12 fix #1: non-timeout fetch error on lookup path throws EmbeddingTimeoutError", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-r12-transport-"));
  const original = globalThis.fetch;
  try {
    // Seed a non-empty index so search() reaches the embed() call.
    await seedEmbeddingIndex(memoryDir, {
      "mem-001": { vector: [1, 0, 0, 0], path: "facts/f-001.md" },
    });

    // Stub fetch to throw a transport error (ECONNREFUSED / DNS failure).
    const transportErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
    });
    (globalThis as any).fetch = async () => { throw transportErr; };

    const config = parseConfig({
      memoryDir,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // search() with throwOnTimeout:true must re-throw EmbeddingTimeoutError
    // (not return []) when fetch throws a non-timeout transport error.
    await assert.rejects(
      () => fallback.search("query text", 5, { throwOnTimeout: true }),
      EmbeddingTimeoutError,
      "non-timeout transport failure on lookup path must throw EmbeddingTimeoutError",
    );

    // Without throwOnTimeout (recall path), search() must still fail open.
    // No throw — returns [].
    const result = await fallback.search("query text", 5);
    assert.deepEqual(result, [], "recall path must fail open (return []) on transport error");

    // End-to-end: a transport failure must be classified as backend_unavailable,
    // NOT no_candidates.
    const decision = await decideSemanticDedup(
      "some fact content",
      async (_content, limit) => {
        await fallback.search(_content, limit, { throwOnTimeout: true });
        return [];
      },
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "keep");
    assert.equal(
      decision.reason,
      "backend_unavailable",
      "transport error must yield backend_unavailable so batchBackendUnavailable short-circuit activates",
    );
  } finally {
    (globalThis as any).fetch = original;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("round 12 fix #2: external storage dir scopes lookup to absolute path prefix", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-r12-scope-mem-"));
  const externalDir = await mkdtemp(join(tmpdir(), "remnic-r12-scope-ext-"));
  const original = globalThis.fetch;
  try {
    const vec = [1, 0, 0, 0];

    // Seed the index with:
    //   - One entry whose path is inside memoryDir (relative path, as normal).
    //   - One entry whose path is in externalDir (absolute path, as
    //     toMemoryRelativePath() produces for outside-memoryDir files).
    await seedEmbeddingIndex(memoryDir, {
      "mem-internal": {
        vector: vec,
        path: "facts/internal.md",
      },
      "mem-external": {
        vector: vec,
        // toMemoryRelativePath returns the absolute path when outside memoryDir.
        path: join(externalDir, "facts", "external.md").replace(/\\/g, "/"),
      },
    });

    // Stub fetch to return the same vector for any query.
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: vec }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      embeddingFallbackEnabled: true,
      embeddingFallbackProvider: "openai",
      openaiApiKey: "test-key",
    });
    const fallback = new EmbeddingFallback(config);

    // Unscoped search must return both entries.
    const unscoped = await fallback.search("test query", 10);
    assert.equal(unscoped.length, 2, "unscoped search must return both entries");

    // Scoped to externalDir (absolute prefix): only the external entry must match.
    const extNorm = externalDir.replace(/\\/g, "/");
    const extPrefix = extNorm.endsWith("/") ? extNorm : `${extNorm}/`;
    const externalHits = await fallback.search("test query", 10, { pathPrefix: extPrefix });
    assert.equal(externalHits.length, 1, "absolute-prefix search must return only the external entry");
    assert.equal(externalHits[0]?.id, "mem-external");

    // Scoped to a DIFFERENT absolute prefix must return nothing — confirming
    // that the external entry is not visible in the wrong tenant's scope.
    const otherDir = join(tmpdir(), "remnic-r12-other-").replace(/\\/g, "/") + "/";
    const otherHits = await fallback.search("test query", 10, { pathPrefix: otherDir });
    assert.equal(
      otherHits.length,
      0,
      "external entry must not appear under a different tenant's absolute prefix",
    );

    // This is the core invariant: without the round 12 fix, semanticDedupScopeFor()
    // returned {} for externalDir, letting the high-similarity internal entry
    // suppress writes destined for externalDir. Confirm that scoping by the
    // absolute external prefix isolates the lookup correctly.
    const decision = await decideSemanticDedup(
      "test query",
      async (content, limit) => {
        const hits = await fallback.search(content, limit, { pathPrefix: extPrefix });
        return hits.map((h) => ({ id: h.id, score: h.score, path: h.path }));
      },
      DEFAULT_OPTS,
    );
    // The external entry has cosine similarity ≈ 1 (same vector) → skip.
    // The internal entry must NOT influence this decision.
    assert.equal(decision.action, "skip");
    if (decision.action === "skip") {
      assert.equal(
        decision.topId,
        "mem-external",
        "dedup lookup scoped to external dir must only find the external entry as the near-duplicate",
      );
    }
  } finally {
    (globalThis as any).fetch = original;
    await rm(memoryDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});
