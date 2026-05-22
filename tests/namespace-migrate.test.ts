import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "../src/types.js";
import {
  listNamespaces,
  runNamespaceMigration,
  verifyNamespaces,
} from "../src/namespaces/migrate.js";
import { NamespaceStorageRouter } from "../src/namespaces/storage.js";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
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
    namespacePolicies: [{ name: "team-alpha", readPrincipals: ["*"], writePrincipals: ["*"], includeInRecallByDefault: false }],
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

test("listNamespaces reports legacy-root default namespace before migration", async () => {
  const memoryDir = tmpDir("engram-namespace-list");
  await mkdir(memoryDir, { recursive: true });
  const namespaces = await listNamespaces({ config: baseConfig(memoryDir) });
  const defaultEntry = namespaces.find((entry) => entry.namespace === "default");
  assert.ok(defaultEntry);
  assert.equal(defaultEntry.usesLegacyRoot, true);
  assert.equal(defaultEntry.rootDir, memoryDir);
});

test("verifyNamespaces reports legacy data before migration", async () => {
  const memoryDir = tmpDir("engram-namespace-plan");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "profile.md"), "# Profile\n", "utf-8");

  const config = baseConfig(memoryDir);
  const report = await verifyNamespaces({ config });
  const defaultEntry = report.namespaces.find((entry) => entry.namespace === "default");
  assert.ok(defaultEntry);
  assert.equal(report.ok, true);
  assert.equal(defaultEntry.hasMemoryData, true);
  assert.equal(defaultEntry.usesLegacyRoot, true);
  assert.deepEqual(report.problems, []);
});

test("verifyNamespaces flags missing and empty namespace roots", async () => {
  const memoryDir = tmpDir("engram-namespace-verify-missing");
  await mkdir(path.join(memoryDir, "namespaces", "shared"), { recursive: true });

  const report = await verifyNamespaces({ config: baseConfig(memoryDir) });
  assert.equal(report.ok, false);
  assert.match(report.problems.join("\n"), /shared: root exists but contains no Engram data/);
  assert.doesNotMatch(report.problems.join("\n"), /team-alpha: missing root/);
});

test("runNamespaceMigration moves legacy entries into target namespace", async () => {
  const memoryDir = tmpDir("engram-namespace-migrate");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "profile.md"), "# Profile\n", "utf-8");

  const config = baseConfig(memoryDir);
  const report = await runNamespaceMigration({ config, to: "default" });
  assert.equal(report.dryRun, false);
  assert.equal(report.moved.length, 2);

  const rootEntries = await readdir(memoryDir);
  assert.deepEqual(rootEntries.sort(), ["namespaces"]);

  const migratedEntries = await readdir(path.join(memoryDir, "namespaces", "default"));
  assert.deepEqual(migratedEntries.sort(), ["facts", "profile.md"]);
});

test("runNamespaceMigration rolls back completed moves when a later move fails", async () => {
  const memoryDir = tmpDir("engram-namespace-migrate-rollback");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "facts", "a.md"), "Fact A\n", "utf-8");
  await mkdir(path.join(memoryDir, "entities"), { recursive: true });
  await writeFile(path.join(memoryDir, "entities", "b.md"), "Entity B\n", "utf-8");

  const config = baseConfig(memoryDir);
  await assert.rejects(
    () =>
      runNamespaceMigration({
        config,
        to: "default",
        async renameFn(from, to) {
          if (from.endsWith(`${path.sep}entities`)) {
            throw new Error("synthetic rename failure");
          }
          const fs = await import("node:fs/promises");
          await fs.rename(from, to);
        },
      }),
    /rolled back.*synthetic rename failure/,
  );

  assert.equal(await readFile(path.join(memoryDir, "facts", "a.md"), "utf-8"), "Fact A\n");
  assert.equal(await readFile(path.join(memoryDir, "entities", "b.md"), "utf-8"), "Entity B\n");
});

test("runNamespaceMigration rejects symlinked namespace reservation paths", async () => {
  const memoryDir = tmpDir("engram-namespace-migrate-symlink");
  const outside = tmpDir("engram-namespace-outside");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(memoryDir, "namespaces"));

  await assert.rejects(
    () => runNamespaceMigration({ config: baseConfig(memoryDir), to: "default" }),
    /symlinked namespaces directory/,
  );
});

test("default namespace router keeps legacy root when partial migrated root exists", async () => {
  const memoryDir = tmpDir("engram-namespace-partial-default");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(path.join(memoryDir, "namespaces", "default", "entities"), { recursive: true });

  const router = new NamespaceStorageRouter(baseConfig(memoryDir));
  const storage = await router.storageFor("default");
  assert.equal(storage.dir, memoryDir);
});
