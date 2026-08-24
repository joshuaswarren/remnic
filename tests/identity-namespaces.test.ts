import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";
import { Orchestrator } from "@remnic/core/orchestrator";
import type { PluginConfig } from "@remnic/core/types";
import { parseConfig } from "@remnic/core/config";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseConfig(memoryDir: string): PluginConfig {
  return parseConfig({
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
    qmdEnabled: false,
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
    identityEnabled: true,
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
    recallPlannerEnabled: false,
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
    namespacePolicies: [],
    defaultRecallNamespaces: ["self"],
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
  });
}

test("StorageManager stores namespace-local identity reflections under identity/reflections.md", async () => {
  const root = tmpDir("engram-identity-ns-storage");
  const storage = new StorageManager(root);
  await storage.ensureDirectories();

  await storage.appendIdentityReflection("Namespace-local reflection");

  const content = await storage.readIdentityReflections();
  assert.match(content ?? "", /Namespace-local reflection/);

  const raw = await readFile(path.join(root, "identity", "reflections.md"), "utf-8");
  assert.match(raw, /Namespace-local reflection/);
});

test("StorageManager rate-limits namespace-local identity reflections", async () => {
  const root = tmpDir("engram-identity-ns-cooldown");
  const storage = new StorageManager(root);
  await storage.ensureDirectories();

  await storage.appendIdentityReflection("first reflection");
  await storage.appendIdentityReflection("second reflection");

  const content = await storage.readIdentityReflections();
  assert.match(content ?? "", /first reflection/);
  assert.doesNotMatch(content ?? "", /second reflection/);
});

test("StorageManager skips namespace-local identity reflections once the log is oversized", async () => {
  const root = tmpDir("engram-identity-ns-size-cap");
  const storage = new StorageManager(root);
  await storage.ensureDirectories();

  const oversized = `## Reflection — 2026-03-08T00:00:00.000Z\n\n${"A".repeat(15_100)}\n`;
  await writeFile(path.join(root, "identity", "reflections.md"), oversized, "utf-8");

  await storage.appendIdentityReflection("should be skipped");

  const content = await storage.readIdentityReflections();
  assert.equal(content, oversized);
});

test("persistExtraction writes identity reflections into namespace-local storage when namespaces are enabled", async () => {
  const memoryDir = tmpDir("engram-identity-ns");
  await mkdir(path.join(memoryDir, "workspace"), { recursive: true });
  await writeFile(path.join(memoryDir, "workspace", "IDENTITY.md"), "# IDENTITY\n", "utf-8");

  const orchestrator = new Orchestrator(baseConfig(memoryDir));

  let namespaceIdentityWrites = 0;
  const storage = {
    dir: path.join(memoryDir, "namespaces", "default"),
    appendIdentityReflection: async (_reflection: string) => {
      namespaceIdentityWrites += 1;
    },
    loadMeta: async () => ({
      extractionCount: 0,
      lastExtractionAt: null,
      totalMemories: 0,
      totalEntities: 0,
    }),
    saveMeta: async () => {},
    appendBehaviorSignals: async () => {},
  };

  (orchestrator as any).requestQmdMaintenance = () => {};
  (orchestrator as any).runTierMigrationCycle = async () => ({ migrated: 0 });

  await (orchestrator as any).persistExtraction(
    {
      facts: [],
      entities: [],
      questions: [],
      profileUpdates: [],
      identityReflection: "Per-namespace reflection",
    },
    storage,
    null,
  );

  assert.equal(namespaceIdentityWrites, 1);
  const workspaceIdentity = await readFile(path.join(memoryDir, "workspace", "IDENTITY.md"), "utf-8");
  assert.equal(workspaceIdentity.trim(), "# IDENTITY");
});

test("autoConsolidateIdentity keeps the default namespace on workspace IDENTITY.md", async () => {
  const memoryDir = tmpDir("engram-identity-default-workspace");
  const workspaceDir = path.join(memoryDir, "workspace");
  const identityDir = path.join(memoryDir, "identity");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(identityDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "IDENTITY.md"), "# IDENTITY\n\n## Purpose\n\nBootstrap\n", "utf-8");
  await writeFile(
    path.join(identityDir, "reflections.md"),
    `## Reflection — 2026-03-08T00:00:00.000Z\n\n${"A".repeat(8_500)}\n`,
    "utf-8",
  );

  const orchestrator = new Orchestrator(baseConfig(memoryDir)) as any;
  orchestrator.extraction = {
    consolidateIdentity: async () => ({
      learnedPatterns: ["Keep the default namespace on IDENTITY.md"],
    }),
  };

  await orchestrator.autoConsolidateIdentity();

  const defaultIdentity = await readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
  assert.match(defaultIdentity, /Keep the default namespace on IDENTITY\.md/);
  assert.match(defaultIdentity, /## Purpose/);

  const namespacedDefaultPath = path.join(workspaceDir, "IDENTITY.default.md");
  await assert.rejects(() => readFile(namespacedDefaultPath, "utf-8"));

  const reflectionLog = await readFile(path.join(identityDir, "reflections.md"), "utf-8");
  assert.equal(reflectionLog, "");
});

test("autoConsolidateIdentity still triggers when the existing header pushes synthesized identity over threshold", async () => {
  const memoryDir = tmpDir("engram-identity-threshold-header");
  const workspaceDir = path.join(memoryDir, "workspace");
  const identityDir = path.join(memoryDir, "identity");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(identityDir, { recursive: true });
  const largeHeader = "# IDENTITY\n\n## Purpose\n\n" + "B".repeat(6_500);
  await writeFile(path.join(workspaceDir, "IDENTITY.md"), `${largeHeader}\n`, "utf-8");
  await writeFile(
    path.join(identityDir, "reflections.md"),
    `## Reflection — 2026-03-08T00:00:00.000Z\n\n${"A".repeat(2_000)}\n`,
    "utf-8",
  );

  let consolidateCalls = 0;
  const orchestrator = new Orchestrator(baseConfig(memoryDir)) as any;
  orchestrator.extraction = {
    consolidateIdentity: async () => {
      consolidateCalls += 1;
      return { learnedPatterns: ["Header size should still trigger consolidation"] };
    },
  };

  await orchestrator.autoConsolidateIdentity();

  assert.equal(consolidateCalls, 1);
  const defaultIdentity = await readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
  assert.match(defaultIdentity, /Header size should still trigger consolidation/);
});
