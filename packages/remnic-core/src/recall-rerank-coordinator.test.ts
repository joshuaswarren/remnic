/**
 * recall-rerank-coordinator.test.ts — issue #1905.
 *
 * Pins the O(candidates) inversion of the Memory-Worth / TrustScore recall
 * stage:
 *   - when the hot path's already-loaded frontmatter covers the candidates,
 *     the stage does ZERO `readAllMemories()` / direct-read calls and its
 *     counters come from that frontmatter;
 *   - the preloaded (candidates) path produces byte-identical ranking to the
 *     old corpus-map path for the same data (golden parity);
 *   - cold-tier candidates absent from the preloaded map fall back to a
 *     bounded-parallel (<=16) direct read whose counters match a reference;
 *   - the corpus-fallback cache is invalidated by the shared corpus version,
 *     not a wall-clock TTL (no stale counters after a mutation);
 *   - with both feature flags off the stage touches storage zero times.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { resolveCapabilities } from "./capabilities.js";
import { RecallRerankCoordinator } from "./orchestration/recall-rerank-coordinator.js";
import { Orchestrator } from "./orchestrator.js";
import type { PluginConfig, QmdSearchResult, MemoryFile } from "./types.js";
import type { StorageManager } from "./index.js";

async function baseConfig(overrides: Partial<PluginConfig> = {}): Promise<PluginConfig> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-1905-"));
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    recallMemoryWorthFilterEnabled: true,
    trustScoreEnabled: false,
    ...overrides,
  });
}

function result(id: string, score: number): QmdSearchResult {
  return { docid: id, path: `/facts/${id}.md`, snippet: id, score };
}

// Only mw_* / lastAccessed are read by the counter builder; the fixture stays
// narrow. The frontmatter cast is a deliberate test double for a value inference
// cannot unify with the full MemoryFrontmatter shape.
function mem(id: string, mw_success?: number, mw_fail?: number): MemoryFile {
  const frontmatter = { mw_success, mw_fail } as unknown as MemoryFile["frontmatter"];
  return { path: `/facts/${id}.md`, frontmatter, content: id };
}

interface FakeStorageState {
  memories: MemoryFile[];
  version: number;
}

/** Fake storage that counts corpus scans and reads its set from mutable state. */
function makeFakes(initial: MemoryFile[], version = 1) {
  const calls = { readAll: 0, corpusVersion: 0 };
  const state: FakeStorageState = { memories: initial, version };
  // Test double: only readAllMemories/getMemoryCorpusVersion are exercised.
  const storage = {
    readAllMemories: async () => {
      calls.readAll += 1;
      return state.memories;
    },
    getMemoryCorpusVersion: () => {
      calls.corpusVersion += 1;
      return state.version;
    },
  } as unknown as StorageManager;
  return { calls, state, storage, getStorage: async () => storage };
}

test("O(candidates): preloaded frontmatter covers candidates → no corpus scan, no direct read (#1905)", async () => {
  const config = await baseConfig();
  const corpus = makeFakes([]);
  let directReads = 0;
  const coord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => {
      directReads += 1;
      return null;
    },
  });

  // Input order [bad, good]; only Memory-Worth counters differ. good must
  // overtake bad purely from its preloaded counters.
  const results = [result("bad", 2), result("good", 1)];
  const preloaded = new Map<string, MemoryFile>([
    ["/facts/bad.md", mem("bad", 0, 10)],
    ["/facts/good.md", mem("good", 10, 0)],
  ]);

  const reordered = await coord.applyMemoryWorthRerank(results, ["default"], preloaded);

  assert.equal(corpus.calls.readAll, 0, "readAllMemories must NOT be called on the warm path");
  assert.equal(directReads, 0, "no per-candidate direct read when preloaded covers all candidates");
  assert.deepEqual(
    reordered.map((r) => r.path),
    ["/facts/good.md", "/facts/bad.md"],
    "high-worth candidate overtakes low-worth using preloaded counters",
  );
});

test("preloaded-but-neutral candidates do not trigger the corpus scan or direct read (#1905, Codex)", async () => {
  const config = await baseConfig();
  const corpus = makeFakes([]);
  let directReads = 0;
  const coord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => {
      directReads += 1;
      return null;
    },
  });

  // Both candidates are preloaded but carry NO mw counters — the typical
  // uninstrumented hot-QMD result. They are neutral priors: the stage must
  // treat them as EXAMINED, not "missing", so neither the corpus fallback nor
  // the direct-read fallback fires. Before this guard, every neutral candidate
  // re-triggered readAllMemories() after each corpus-version bump, defeating
  // the O(candidates) fast path.
  const results = [result("a", 2), result("b", 1)];
  const preloaded = new Map<string, MemoryFile>([
    ["/facts/a.md", mem("a")],
    ["/facts/b.md", mem("b")],
  ]);

  const out = await coord.applyMemoryWorthRerank(results, ["default"], preloaded);

  assert.equal(corpus.calls.readAll, 0, "neutral preloaded candidates must not trigger readAllMemories");
  assert.equal(directReads, 0, "neutral preloaded candidates must not trigger direct reads");
  assert.deepEqual(
    out.map((r) => r.path),
    ["/facts/a.md", "/facts/b.md"],
    "order unchanged for neutral candidates (neutral prior does not rerank)",
  );
});

test("golden parity: preloaded path ranks identically to the corpus-scan path (#1905)", async () => {
  const config = await baseConfig();
  const results = [result("bad", 3), result("mid", 2), result("good", 1)];
  const memories = [mem("bad", 0, 8), mem("mid", 2, 2), mem("good", 12, 0)];

  // Corpus path: no preloaded map, storage.readAllMemories supplies counters.
  const corpus = makeFakes(memories);
  const corpusCoord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });
  const viaCorpus = await corpusCoord.applyMemoryWorthRerank(results, ["default"]);
  assert.equal(corpus.calls.readAll, 1, "corpus path performs exactly one scan");

  // Preloaded path: same counters supplied inline.
  const preloaded = new Map<string, MemoryFile>(memories.map((m) => [m.path, m]));
  const warm = makeFakes([]);
  const warmCoord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: warm.getStorage,
    readQmdResultMemory: async () => null,
  });
  const viaPreloaded = await warmCoord.applyMemoryWorthRerank(results, ["default"], preloaded);

  assert.equal(warm.calls.readAll, 0, "preloaded path performs zero scans");
  assert.deepEqual(
    viaPreloaded.map((r) => r.path),
    viaCorpus.map((r) => r.path),
    "preloaded and corpus paths produce identical ordering for identical data",
  );
});

test("cold-tier miss → bounded-parallel direct read (<=16 concurrent), counters match (#1905)", async () => {
  const config = await baseConfig();
  const corpus = makeFakes([]); // corpus scan yields nothing → every candidate misses
  let inFlight = 0;
  let maxInFlight = 0;
  const byPath = new Map<string, MemoryFile>();
  const N = 40;
  const results: QmdSearchResult[] = [];
  for (let i = 0; i < N; i += 1) {
    const id = `cold${i}`;
    results.push(result(id, N - i));
    // Alternate success/fail so ordering depends on the direct-read counters.
    byPath.set(`/facts/${id}.md`, mem(id, i % 2 === 0 ? 9 : 0, i % 2 === 0 ? 0 : 9));
  }

  const coord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async (p) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Microtask yield (no wall clock): lets every callback in the current
      // Promise.all batch reach this point before any resolves, so maxInFlight
      // observes the true batch width deterministically.
      await Promise.resolve();
      inFlight -= 1;
      return byPath.get(p) ?? null;
    },
  });

  const reordered = await coord.applyMemoryWorthRerank(results, ["default"]);
  assert.ok(maxInFlight > 1, "direct reads run in parallel");
  assert.ok(maxInFlight <= 16, `direct-read concurrency must stay <=16 (saw ${maxInFlight})`);
  // Every even-index (high mw_success) candidate must outrank its odd-index
  // (high mw_fail) neighbor → the counters from the direct read were applied.
  const rank = new Map(reordered.map((r, i) => [r.path, i]));
  for (let i = 0; i + 1 < N; i += 2) {
    assert.ok(
      rank.get(`/facts/cold${i}.md`)! < rank.get(`/facts/cold${i + 1}.md`)!,
      `high-worth cold${i} outranks low-worth cold${i + 1}`,
    );
  }
});

test("version-keyed cache: a corpus-version bump invalidates the cached counter map (#1905)", async () => {
  const config = await baseConfig();
  const results = [result("a", 2), result("b", 1)];
  // Stage 1: b is low-worth (mw_fail) so a stays ahead.
  const corpus = makeFakes([mem("a", 5, 0), mem("b", 0, 5)], 1);
  const coord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });

  const first = await coord.applyMemoryWorthRerank(results, ["default"]);
  assert.equal(corpus.calls.readAll, 1, "first recall scans");

  // Second recall, SAME version → served from cache (no new scan).
  await coord.applyMemoryWorthRerank(results, ["default"]);
  assert.equal(corpus.calls.readAll, 1, "same version → cache hit, no rescan");

  // Mutate the corpus (b becomes high-worth) and bump the version.
  corpus.state.memories = [mem("a", 0, 5), mem("b", 5, 0)];
  corpus.state.version += 1;
  const third = await coord.applyMemoryWorthRerank(results, ["default"]);
  assert.equal(corpus.calls.readAll, 2, "version bump forces a rescan (no stale counters)");

  // Ordering must reflect the NEW counters: b now outranks a.
  assert.deepEqual(first.map((r) => r.path), ["/facts/a.md", "/facts/b.md"]);
  assert.deepEqual(third.map((r) => r.path), ["/facts/b.md", "/facts/a.md"]);
});

test("zero-semantics: both flags off → stage returns inputs unchanged with zero storage reads (#1905)", async () => {
  const config = await baseConfig({
    recallMemoryWorthFilterEnabled: false,
    trustScoreEnabled: false,
  });
  const caps = resolveCapabilities(config);
  assert.equal(caps.recallMemoryWorthFilter, false);
  assert.equal(caps.recallTrustScore, false);

  const corpus = makeFakes([mem("x", 9, 0)]);
  let directReads = 0;
  let getStorageCalls = 0;
  const coord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: async () => {
      getStorageCalls += 1;
      return corpus.storage;
    },
    readQmdResultMemory: async () => {
      directReads += 1;
      return null;
    },
  });

  const results = [result("x", 1), result("y", 2)];
  const outcome = await coord.applyTrustScoreToBranch(results, ["default"], caps, "test");

  assert.deepEqual(outcome.results, results, "results are returned unchanged");
  assert.equal(outcome.trustByPath, null);
  assert.equal(corpus.calls.readAll, 0, "no corpus scan when disabled");
  assert.equal(getStorageCalls, 0, "getStorage never called when disabled");
  assert.equal(directReads, 0, "no direct reads when disabled");
});

test("post-MMR partition exposes ordered headroom without changing admitted results", () => {
  const config = parseConfig({
    recallMmrEnabled: true,
    recallMmrLambda: 0.3,
    recallMmrTopN: 40,
  });
  const corpus = makeFakes([]);
  const coordinator = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });
  const candidates: QmdSearchResult[] = [
    { docid: "a1", path: "p/a1", snippet: "alpha fact one", score: 0.99 },
    { docid: "a2", path: "p/a2", snippet: "alpha fact two", score: 0.98 },
    { docid: "a3", path: "p/a3", snippet: "alpha fact three", score: 0.97 },
    { docid: "a4", path: "p/a4", snippet: "alpha fact four", score: 0.96 },
    { docid: "a5", path: "p/a5", snippet: "alpha fact five", score: 0.95 },
    {
      docid: "d1",
      path: "p/d1",
      snippet: "orthogonal concept rocket fuel chemistry",
      score: 0.94,
    },
  ];

  const partition = coordinator.diversifyRecallResultsWithHeadroom(
    "memories",
    candidates,
    2,
    "alpha rocket chemistry",
  );
  const admitted = coordinator.diversifyAndLimitRecallResults(
    "memories",
    candidates,
    2,
    "alpha rocket chemistry",
  );

  assert.deepEqual(
    partition.appliedResults.map((candidate) => candidate.docid),
    ["a1", "d1"],
    "the applied partition is the same post-MMR top slice",
  );
  assert.deepEqual(
    partition.headroomResults.map((candidate) => candidate.docid),
    ["a2", "a3", "a4", "a5"],
    "headroom preserves the post-MMR order immediately beyond the applied cap",
  );
  assert.deepEqual(
    partition.appliedResults,
    admitted,
    "headroom capture does not change admitted results",
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.docid),
    ["a1", "a2", "a3", "a4", "a5", "d1"],
    "partitioning does not mutate the fetched candidate pool",
  );
});

/**
 * Write a fact into the default-namespace storage dir (mirrors the
 * trust-score-recall-paths helper) so recall's recent-memory-scan branch has
 * candidates to rank.
 */
async function writeFact(memoryDir: string, body: string, extra: string[] = []): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    ...extra,
    "---",
  ];
  const factsDir = path.join(memoryDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  await writeFile(path.join(factsDir, `${id}.md`), `${lines.join("\n")}\n\n${body}\n`, "utf-8");
}

test("deadline-bound: a trust stage exceeding the assembly budget returns the pass-through fallback (#1905)", async () => {
  // Integration test of the awaitAssemblyStep wrap: this deliberately exercises
  // the real wall-clock enrichment-assembly deadline (deterministic time
  // control is not available through the public recall API). A modest 400ms
  // budget is far above the 2-file recent-scan yet the injected trust stage
  // never resolves, so the deadline must fire and the recall must fall back to
  // the unfiltered results without hanging or throwing.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-1905-deadline-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    multiGraphMemoryEnabled: false,
    entityGraphEnabled: false,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    inlineSourceAttributionEnabled: false,
    trustScoreEnabled: true,
    initGateTimeoutMs: 200,
    recallEnrichmentDeadlineMs: 2000,
  });
  const orchestrator = new Orchestrator(config);
  try {
    await writeFact(memoryDir, "Recallable fact: production DB uses pgBouncer.", [
      "mw_success: 5",
      "mw_fail: 0",
    ]);
    await writeFact(memoryDir, "Recallable fact: cache TTL is 60 seconds.", [
      "mw_success: 3",
      "mw_fail: 0",
    ]);

    // Inject a trust stage that NEVER resolves on the recent-scan branch (the
    // branch that actually produces candidates here). Other branches (e.g. the
    // disabled embedding fallback) run the real stage so control reaches
    // recent-scan normally. The deadline wrap must win the race and substitute
    // the pass-through fallback rather than await this forever — if the
    // bare-await regression returned, recall would hang on this promise.
    const stuck = Promise.withResolvers<{
      results: QmdSearchResult[];
      trustByPath: null;
    }>();
    const realStage = orchestrator.recallRerankCoordinator.applyTrustScoreToBranch.bind(
      orchestrator.recallRerankCoordinator,
    );
    let recentScanStalled = false;
    orchestrator.recallRerankCoordinator.applyTrustScoreToBranch = async (
      results,
      namespaces,
      caps,
      label,
      preloadedFrontmatter,
    ) => {
      if (label === "recent-scan") {
        recentScanStalled = true;
        return stuck.promise;
      }
      return realStage(results, namespaces, caps, label, preloadedFrontmatter);
    };

    const start = Date.now();
    const recall = await orchestrator.recall("database connection pooling", "sess-1905-deadline", {
      xrayCapture: true,
    });
    const elapsed = Date.now() - start;

    assert.equal(typeof recall, "string", "recall resolves to a string (does not hang) despite the never-resolving trust stage");
    assert.ok(recentScanStalled, "the never-resolving trust stage ran on the recent-scan branch");
    // The stage never produced output, so the recalled memories can ONLY come
    // from the deadline fallback (the pre-trust recent-scan results).
    const snapshot = orchestrator.getLastXraySnapshot();
    assert.ok(snapshot, "X-ray snapshot captured");
    assert.ok(
      (snapshot!.results ?? []).length > 0,
      "unfiltered recent-scan results survive as the deadline fallback",
    );
    // Bounded by the deadline (with generous slack for a loaded CI machine),
    // proving the recall did not wait on the never-resolving stage.
    assert.ok(elapsed < 30_000, `recall completed within a bounded window (took ${elapsed}ms)`);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#1907: assembly deadline aborts the losing task's injected signal but not the request signal", async () => {
  // awaitAssemblyStep now injects a per-step AbortSignal into the task so the
  // losing task cooperatively stops instead of running to completion after the
  // Promise.race is lost. A task-level deadline must abort ONLY that injected
  // step signal — never the request-level signal, which alone is allowed to
  // reject the whole recall (#1907, fail-open guardrail).
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-1907-assembly-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    multiGraphMemoryEnabled: false,
    entityGraphEnabled: false,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    inlineSourceAttributionEnabled: false,
    trustScoreEnabled: true,
    initGateTimeoutMs: 200,
    recallEnrichmentDeadlineMs: 2000,
  });
  const orchestrator = new Orchestrator(config);
  try {
    await writeFact(memoryDir, "Recallable fact: production DB uses pgBouncer.", [
      "mw_success: 5",
      "mw_fail: 0",
    ]);

    const stuck = Promise.withResolvers<{
      results: QmdSearchResult[];
      trustByPath: null;
    }>();
    let capturedStepSignal: AbortSignal | undefined;
    const realStage = orchestrator.recallRerankCoordinator.applyTrustScoreToBranch.bind(
      orchestrator.recallRerankCoordinator,
    );
    orchestrator.recallRerankCoordinator.applyTrustScoreToBranch = async (
      results,
      namespaces,
      caps,
      label,
      preloadedFrontmatter,
      abortSignal,
    ) => {
      if (label === "recent-scan") {
        capturedStepSignal = abortSignal;
        return stuck.promise; // never resolves — force the deadline to win
      }
      return realStage(results, namespaces, caps, label, preloadedFrontmatter, abortSignal);
    };

    const requestController = new AbortController();
    const recall = await orchestrator.recall(
      "database connection pooling",
      "sess-1907-assembly",
      { xrayCapture: true, abortSignal: requestController.signal },
    );

    assert.equal(typeof recall, "string", "recall resolves despite the never-resolving stage");
    assert.ok(capturedStepSignal, "the trust stage received an injected step signal");
    assert.equal(
      capturedStepSignal!.aborted,
      true,
      "the injected step signal is aborted when the assembly deadline wins",
    );
    assert.equal(
      requestController.signal.aborted,
      false,
      "a task-level deadline must NOT abort the request-level signal",
    );
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("trust rerank preserves duplicate paths owned by different namespaces (#2020)", async () => {
  const config = await baseConfig({
    recallMemoryWorthFilterEnabled: false,
    trustScoreEnabled: true,
  });
  const corpus = makeFakes([mem("same", 5, 0)]);
  const coord = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });
  const results: QmdSearchResult[] = [
    { ...result("same", 2), namespace: "private" },
    { ...result("same", 1), namespace: "shared" },
  ];

  const outcome = await coord.applyTrustScoreRerank(results, ["private", "shared"]);

  assert.deepEqual(
    outcome.results.map((r) => r.namespace),
    ["private", "shared"],
    "same paths in separate namespaces must retain their result identity",
  );
  assert.equal(outcome.trustByPath?.size, 2, "trust metadata must have one entry per namespaced result");
});

test("#2859 state-view cap: pairs reconcile before cap/MMR and count as one evidence packet", () => {
  // MMR off so the ordered pool equals the input order — the packet
  // semantics under test are then fully deterministic.
  const config = parseConfig({ recallMmrEnabled: false });
  const corpus = makeFakes([]);
  const coordinator = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });
  const sv = (
    id: string,
    score: number,
    chain: Partial<QmdSearchResult> = {},
  ): QmdSearchResult => ({ ...result(id, score), id, status: "active", ...chain });
  const rows: QmdSearchResult[] = [
    sv("p1", 0.95, { status: "superseded", supersededBy: "s1" }),
    sv("orphan", 0.9, { status: "superseded", supersededBy: "absent" }),
    sv("s1", 0.85),
    sv("f1", 0.8),
    sv("f2", 0.75),
  ];
  const caps = resolveCapabilities(config);

  // Packet view: [p1+s1], [f1], [f2] — the orphan is reconciled away
  // BEFORE the cap, and the admitted pair consumes a single slot.
  const partition = coordinator.diversifyRecallResultsWithHeadroom(
    "memories",
    rows,
    2,
    undefined,
    caps,
    true,
  );
  assert.deepEqual(
    partition.appliedResults.map((r) => r.id),
    ["p1", "s1", "f1"],
    "a complete pair is one packet: pred+succ plus one filler for limit 2",
  );
  assert.deepEqual(
    partition.headroomResults.map((r) => r.id),
    ["f2"],
    "headroom is the remainder of the reconciled pool",
  );

  // The slice never splits a packet at the boundary: even with the
  // successor ranked LAST, the pair is admitted together.
  const splitRisk: QmdSearchResult[] = [
    sv("p1", 0.95, { status: "superseded", supersededBy: "s1" }),
    sv("f1", 0.9),
    sv("f2", 0.85),
    sv("s1", 0.8),
  ];
  const applied = coordinator.diversifyAndLimitRecallResults(
    "memories",
    splitRisk,
    2,
    undefined,
    caps,
    true,
  );
  assert.deepEqual(
    applied.map((r) => r.id),
    ["p1", "f1", "s1"],
    "no underfill: the boundary keeps the evidence packet complete",
  );

  // Flag absent → the legacy row slice, byte-identical (zero-diff default).
  const legacy = coordinator.diversifyAndLimitRecallResults(
    "memories",
    rows,
    2,
    undefined,
    caps,
  );
  assert.deepEqual(
    legacy.map((r) => r.id),
    ["p1", "orphan"],
    "without the state view the cap stays the plain top-N row slice",
  );
});

test("#2859 packet cap after filter: a quarantined successor does not consume budget", () => {
  const config = parseConfig({ recallMmrEnabled: false });
  const corpus = makeFakes([]);
  const coordinator = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });
  const sv = (
    id: string,
    score: number,
    chain: Partial<QmdSearchResult> = {},
  ): QmdSearchResult => ({ ...result(id, score), id, status: "active", ...chain });
  // Trust already removed s1. Cap-after-filter must drop the orphaned
  // predecessor and promote the next live packet instead of returning empty.
  const afterTrust: QmdSearchResult[] = [
    sv("p1", 0.95, { status: "superseded", supersededBy: "s1" }),
    sv("f1", 0.8),
    sv("f2", 0.75),
  ];
  const partition = coordinator.diversifyRecallResultsWithHeadroom(
    "memories",
    afterTrust,
    1,
    undefined,
    resolveCapabilities(config),
    true,
  );
  assert.deepEqual(
    partition.appliedResults.map((row) => row.id),
    ["f1"],
    "disallowed pair must not occupy the only packet slot",
  );
  assert.deepEqual(
    partition.headroomResults.map((row) => row.id),
    ["f2"],
  );
});

test("#2859 linkless superseded status does not consume a packet slot", () => {
  const config = parseConfig({ recallMmrEnabled: false });
  const corpus = makeFakes([]);
  const coordinator = new RecallRerankCoordinator({
    getConfig: () => config,
    getStorage: corpus.getStorage,
    readQmdResultMemory: async () => null,
  });
  const sv = (
    id: string,
    score: number,
    chain: Partial<QmdSearchResult> = {},
  ): QmdSearchResult => ({ ...result(id, score), id, status: "active", ...chain });
  const rows: QmdSearchResult[] = [
    sv("legacy", 0.99, { status: "superseded" }),
    sv("live", 0.5),
  ];
  const applied = coordinator.diversifyAndLimitRecallResults(
    "memories",
    rows,
    1,
    undefined,
    resolveCapabilities(config),
    true,
  );
  assert.deepEqual(
    applied.map((row) => row.id),
    ["live"],
    "status-only superseded rows are rejected before the packet cap",
  );
});
