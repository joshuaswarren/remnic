import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PluginConfig } from "../src/types.js";
import { parseConfig } from "../src/config.js";
import { CompoundingEngine } from "../src/compounding/engine.js";
import { registerTools } from "../src/tools.ts";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function minimalConfig(memoryDir: string, sharedContextDir: string): PluginConfig {
  return parseConfig({
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
    identityContinuityEnabled: true,
    identityInjectionMode: "recovery_only",
    identityMaxInjectChars: 1200,
    continuityIncidentLoggingEnabled: true,
    continuityAuditEnabled: true,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
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
    namespacesEnabled: false,
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
    sharedContextDir,
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: true,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: true,
  });
}

test("continuity audit generator writes deterministic weekly audit", async () => {
  const memoryDir = tmpDir("engram-continuity-audit");
  const sharedDir = tmpDir("engram-continuity-audit-shared");
  await mkdir(path.join(memoryDir, "identity", "incidents"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "identity", "identity-anchor.md"),
    "# Identity Continuity Anchor\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "identity", "improvement-loops.md"),
    [
      "# Continuity Improvement Loops",
      "",
      "## weekly-audit",
      "cadence: weekly",
      "purpose: run continuity audit",
      "status: active",
      "killCondition: automated health checks replace manual loop",
      "lastReviewed: 2020-01-01T00:00:00.000Z",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "identity", "incidents", "2026-02-24-incident-1.md"),
    [
      "---",
      "id: \"incident-1\"",
      "state: \"open\"",
      "openedAt: \"2026-02-24T00:00:00.000Z\"",
      "updatedAt: \"2026-02-24T00:00:00.000Z\"",
      "---",
      "",
      "## Symptom",
      "",
      "anchor missing",
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  const res = await eng.synthesizeContinuityAudit({ period: "weekly", key: "2026-W09" });
  const md = await readFile(res.reportPath, "utf-8");

  assert.match(md, /Continuity Audit — weekly 2026-W09/);
  assert.match(md, /Identity anchor present: yes/);
  assert.match(md, /Stale active loops: 1/);
  assert.match(md, /Open incidents: 1/);
  assert.match(md, /Stale active continuity loops: weekly-audit/);
  assert.match(md, /Next Hardening Action/);
});

test("weekly compounding report links continuity audit outputs when enabled", async () => {
  const memoryDir = tmpDir("engram-compound-audit-link");
  const sharedDir = tmpDir("engram-compound-audit-link-shared");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  const weekly = await eng.synthesizeWeekly();
  await eng.synthesizeContinuityAudit({ period: "weekly", key: weekly.weekId });

  const rerun = await eng.synthesizeWeekly({ weekId: weekly.weekId });
  const report = await readFile(rerun.reportPath, "utf-8");
  assert.match(report, /## Continuity Audits/);
  assert.match(report, new RegExp(`weekly: .*${weekly.weekId}\\.md`));
});

test("continuity audit treats missing loop lastReviewed as stale", async () => {
  const memoryDir = tmpDir("engram-continuity-audit-missing-reviewed");
  const sharedDir = tmpDir("engram-continuity-audit-missing-reviewed-shared");
  await mkdir(path.join(memoryDir, "identity"), { recursive: true });
  await mkdir(path.join(memoryDir, "identity", "incidents"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "identity", "identity-anchor.md"),
    "# Identity Continuity Anchor\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "identity", "improvement-loops.md"),
    [
      "# Continuity Improvement Loops",
      "",
      "## weekly-audit",
      "cadence: weekly",
      "purpose: run continuity audit",
      "status: active",
      "killCondition: automated checks replace manual loop",
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  const res = await eng.synthesizeContinuityAudit({ period: "weekly", key: "2026-W09" });
  const md = await readFile(res.reportPath, "utf-8");
  assert.match(md, /Stale active loops: 1/);
  assert.match(md, /Stale active continuity loops: weekly-audit/);
});

test("continuity audit treats invalid loop lastReviewed as stale", async () => {
  const memoryDir = tmpDir("engram-continuity-audit-invalid-reviewed");
  const sharedDir = tmpDir("engram-continuity-audit-invalid-reviewed-shared");
  await mkdir(path.join(memoryDir, "identity"), { recursive: true });
  await mkdir(path.join(memoryDir, "identity", "incidents"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "identity", "identity-anchor.md"),
    "# Identity Continuity Anchor\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "identity", "improvement-loops.md"),
    [
      "# Continuity Improvement Loops",
      "",
      "## weekly-audit",
      "cadence: weekly",
      "purpose: run continuity audit",
      "status: active",
      "killCondition: automated checks replace manual loop",
      "lastReviewed: 2026-13-01",
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  const res = await eng.synthesizeContinuityAudit({ period: "weekly", key: "2026-W09" });
  const md = await readFile(res.reportPath, "utf-8");
  assert.match(md, /Stale active loops: 1/);
  assert.match(md, /Stale active continuity loops: weekly-audit/);
});

test("continuity_audit_generate tool is config-gated and returns report path", async () => {
  type RegisteredTool = {
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  };

  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: true,
      identityContinuityEnabled: true,
      continuityAuditEnabled: true,
      continuityIncidentLoggingEnabled: true,
    },
    compounding: {
      synthesizeContinuityAudit: async ({ period, key }: { period: "weekly" | "monthly"; key?: string }) => ({
        period,
        key: key ?? "2026-W09",
        reportPath: "/tmp/identity/audits/weekly/2026-W09.md",
      }),
      synthesizeWeekly: async () => ({
        weekId: "2026-W09",
        reportPath: "/tmp/r.md",
        rubricsPath: "/tmp/rubrics.md",
        mistakesCount: 0,
        promotionCandidateCount: 0,
      }),
    },
    qmd: { search: async () => [], searchGlobal: async () => [] },
    lastRecall: { get: () => null, getMostRecent: () => null },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
      readIdentityAnchor: async () => null,
      writeIdentityAnchor: async () => {},
      appendContinuityIncident: async () => null,
      closeContinuityIncident: async () => null,
      readContinuityIncidents: async () => [],
    },
    summarizer: { runHourly: async () => {} },
    transcript: { listSessionKeys: async () => [] },
    sharedContext: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
    appendMemoryActionEvent: async () => true,
  };

  registerTools(api as any, orchestrator as any);
  const tool = tools.get("continuity_audit_generate");
  assert.ok(tool);

  const result = await tool.execute("tc-audit", { period: "weekly", key: "2026-W09" });
  const text = result.content.map((c) => c.text).join("\n");
  assert.match(text, /period: weekly/);
  assert.match(text, /report: \/tmp\/identity\/audits\/weekly\/2026-W09\.md/);
});
