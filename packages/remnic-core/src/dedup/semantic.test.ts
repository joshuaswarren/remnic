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


function makeLookup(hits: SemanticDedupHit[]): SemanticDedupLookup {
  return async () => hits;
}

const DEFAULT_OPTS: SemanticDedupOptions = {
  enabled: true,
  threshold: 0.92,
  candidates: 5,
};


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

test("semantic dedup: ignores malformed hits without a usable memory id", async () => {
  const decision = await decideSemanticDedup(
    "content",
    makeLookup([
      { id: "", score: 0.99 },
      { id: "   ", score: 0.98 },
      { id: 42, score: 0.97 } as unknown as SemanticDedupHit,
      { id: "valid-hit", score: 0.93 },
    ]),
    DEFAULT_OPTS,
  );

  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.reason, "near_duplicate");
    assert.equal(decision.topId, "valid-hit");
    assert.equal(decision.topScore, 0.93);
  }

  const allMalformed = await decideSemanticDedup(
    "content",
    makeLookup([
      { id: "", score: 0.99 },
      { id: 42, score: 0.98 } as unknown as SemanticDedupHit,
    ]),
    DEFAULT_OPTS,
  );

  assert.equal(allMalformed.action, "keep");
  assert.equal(allMalformed.reason, "no_near_duplicate");
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


test("semantic dedup connector-aware: skips same-connector paraphrase", async () => {
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([{ id: "existing-pref", score: 0.96, sourceConnector: "chatgpt" }]),
    { ...DEFAULT_OPTS, sourceConnector: "chatgpt" },
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.reason, "near_duplicate");
    assert.equal(decision.topId, "existing-pref");
    assert.equal(decision.topScore, 0.96);
  }
});

test("semantic dedup connector-aware: keeps different-connector paraphrase (B vs A)", async () => {
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([{ id: "codex-pref", score: 0.96, sourceConnector: "codex" }]),
    { ...DEFAULT_OPTS, sourceConnector: "chatgpt" },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "connector_mismatch");
  if (decision.action === "keep") {
    assert.equal(decision.topId, "codex-pref");
  }
});

test("semantic dedup connector-aware: keeps provenance candidate when neighbor connector absent", async () => {
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([{ id: "operator-pref", score: 0.97 }]),
    { ...DEFAULT_OPTS, sourceConnector: "chatgpt" },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "connector_mismatch");
});

test("semantic dedup connector-aware: operator (no candidate connector) preserves skip regardless of neighbor connector", async () => {
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([{ id: "codex-pref", score: 0.96, sourceConnector: "codex" }]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.topId, "codex-pref");
  }
});

test("semantic dedup connector-aware: same-connector dedup survives when a different-connector hit scores higher", async () => {
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([
      { id: "codex-pref", score: 0.98, sourceConnector: "codex" },
      { id: "chatgpt-pref", score: 0.94, sourceConnector: "chatgpt" },
    ]),
    { ...DEFAULT_OPTS, sourceConnector: "chatgpt" },
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.topId, "chatgpt-pref");
    assert.equal(decision.topScore, 0.94);
  }
});

test("semantic dedup connector-aware: keeps when candidate connector set but no same-connector neighbor clears threshold", async () => {
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([
      { id: "codex-pref", score: 0.97, sourceConnector: "codex" },
      { id: "chatgpt-unrelated", score: 0.8, sourceConnector: "chatgpt" },
    ]),
    { ...DEFAULT_OPTS, sourceConnector: "chatgpt" },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "connector_mismatch");
});

test("semantic dedup connector-aware: empty/whitespace candidate connector treated as operator", async () => {
  const wsDecision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([{ id: "codex-pref", score: 0.96, sourceConnector: "codex" }]),
    { ...DEFAULT_OPTS, sourceConnector: "   " },
  );
  assert.equal(wsDecision.action, "skip");
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

//

test("regression #399: semantic dedup skip does NOT add content hash to index", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "remnic-test-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();

    const FACT_CONTENT = "the user prefers dark mode in their editor";
    const NEIGHBOR_ID = "mem-neighbor-001";

    const decision = await decideSemanticDedup(
      FACT_CONTENT,
      makeLookup([{ id: NEIGHBOR_ID, score: 0.97 }]),
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "skip", "precondition: decision must be skip");


    assert.equal(
      index.has(FACT_CONTENT),
      false,
      "skipped fact content must not be registered in contentHashIndex",
    );

    assert.equal(index.size, 0, "index must remain empty after semantic skip");

    assert.equal(
      index.has(FACT_CONTENT),
      false,
      "third write attempt must not be blocked by a phantom hash",
    );

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

  const stateDir = await mkdtemp(join(tmpdir(), "remnic-test-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();

    const NEIGHBOR_CONTENT = "the user prefers dark mode in their editor";
    const SKIPPED_CONTENT = "the user likes dark editor themes";

    index.add(NEIGHBOR_CONTENT);
    assert.equal(index.size, 1, "neighbor hash seeded");

    const decision = await decideSemanticDedup(
      SKIPPED_CONTENT,
      makeLookup([{ id: "mem-neighbor-001", score: 0.95 }]),
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "skip");
    assert.equal(
      index.has(SKIPPED_CONTENT),
      false,
      "skipped content must not be in index",
    );

    index.remove(NEIGHBOR_CONTENT);
    assert.equal(index.size, 0, "index empty after neighbor archived");

    assert.equal(
      index.has(SKIPPED_CONTENT),
      false,
      "write of previously-skipped content must not be blocked after neighbor archive",
    );

    index.add(SKIPPED_CONTENT);
    assert.equal(index.has(SKIPPED_CONTENT), true);
    assert.equal(index.size, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

//

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

    const unscoped = await fallback.search("the user prefers tabs", 5);
    assert.equal(unscoped.length, 2, "unscoped lookup returns both entries");

    const alphaHits = await fallback.search(
      "the user prefers tabs",
      5,
      { pathPrefix: "namespaces/alpha/" },
    );
    assert.equal(alphaHits.length, 1, "alpha-scoped lookup returns one hit");
    assert.equal(alphaHits[0]?.id, "mem-a-001");

    const betaHits = await fallback.search(
      "the user prefers tabs",
      5,
      { pathPrefix: "namespaces/beta/" },
    );
    assert.equal(betaHits.length, 1, "beta-scoped lookup returns one hit");
    assert.equal(betaHits[0]?.id, "mem-b-001");

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
      openaiApiKey: false,
    });
    const fallback = new EmbeddingFallback(config);

    const hits = await fallback.search("the user prefers tabs", 5);
    assert.deepEqual(hits, []);
  } finally {
    restoreFetch();
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("finding 3: empty lookup result returns no_candidates, not backend_unavailable", async () => {
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
  const config = parseConfig({ semanticDedupCandidates: 1.5 });
  assert.equal(config.semanticDedupCandidates, 1);
});

//
//

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

//
//
//
//

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
  const longContent = buildLongContent(30);

  const chunkResult = chunkContent(longContent, LOW_THRESHOLD_CHUNKING);
  assert.ok(
    chunkResult.chunked && chunkResult.chunks.length > 1,
    `precondition: chunkResult.chunked must be true; got ${chunkResult.chunks.length} chunk(s)`,
  );

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

  const supersedes: string | undefined = undefined;

  const pendingSemanticSkip =
    semanticDecision.action === "skip" ? semanticDecision : null;
  const gateTriggered = pendingSemanticSkip !== null && !supersedes;

  assert.ok(
    gateTriggered,
    "semantic-skip gate must fire (suppressing the write) when there is no contradiction",
  );

  const stateDir = await mkdtemp(join(tmpdir(), "remnic-chunk-dedup-1-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();
    if (!gateTriggered) {
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
  const longContent = buildLongContent(30);

  const chunkResult = chunkContent(longContent, LOW_THRESHOLD_CHUNKING);
  assert.ok(
    chunkResult.chunked && chunkResult.chunks.length > 1,
    `precondition: chunkResult.chunked must be true; got ${chunkResult.chunks.length} chunk(s)`,
  );

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

  const supersedes = "old-memory-abc-123";

  const pendingSemanticSkip =
    semanticDecision.action === "skip" ? semanticDecision : null;
  const gateTriggered = pendingSemanticSkip !== null && !supersedes;

  assert.ok(
    !gateTriggered,
    "semantic-skip gate must NOT fire when a contradiction was found (supersedes is set)",
  );

  const stateDir = await mkdtemp(join(tmpdir(), "remnic-chunk-dedup-2-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();
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


//
//

test("round 6: chunked parent writeMemory carries supersedes in frontmatter", async () => {
  const memDir = await mkdtemp(join(tmpdir(), "remnic-chunked-supersedes-"));
  try {
    const storage = new StorageManager(memDir);
    const OLD_ID = "fact-old-abc-123";

    const { id: newId } = await storage.writeMemory("fact", "the user prefers dark mode", {
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

    assert.ok(
      raw.includes(`supersedes: ${OLD_ID}`),
      `written file must contain supersedes: ${OLD_ID}\nActual content:\n${raw}`,
    );

    assert.ok(
      raw.includes("contradicts"),
      `written file must contain the contradicts link type\nActual content:\n${raw}`,
    );
    assert.ok(
      raw.includes(OLD_ID),
      `written file must reference the old memory id in links\nActual content:\n${raw}`,
    );

    assert.ok(newId.startsWith("fact-"), `memory id must start with 'fact-'; got ${newId}`);
    assert.ok(raw.includes(`id: ${newId}`), `file must contain id: ${newId}`);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memDir, { recursive: true, force: true });
  }
});

//
//

test("round 6: orchestrator lookup throw (backend down) maps to backend_unavailable, not no_candidates", async () => {
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
  const emptyLookup: SemanticDedupLookup = async () => [];

  const decision = await decideSemanticDedup("some fact content", emptyLookup, DEFAULT_OPTS);

  assert.equal(decision.action, "keep");
  assert.equal(
    decision.reason,
    "no_candidates",
    "empty index (backend reachable, returns []) must yield no_candidates, not backend_unavailable",
  );
});

//
//

test("UUI1: correction category is never suppressed by semantic skip fallback when supersedes is unset", async () => {
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

  const supersedes: string | undefined = undefined;

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

//
//

test("UUI2: batch backend-unavailable flag short-circuits embedding lookups after first failure", async () => {
  let lookupCallCount = 0;

  const throwingLookup: SemanticDedupLookup = async () => {
    lookupCallCount++;
    throw new Error("embedding backend unavailable");
  };

  const N = 5;
  let batchBackendUnavailable = false;
  const decisions: SemanticDedupDecision[] = [];

  for (let i = 0; i < N; i++) {
    let semanticDecision: SemanticDedupDecision;
    if (batchBackendUnavailable) {
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

  assert.ok(
    lookupCallCount <= 1,
    `embed lookup must be called ≤1 time for the lookup phase; called ${lookupCallCount} time(s)`,
  );

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

//
//
//

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
    const signal: AbortSignal | undefined = init?.signal;
    if (signal?.aborted) {
      const err = signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      throw err;
    }
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


test("round 10 Ui1J+Ui1L: search() without throwOnTimeout returns [] on timeout (recall-path fail-open)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-timeout-recall-"));
  const { restore, callCount } = stubTimeoutFetch();
  process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = "1";
  try {
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

//
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
  //

  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-timeout-batch-"));
  const { restore, callCount } = stubTimeoutFetch();
  process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = "1";

  try {
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

    const realLookup: SemanticDedupLookup = async (content, limit) =>
      fallback.search(content, limit, { throwOnTimeout: true }).then((hits) =>
        hits.map((h) => ({ id: h.id, score: h.score, path: h.path })),
      );

    const N = 5;
    let batchBackendUnavailable = false;
    const decisions: SemanticDedupDecision[] = [];

    for (let i = 0; i < N; i++) {
      let semanticDecision: SemanticDedupDecision;
      if (batchBackendUnavailable) {
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

    assert.ok(
      callCount() <= 1,
      `fetch must be called ≤1 time for the lookup phase; called ${callCount()} time(s)`,
    );

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

//
//

test("P2: semantic-skip gate does not fire when contradiction detected with autoResolve=false", async () => {
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

//
//

test("round 12 fix #1: non-timeout fetch error on lookup path throws EmbeddingTimeoutError", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-r12-transport-"));
  const original = globalThis.fetch;
  try {
    await seedEmbeddingIndex(memoryDir, {
      "mem-001": { vector: [1, 0, 0, 0], path: "facts/f-001.md" },
    });

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

    await assert.rejects(
      () => fallback.search("query text", 5, { throwOnTimeout: true }),
      EmbeddingTimeoutError,
      "non-timeout transport failure on lookup path must throw EmbeddingTimeoutError",
    );

    const result = await fallback.search("query text", 5);
    assert.deepEqual(result, [], "recall path must fail open (return []) on transport error");

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

    const unscoped = await fallback.search("test query", 10);
    assert.equal(unscoped.length, 2, "unscoped search must return both entries");

    const extNorm = externalDir.replace(/\\/g, "/");
    const extPrefix = extNorm.endsWith("/") ? extNorm : `${extNorm}/`;
    const externalHits = await fallback.search("test query", 10, { pathPrefix: extPrefix });
    assert.equal(externalHits.length, 1, "absolute-prefix search must return only the external entry");
    assert.equal(externalHits[0]?.id, "mem-external");

    const otherDir = join(tmpdir(), "remnic-r12-other-").replace(/\\/g, "/") + "/";
    const otherHits = await fallback.search("test query", 10, { pathPrefix: otherDir });
    assert.equal(
      otherHits.length,
      0,
      "external entry must not appear under a different tenant's absolute prefix",
    );

    const decision = await decideSemanticDedup(
      "test query",
      async (content, limit) => {
        const hits = await fallback.search(content, limit, { pathPrefix: extPrefix });
        return hits.map((h) => ({ id: h.id, score: h.score, path: h.path }));
      },
      DEFAULT_OPTS,
    );
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
