import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "../src/types.js";
import { NamespaceStorageRouter } from "../src/namespaces/storage.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseConfig(memoryDir: string): PluginConfig {
  return {
    openaiApiKey: undefined,
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
    conversationRecallTopK: 3,
    conversationRecallMaxChars: 2000,
    conversationRecallTimeoutMs: 500,
    localLlmEnabled: false,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 1000,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    extractionDedupeEnabled: true,
    extractionDedupeWindowMs: 60_000,
    extractionMinChars: 20,
    extractionMinUserTurns: 1,
    extractionMaxTurnChars: 4000,
    extractionMaxFactsPerRun: 12,
    extractionMaxEntitiesPerRun: 6,
    extractionMaxQuestionsPerRun: 3,
    extractionMaxProfileUpdatesPerRun: 4,
    consolidationRequireNonZeroExtraction: true,
    consolidationMinIntervalMs: 60_000,
    qmdMaintenanceEnabled: true,
    qmdMaintenanceDebounceMs: 500,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 60_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 50,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
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
  };
}

test("v3 namespaces router uses legacy memoryDir for default namespace if namespaced dir missing", async () => {
  const memoryDir = tmpDir("engram-ns-router");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const s = await router.storageFor("default");
  await s.ensureDirectories();
  await s.writeProfile("# Profile\n\n- Legacy root\n");

  const legacyProfile = await readFile(path.join(memoryDir, "profile.md"), "utf-8");
  assert.match(legacyProfile, /Legacy root/);
});

test("v3 namespaces router uses namespaced dir when it exists before first resolve", async () => {
  const memoryDir = tmpDir("engram-ns-router2");
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(nsDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const s = await router.storageFor("default");
  await s.ensureDirectories();
  await s.writeProfile("# Profile\n\n- Namespaced\n");

  const namespacedProfile = await readFile(path.join(nsDir, "profile.md"), "utf-8");
  assert.match(namespacedProfile, /Namespaced/);
});

test("v3 namespaces router refreshes default storage when namespaced dir appears", async () => {
  const memoryDir = tmpDir("engram-ns-router-refresh");
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const legacyStorage = await router.storageFor("default");
  assert.equal(legacyStorage.dir, memoryDir);

  await mkdir(nsDir, { recursive: true });

  const namespacedStorage = await router.storageFor("default");
  assert.equal(namespacedStorage.dir, nsDir);
  assert.notEqual(namespacedStorage, legacyStorage);
});

test("v3 namespaces router keeps default storage at legacy root when legacy data exists", async () => {
  const memoryDir = tmpDir("engram-ns-router-legacy-refresh");
  const nsDir = path.join(memoryDir, "namespaces", "default");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  const router = new NamespaceStorageRouter(cfg);

  const legacyStorage = await router.storageFor("default");
  await legacyStorage.ensureDirectories();
  await legacyStorage.writeProfile("# Profile\n\n- Legacy root\n");
  await mkdir(nsDir, { recursive: true });

  const refreshedStorage = await router.storageFor("default");
  assert.equal(refreshedStorage.dir, memoryDir);
  assert.equal(refreshedStorage, legacyStorage);
});

test("v3 namespaces router propagates custom entity schemas to routed storage managers", async () => {
  const memoryDir = tmpDir("engram-ns-router-schemas");
  await mkdir(path.join(memoryDir, "entities"), { recursive: true });

  const cfg = baseConfig(memoryDir);
  cfg.entitySchemas = {
    person: {
      sections: [{ key: "principles", title: "Principles", description: "" }],
    },
  };

  const router = new NamespaceStorageRouter(cfg);
  const storage = await router.storageFor("default");
  const canonical = "person-alice-example";
  await writeFile(
    path.join(memoryDir, "entities", `${canonical}.md`),
    [
      "# Alice Example",
      "",
      "**Type:** person",
      "",
      "## Principles",
      "",
      "- Alice Example documents operating principles explicitly.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const entities = await storage.readAllEntityFiles();

  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0]?.structuredSections, [
    {
      key: "principles",
      title: "Principles",
      facts: ["Alice Example documents operating principles explicitly."],
    },
  ]);
});
