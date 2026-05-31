import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { PluginConfig } from "../src/types.js";
import { NamespaceSearchRouter, namespaceCollectionName } from "../src/namespaces/search.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions } from "../src/search/port.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseConfig(memoryDir: string): PluginConfig {
  return {
    openaiApiKey: undefined,
    openaiBaseUrl: undefined,
    model: "gpt-5.5",
    reasoningEffort: "low",
    triggerMode: "smart",
    bufferMaxTurns: 5,
    bufferMaxMinutes: 15,
    consolidateEveryN: 3,
    highSignalPatterns: [],
    maxMemoryTokens: 2000,
    qmdEnabled: true,
    qmdCollection: "openclaw-engram",
    qmdMaxResults: 8,
    qmdTierMigrationEnabled: false,
    qmdTierDemotionMinAgeDays: 30,
    qmdTierDemotionValueThreshold: 0.2,
    qmdTierPromotionValueThreshold: 0.8,
    qmdTierParityGraphEnabled: false,
    qmdTierParityHiMemEnabled: false,
    qmdTierAutoBackfillEnabled: false,
    embeddingFallbackEnabled: false,
    embeddingFallbackProvider: "auto",
    memoryDir,
    debug: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    identityInjectionMode: "recovery_only",
    identityMaxInjectChars: 1200,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
    recordEmptyRecallImpressions: false,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 4,
    queryExpansionMinTokenLen: 3,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 10,
    rerankTimeoutMs: 1000,
    rerankCacheEnabled: true,
    rerankCacheTtlMs: 1000,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0.05,
    negativeExamplesPenaltyCap: 0.25,
    chunkingEnabled: false,
    chunkingTargetTokens: 200,
    chunkingMinTokens: 150,
    chunkingOverlapSentences: 2,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.9,
    contradictionAutoResolve: true,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 30,
    summarizationEnabled: false,
    summarizationTriggerCount: 1000,
    summarizationRecentToKeep: 300,
    summarizationImportanceThreshold: 0.3,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 50,
    transcriptEnabled: false,
    transcriptRetentionDays: 7,
    transcriptSkipChannelTypes: ["cron"],
    transcriptRecallHours: 12,
    maxTranscriptTurns: 50,
    maxTranscriptTokens: 1000,
    checkpointEnabled: false,
    checkpointTurns: 15,
    compactionResetEnabled: false,
    hourlySummariesEnabled: false,
    hourlySummaryCronAutoRegister: false,
    summaryRecallHours: 24,
    maxSummaryCount: 6,
    summaryModel: "gpt-5.5",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 60,
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
    conversationIndexQmdCollection: "openclaw-engram-convo",
    conversationIndexRetentionDays: 14,
    conversationIndexMinUpdateIntervalMs: 60_000,
    conversationIndexEmbedOnUpdate: false,
    conversationIndexFaissModelId: "text-embedding-3-small",
    conversationIndexFaissIndexDir: path.join(memoryDir, "state", "conversation-faiss"),
    conversationIndexFaissUpsertTimeoutMs: 30_000,
    conversationIndexFaissSearchTimeoutMs: 5_000,
    conversationIndexFaissHealthTimeoutMs: 5_000,
    conversationIndexFaissMaxBatchSize: 64,
    conversationIndexFaissMaxSearchK: 20,
    conversationRecallTopK: 3,
    conversationRecallMaxChars: 2000,
    conversationRecallTimeoutMs: 500,
    evalHarnessEnabled: false,
    evalShadowModeEnabled: false,
    benchmarkBaselineSnapshotsEnabled: false,
    benchmarkDeltaReporterEnabled: false,
    benchmarkStoredBaselineEnabled: false,
    recallPlannerEnabled: true,
    recallPlannerModel: "gpt-5.5",
    recallPlannerTimeoutMs: 1500,
    recallPlannerUseResponsesApi: true,
    recallPlannerMaxPromptChars: 4000,
    recallPlannerMaxMemoryHints: 24,
    recallPlannerShadowMode: false,
    recallPlannerTelemetryEnabled: true,
    recallPlannerMaxQmdResultsMinimal: 2,
    recallPlannerMaxQmdResultsFull: 8,
    queryAwareIndexingEnabled: false,
    temporalIndexWindowDays: 30,
    temporalIndexMaxEntries: 5000,
    temporalBoostRecentDays: 7,
    temporalBoostScore: 0.15,
    temporalDecayEnabled: true,
    tagMemoryEnabled: false,
    tagMaxPerMemory: 5,
    tagIndexMaxEntries: 10000,
    tagRecallBoost: 0.15,
    tagRecallMaxMatches: 10,
    qmdDaemonEnabled: false,
    qmdDaemonUrl: undefined,
    qmdDaemonRecheckIntervalMs: 30_000,
    qmdIntentHintsEnabled: false,
    qmdExplainEnabled: false,
    qmdUpdateTimeoutMs: 120_000,
    qmdUpdateMinIntervalMs: 60_000,
    factDeduplicationEnabled: false,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    namespacePolicies: [{ name: "team-alpha", readPrincipals: ["default"], writePrincipals: ["default"] }],
    defaultRecallNamespaces: ["self", "shared"],
    cronRecallMode: "all",
    cronRecallAllowlist: [],
    autoPromoteToSharedEnabled: false,
    autoPromoteToSharedCategories: ["correction"],
    autoPromoteMinConfidenceTier: "explicit",
    sharedContextEnabled: false,
    sharedContextDir: undefined,
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: false,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: false,
    creationMemoryEnabled: false,
    workProductRecallEnabled: false,
    workProductLedgerDir: path.join(memoryDir, "work-products"),
    workTasksEnabled: false,
    workProjectsEnabled: false,
    workTasksDir: path.join(memoryDir, "work", "tasks"),
    workProjectsDir: path.join(memoryDir, "work", "projects"),
    workIndexEnabled: false,
    workIndexDir: path.join(memoryDir, "work", "index"),
    workTaskIndexEnabled: false,
    workProjectIndexEnabled: false,
    workIndexAutoRebuildEnabled: false,
    workIndexAutoRebuildDebounceMs: 1000,
    graphRecallEnabled: false,
    graphRecallMaxExpansions: 0,
    graphRecallMaxPerSeed: 0,
    graphRecallMinEdgeWeight: 0,
    graphRecallShadowEnabled: false,
    graphRecallSnapshotEnabled: false,
    graphRecallShadowSampleRate: 0,
    graphRecallExplainToolEnabled: false,
    graphRecallStoreColdMirror: false,
    graphRecallColdMirrorCollection: undefined,
    graphRecallColdMirrorMinAgeDays: 0,
    graphRecallUseEntityPriors: false,
    graphRecallEntityPriorBoost: 0,
    graphRecallPreferHubSeeds: false,
    graphRecallHubBias: 0,
    graphRecallRecencyHalfLifeDays: 30,
    graphRecallDampingFactor: 0.85,
    graphRecallMaxSeedNodes: 0,
    graphRecallMaxExpandedNodes: 0,
    graphRecallMaxTrailPerNode: 0,
    graphRecallMinSeedScore: 0,
    graphRecallExpansionScoreThreshold: 0,
    graphRecallExplainMaxPaths: 0,
    graphRecallExplainMaxChars: 0,
    graphRecallExplainEdgeLimit: 0,
    graphRecallExplainEnabled: false,
    graphRecallEntityHintsEnabled: false,
    graphRecallEntityHintMax: 0,
    graphRecallEntityHintMaxChars: 0,
    graphRecallSnapshotDir: path.join(memoryDir, "state", "graph"),
    graphRecallEnableTrace: false,
    graphRecallEnableDebug: false,
    searchBackend: "qmd",
    remoteSearchBaseUrl: undefined,
    remoteSearchApiKey: undefined,
    remoteSearchTimeoutMs: 5000,
    lancedbEnabled: false,
    lanceDbPath: path.join(memoryDir, "state", "lancedb"),
    lanceEmbeddingDimension: 1536,
    meilisearchEnabled: false,
    meilisearchHost: undefined,
    meilisearchApiKey: undefined,
    meilisearchTimeoutMs: 5000,
    meilisearchAutoIndex: false,
    oramaEnabled: false,
    oramaDbPath: path.join(memoryDir, "state", "orama"),
    oramaEmbeddingDimension: 1536,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
  } as PluginConfig;
}

type FakeSearchBackend = SearchBackend & {
  calls: string[];
  lastSearchOptions?: SearchQueryOptions;
  lastUpdateExecution?: SearchExecutionOptions;
};

function backendForResultSet(resultSet: Array<{ docid: string; path: string; score: number; snippet: string }>): FakeSearchBackend {
  const calls: string[] = [];
  const backend: FakeSearchBackend = {
    calls,
    isAvailable: () => true,
    debugStatus: () => "ok",
    isDaemonMode: () => false,
    probe: async () => true,
    search: async (_query, _collection, _maxResults, options) => {
      calls.push("search");
      backend.lastSearchOptions = options;
      return resultSet;
    },
    searchGlobal: async () => [],
    bm25Search: async () => {
      calls.push("bm25");
      return resultSet;
    },
    vectorSearch: async () => {
      calls.push("vector");
      return resultSet;
    },
    hybridSearch: async () => {
      calls.push("hybrid");
      return resultSet;
    },
    update: async (execution) => {
      calls.push("update");
      backend.lastUpdateExecution = execution;
    },
    updateCollection: async () => {
      calls.push("updateCollection");
    },
    embed: async () => {
      calls.push("embed");
    },
    embedCollection: async () => {
      calls.push("embedCollection");
    },
    ensureCollection: async () => "present",
  };
  return backend;
}

test("namespaceCollectionName keeps legacy default collection and derives namespaced collections", () => {
  assert.equal(
    namespaceCollectionName("openclaw-engram", "default", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: true,
    }),
    "openclaw-engram",
  );

  assert.equal(
    namespaceCollectionName("openclaw-engram", "shared", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: true,
    }),
    "openclaw-engram--ns-736861726564",
  );

  assert.equal(
    namespaceCollectionName("openclaw-engram", "default", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: false,
    }),
    "openclaw-engram--ns-64656661756c74",
  );
});

test("NamespaceSearchRouter scopes backends by namespace root and keeps namespace-scoped results", async () => {
  const memoryDir = tmpDir("engram-ns-search");
  const cfg = baseConfig(memoryDir);
  const seenConfigs: Array<{ memoryDir: string; collection: string }> = [];
  const backends = new Map<string, FakeSearchBackend>();
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir:
          namespace === "default"
            ? memoryDir
            : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => {
      seenConfigs.push({
        memoryDir: backendCfg.memoryDir,
        collection: backendCfg.qmdCollection,
      });
      const backend =
        backendCfg.qmdCollection === "openclaw-engram--ns-736861726564"
          ? backendForResultSet([
              { docid: "shared-1", path: "/tmp/shared.md", score: 0.8, snippet: "shared" },
              { docid: "dup", path: "/tmp/dup.md", score: 0.6, snippet: "shared dup" },
            ])
          : backendForResultSet([
              { docid: "default-1", path: "/tmp/default.md", score: 0.9, snippet: "default" },
              { docid: "dup", path: "/tmp/dup.md", score: 0.7, snippet: "default dup" },
            ]);
      backends.set(backendCfg.qmdCollection, backend);
      return backend;
    },
  );

  const results = await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default", "shared"],
    maxResults: 5,
    mode: "search",
  });

  assert.deepEqual(
    seenConfigs,
    [
      { memoryDir, collection: "openclaw-engram" },
      { memoryDir: path.join(memoryDir, "namespaces", "shared"), collection: "openclaw-engram--ns-736861726564" },
    ],
  );
  assert.deepEqual(
    results.map((result) => [result.path, result.score, result.snippet]),
    [
      ["/tmp/default.md", 0.9, "default"],
      ["/tmp/shared.md", 0.8, "shared"],
      ["/tmp/dup.md", 0.7, "default dup"],
      ["/tmp/dup.md", 0.6, "shared dup"],
    ],
  );
});

test("NamespaceSearchRouter derives a namespaced collection for migrated default roots", async () => {
  const memoryDir = tmpDir("engram-ns-search-default");
  const cfg = baseConfig(memoryDir);
  let seenCollection = "";
  const storageRouter = {
    async storageFor() {
      return {
        dir: path.join(memoryDir, "namespaces", "default"),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => {
      seenCollection = backendCfg.qmdCollection;
      return backendForResultSet([]);
    },
  );

  await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default"],
    maxResults: 3,
    mode: "hybrid",
  });

  assert.equal(seenCollection, "openclaw-engram--ns-64656661756c74");
});

test("NamespaceSearchRouter forwards search options to backend search mode", async () => {
  const memoryDir = tmpDir("engram-ns-search-options");
  const cfg = baseConfig(memoryDir);
  const backend = backendForResultSet([
    { docid: "default-1", path: "/tmp/default.md", score: 0.9, snippet: "default" },
  ]);
  const router = new NamespaceSearchRouter(
    cfg,
    {
      async storageFor() {
        return { dir: memoryDir };
      },
    } as any,
    () => backend,
  );

  await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default"],
    maxResults: 3,
    mode: "search",
    searchOptions: { intent: "goal:review action:review", explain: true },
  });

  assert.deepEqual(backend.lastSearchOptions, {
    intent: "goal:review action:review",
    explain: true,
  });
});

test("NamespaceSearchRouter skips namespaces whose collection is missing", async () => {
  const memoryDir = tmpDir("engram-ns-search-missing");
  const cfg = baseConfig(memoryDir);
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir:
          namespace === "default"
            ? memoryDir
            : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => ({
      ...backendForResultSet([
        {
          docid: `${backendCfg.qmdCollection}-1`,
          path: `/tmp/${backendCfg.qmdCollection}.md`,
          score: 0.8,
          snippet: backendCfg.qmdCollection,
        },
      ]),
      ensureCollection: async () =>
        backendCfg.qmdCollection === "openclaw-engram--ns-736861726564" ? "missing" : "present",
    }),
  );

  const results = await router.searchAcrossNamespaces({
    query: "memory",
    namespaces: ["default", "shared"],
    maxResults: 5,
  });

  assert.equal(results.length, 1);
  assert.match(results[0]?.path ?? "", /openclaw-engram\.md$/);
});

test("NamespaceSearchRouter runs maintenance only for present namespace collections", async () => {
  const memoryDir = tmpDir("engram-ns-search-maintenance");
  const cfg = baseConfig(memoryDir);
  const backends = new Map<string, FakeSearchBackend>();
  const storageRouter = {
    async storageFor(namespace: string) {
      return {
        dir:
          namespace === "default"
            ? memoryDir
            : path.join(memoryDir, "namespaces", namespace),
      };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    (backendCfg) => {
      const backend: FakeSearchBackend = {
        ...backendForResultSet([]),
        ensureCollection: async () =>
          backendCfg.qmdCollection === "openclaw-engram--ns-736861726564" ? "missing" : "present",
      };
      backends.set(backendCfg.qmdCollection, backend);
      return backend;
    },
  );

  await router.updateNamespaces(["default", "shared"]);
  await router.embedNamespaces(["default", "shared"]);

  assert.deepEqual(backends.get("openclaw-engram")?.calls, ["update", "embed"]);
  assert.deepEqual(backends.get("openclaw-engram--ns-736861726564")?.calls ?? [], []);
});

test("NamespaceSearchRouter forwards execution options to namespace updates", async () => {
  const memoryDir = tmpDir("engram-ns-search-update-execution");
  const cfg = baseConfig(memoryDir);
  const backend = backendForResultSet([]);
  const signal = new AbortController().signal;
  const router = new NamespaceSearchRouter(
    cfg,
    {
      async storageFor() {
        return { dir: memoryDir };
      },
    } as any,
    () => backend,
  );

  await router.updateNamespaces(["default"], { signal });

  assert.deepEqual(backend.calls, ["update"]);
  assert.equal(backend.lastUpdateExecution?.signal, signal);
});

test("NamespaceSearchRouter ensureNamespaceCollection returns cached availability without re-ensuring", async () => {
  const memoryDir = tmpDir("engram-ns-search-ensure");
  const cfg = baseConfig(memoryDir);
  let ensureCalls = 0;
  const storageRouter = {
    async storageFor() {
      return { dir: memoryDir };
    },
  };

  const router = new NamespaceSearchRouter(
    cfg,
    storageRouter as any,
    () => ({
      ...backendForResultSet([]),
      probe: async () => false,
      ensureCollection: async () => {
        ensureCalls += 1;
        return "present";
      },
    }),
  );

  const state = await router.ensureNamespaceCollection("default");

  assert.equal(state, "unknown");
  assert.equal(ensureCalls, 0);
});
