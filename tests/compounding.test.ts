import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "@remnic/core/types";
import { CompoundingEngine } from "@remnic/core/compounding/engine";
import { StorageManager } from "@remnic/core/storage";
import { isEncryptedFile, SecureStoreDecryptError } from "@remnic/core/secure-store";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function minimalConfig(memoryDir: string, sharedContextDir?: string): PluginConfig {
  return {
    openaiApiKey: undefined,
    model: "gpt-5.2",
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
    summaryModel: "gpt-5.2",
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
  };
}

const isSecureStoreDecryptError = (error: unknown): boolean =>
  error instanceof SecureStoreDecryptError;

test("v5 compounding writes weekly report and mistakes.json even with no feedback", async () => {
  const memoryDir = tmpDir("engram-compound-mem");
  const sharedDir = tmpDir("engram-compound-shared");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const eng = new CompoundingEngine(cfg);

  const res = await eng.synthesizeWeekly();
  const report = await readFile(res.reportPath, "utf-8");
  assert.match(report, /Weekly Compounding/);

  const mistakes = await eng.readMistakes();
  assert.ok(mistakes);
  assert.equal(mistakes!.patterns.length, 0);
  assert.deepEqual(mistakes!.registry, []);
});

test("v5 compounding extracts patterns from feedback learning/rejections", async () => {
  const memoryDir = tmpDir("engram-compound-mem2");
  const sharedDir = tmpDir("engram-compound-shared2");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const feedbackPath = path.join(sharedDir, "feedback", "inbox.jsonl");
  await writeFile(
    feedbackPath,
    [
      JSON.stringify({
        agent: "seo-digest",
        decision: "approved_with_feedback",
        reason: "Add ICE scoring",
        date: new Date().toISOString(),
        learning: "Always include confidence score",
      }),
      JSON.stringify({
        agent: "client-health",
        decision: "rejected",
        reason: "WRONG DATA: churn should use closed/won customers",
        date: new Date().toISOString(),
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(cfg);
  await eng.synthesizeWeekly();
  const mistakes = await eng.readMistakes();
  assert.ok(mistakes);
  assert.ok(mistakes!.patterns.some((p) => p.includes("seo-digest: Always include confidence score")));
  assert.ok(mistakes!.patterns.some((p) => p.includes("client-health: WRONG DATA")));
  assert.ok(mistakes!.registry?.some((entry) => entry.agent === "seo-digest"));
});

test("v5 compounding defaults shared feedback under configured workspace", async () => {
  const memoryDir = tmpDir("remnic-compound-workspace-mem");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir);
  const feedbackDir = path.join(cfg.workspaceDir, "shared-context", "feedback");
  await mkdir(feedbackDir, { recursive: true });
  await writeFile(
    path.join(feedbackDir, "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "bench-agent",
        decision: "approved_with_feedback",
        reason: "Make benchmark isolation explicit",
        date: new Date().toISOString(),
        learning: "Always keep benchmark shared context inside the run workspace",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(cfg);
  await eng.synthesizeWeekly();
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.ok(
    mistakes!.patterns.some((pattern) =>
      pattern.includes("bench-agent: Always keep benchmark shared context inside the run workspace"),
    ),
  );
});

test("v5 compounding ingests failing memory-action patterns", async () => {
  const memoryDir = tmpDir("engram-compound-mem-actions");
  const sharedDir = tmpDir("engram-compound-shared-actions");
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const nowIso = new Date().toISOString();
  const actionPath = path.join(memoryDir, "state", "memory-actions.jsonl");
  await writeFile(
    actionPath,
    [
      JSON.stringify({
        timestamp: nowIso,
        action: "discard",
        outcome: "skipped",
        namespace: "team-alpha",
        policyDecision: "deny",
        reason: "policy:deny | high_importance_requires_manual_review",
      }),
      JSON.stringify({
        timestamp: nowIso,
        action: "store_note",
        outcome: "applied",
        namespace: "team-alpha",
        policyDecision: "allow",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(cfg);
  await eng.synthesizeWeekly();
  const mistakes = await eng.readMistakes();
  assert.ok(mistakes);
  assert.ok(
    mistakes!.patterns.some((p) =>
      p.includes("memory-action/team-alpha: discard skipped/deny"),
    ),
  );
  assert.equal(
    mistakes!.patterns.some((p) => p.includes("store_note applied")),
    false,
  );
  assert.ok(mistakes!.registry?.some((entry) => entry.workflow === "memory-actions"));
});

test("v5 compounding reads encrypted memory-action telemetry through storage", async () => {
  const memoryDir = tmpDir("engram-compound-encrypted-mem-actions");
  const sharedDir = tmpDir("engram-compound-encrypted-shared-actions");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const storage = new StorageManager(memoryDir);
  storage.setSecureStoreKey(Buffer.alloc(32, 0x5c), true);
  await storage.ensureDirectories();
  await storage.appendMemoryActionEvents([
    {
      timestamp: new Date().toISOString(),
      action: "discard",
      outcome: "skipped",
      namespace: "team-alpha",
      policyDecision: "deny",
      reason: "policy:deny | high_importance_requires_manual_review",
    },
  ]);

  const actionPath = path.join(memoryDir, "state", "memory-actions.jsonl");
  assert.ok(isEncryptedFile(await readFile(actionPath)), "memory-action telemetry should be encrypted");

  const eng = new CompoundingEngine(cfg, storage);
  await eng.synthesizeWeekly();
  const mistakes = await eng.readMistakes();
  assert.ok(mistakes);
  assert.ok(
    mistakes!.patterns.some((p) =>
      p.includes("memory-action/team-alpha: discard skipped/deny"),
    ),
  );
});

test("v5 compounding surfaces encrypted memory-action telemetry decrypt failures", async () => {
  const memoryDir = tmpDir("engram-compound-encrypted-mem-actions-wrong-key");
  const sharedDir = tmpDir("engram-compound-encrypted-shared-actions-wrong-key");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const storage = new StorageManager(memoryDir);
  storage.setSecureStoreKey(Buffer.alloc(32, 0x5c), true);
  await storage.ensureDirectories();
  await storage.appendMemoryActionEvents([
    {
      timestamp: new Date().toISOString(),
      action: "discard",
      outcome: "skipped",
      namespace: "team-alpha",
      policyDecision: "deny",
      reason: "policy:deny | high_importance_requires_manual_review",
    },
  ]);

  const actionPath = path.join(memoryDir, "state", "memory-actions.jsonl");
  assert.ok(isEncryptedFile(await readFile(actionPath)), "memory-action telemetry should be encrypted");

  const wrongKeyStorage = new StorageManager(memoryDir);
  wrongKeyStorage.setSecureStoreKey(Buffer.alloc(32, 0xa5), true);
  const eng = new CompoundingEngine(cfg, wrongKeyStorage);
  await assert.rejects(
    () => eng.synthesizeWeekly(),
    isSecureStoreDecryptError,
  );
});

test("v5 compounding reads legacy mistake files into stable registry form", async () => {
  const memoryDir = tmpDir("engram-compound-legacy");
  const sharedDir = tmpDir("engram-compound-legacy-shared");
  await mkdir(path.join(memoryDir, "compounding"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "compounding", "mistakes.json"),
    JSON.stringify({
      updatedAt: "2026-02-25T10:00:00.000Z",
      patterns: ["agent-a: Always include explicit confidence rationale"],
    }, null, 2),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.patterns.length, 1);
  assert.equal(mistakes!.registry?.length, 1);
  assert.equal(mistakes!.registry?.[0]?.recurrenceCount, 1);
  assert.equal(mistakes!.registry?.[0]?.status, "active");
  assert.equal(mistakes!.registry?.[0]?.agent, "agent-a");
});

test("v5 compounding migrates legacy action patterns with action category metadata", async () => {
  const memoryDir = tmpDir("engram-compound-legacy-action");
  const sharedDir = tmpDir("engram-compound-legacy-action-shared");
  await mkdir(path.join(memoryDir, "compounding"), { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(memoryDir, "compounding", "mistakes.json"),
    JSON.stringify({
      updatedAt: "2026-02-25T10:00:00.000Z",
      patterns: ["memory-action/team-alpha: discard skipped/deny - policy:deny | high_importance_requires_manual_review"],
    }, null, 2),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.[0]?.category, "action");
  assert.equal(mistakes!.registry?.[0]?.workflow, "memory-actions");
  assert.equal(mistakes!.registry?.[0]?.agent, null);
  assert.match(mistakes!.registry?.[0]?.id ?? "", /^action:global:memory-actions:/);
});

test("v5 compounding preserves recurrence when a legacy registry entry is synthesized again", async () => {
  const memoryDir = tmpDir("engram-compound-legacy-recurrence");
  const sharedDir = tmpDir("engram-compound-legacy-recurrence-shared");
  await mkdir(path.join(memoryDir, "compounding"), { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(memoryDir, "compounding", "mistakes.json"),
    JSON.stringify({
      updatedAt: "2026-02-25T10:00:00.000Z",
      patterns: ["agent-a: Always include explicit confidence rationale"],
    }, null, 2),
    "utf-8",
  );

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "agent-a",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-03-03T10:00:00.000Z",
        learning: "Always include explicit confidence rationale",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  await eng.synthesizeWeekly({ weekId: "2026-W10" });
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.length, 1);
  assert.equal(mistakes!.registry?.[0]?.recurrenceCount, 2);
  assert.equal(mistakes!.registry?.[0]?.firstSeenAt, "2026-02-25T10:00:00.000Z");
});

test("v5 compounding preserves recurrence for legacy action patterns when synthesized again", async () => {
  const memoryDir = tmpDir("engram-compound-legacy-action-recurrence");
  const sharedDir = tmpDir("engram-compound-legacy-action-recurrence-shared");
  await mkdir(path.join(memoryDir, "compounding"), { recursive: true });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "compounding", "mistakes.json"),
    JSON.stringify({
      updatedAt: "2026-02-25T10:00:00.000Z",
      patterns: ["memory-action/team-alpha: discard skipped/deny - policy:deny | high_importance_requires_manual_review"],
    }, null, 2),
    "utf-8",
  );

  const cfg = minimalConfig(memoryDir, sharedDir);
  const eng = new CompoundingEngine(cfg);
  await writeFile(
    eng["memoryActionEventsPath"],
    [
      JSON.stringify({
        timestamp: "2026-03-03T10:00:00.000Z",
        action: "discard",
        outcome: "skipped",
        namespace: "team-alpha",
        policyDecision: "deny",
        reason: "policy:deny | high_importance_requires_manual_review",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  await eng.synthesizeWeekly({ weekId: "2026-W10" });
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.length, 1);
  assert.equal(mistakes!.registry?.[0]?.category, "action");
  assert.equal(mistakes!.registry?.[0]?.recurrenceCount, 2);
});

test("v5 compounding does not duplicate legacy registry entries when scope metadata narrows", async () => {
  const memoryDir = tmpDir("engram-compound-legacy-scope");
  const sharedDir = tmpDir("engram-compound-legacy-scope-shared");
  await mkdir(path.join(memoryDir, "compounding"), { recursive: true });
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  await writeFile(
    path.join(memoryDir, "compounding", "mistakes.json"),
    JSON.stringify({
      version: 2,
      updatedAt: "2026-02-25T10:00:00.000Z",
      patterns: ["agent-a: Always include explicit confidence rationale"],
      registry: [
        {
          id: "feedback:agent-a:default:agent-a-always-include-explicit-confidence-rat",
          pattern: "agent-a: Always include explicit confidence rationale",
          category: "feedback",
          status: "active",
          agent: "agent-a",
          workflow: null,
          tags: [],
          severity: null,
          confidence: null,
          outcome: null,
          provenance: [],
          firstSeenAt: "2026-02-25T10:00:00.000Z",
          lastSeenAt: "2026-02-25T10:00:00.000Z",
          recurrenceCount: 1,
          lastWeekId: "2026-W09",
          evidenceWindow: { start: null, end: null },
          retiredAt: null,
        },
      ],
    }, null, 2),
    "utf-8",
  );

  await writeFile(
    path.join(sharedDir, "feedback", "inbox.jsonl"),
    [
      JSON.stringify({
        agent: "agent-a",
        workflow: "review-loop",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-03-03T10:00:00.000Z",
        learning: "Always include explicit confidence rationale",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  await eng.synthesizeWeekly({ weekId: "2026-W10" });
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.length, 1);
  assert.equal(mistakes!.registry?.[0]?.workflow, "review-loop");
  assert.equal(mistakes!.registry?.[0]?.recurrenceCount, 2);
});

test("v5 compounding retirement does not age an adjacent ISO year boundary by an extra week", async () => {
  const memoryDir = tmpDir("engram-compound-week-boundary");
  const sharedDir = tmpDir("engram-compound-week-boundary-shared");
  await mkdir(path.join(memoryDir, "compounding"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  await writeFile(
    path.join(memoryDir, "compounding", "mistakes.json"),
    JSON.stringify({
      version: 2,
      updatedAt: "2025-12-28T10:00:00.000Z",
      patterns: ["agent-a: boundary-safe recurrence"],
      registry: [
        {
          id: "feedback:agent-a:default:agent-a-boundary-safe-recurrence",
          pattern: "agent-a: boundary-safe recurrence",
          category: "feedback",
          status: "active",
          agent: "agent-a",
          workflow: null,
          tags: [],
          severity: null,
          confidence: null,
          outcome: null,
          provenance: [],
          firstSeenAt: "2025-12-28T10:00:00.000Z",
          lastSeenAt: "2025-12-28T10:00:00.000Z",
          recurrenceCount: 1,
          lastWeekId: "2025-W52",
          evidenceWindow: { start: null, end: null },
          retiredAt: null,
        },
      ],
    }, null, 2),
    "utf-8",
  );

  const eng = new CompoundingEngine(minimalConfig(memoryDir, sharedDir));
  await eng.synthesizeWeekly({ weekId: "2026-W07" });
  const mistakes = await eng.readMistakes();

  assert.ok(mistakes);
  assert.equal(mistakes!.registry?.length, 1);
  assert.equal(mistakes!.registry?.[0]?.status, "active");
  assert.equal(mistakes!.registry?.[0]?.retiredAt ?? null, null);
});

test("v5 compounding does not read continuity audit references when audits are disabled", async () => {
  const memoryDir = tmpDir("engram-compound-no-audit-");
  const sharedDir = tmpDir("engram-compound-no-audit-shared-");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  cfg.continuityAuditEnabled = false;
  const eng = new CompoundingEngine(cfg);

  (eng as any).readContinuityAuditReferences = async () => {
    throw new Error("should not be called when continuityAuditEnabled=false");
  };

  const res = await eng.synthesizeWeekly();
  const report = await readFile(res.reportPath, "utf-8");
  assert.match(report, /Weekly Compounding/);
});

test("v5 weekly synthesis ignores unreadable continuity audit references", async () => {
  const memoryDir = tmpDir("engram-compound-unreadable-audit-ref-");
  const sharedDir = tmpDir("engram-compound-unreadable-audit-ref-shared-");
  await mkdir(path.join(memoryDir, "identity", "audits", "weekly", "2026-W11.md"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  cfg.continuityAuditEnabled = true;
  const eng = new CompoundingEngine(cfg);

  const res = await eng.synthesizeWeekly({ weekId: "2026-W11" });
  const report = await readFile(res.reportPath, "utf-8");
  assert.match(report, /Weekly Compounding/);
});

test("v5 continuity audit filters incidents by state before applying scan cap", async () => {
  const memoryDir = tmpDir("engram-continuity-audit-cap-");
  const sharedDir = tmpDir("engram-continuity-audit-cap-shared-");
  await mkdir(path.join(memoryDir, "identity", "incidents"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  cfg.continuityAuditEnabled = true;
  const eng = new CompoundingEngine(cfg);

  const incidentsDir = path.join(memoryDir, "identity", "incidents");
  const now = new Date().toISOString();
  for (let i = 0; i < 200; i += 1) {
    const id = `continuity-${String(1000 + i).padStart(4, "0")}`;
    const md = [
      "---",
      `id: ${JSON.stringify(id)}`,
      'state: "closed"',
      `openedAt: ${JSON.stringify(now)}`,
      `updatedAt: ${JSON.stringify(now)}`,
      `closedAt: ${JSON.stringify(now)}`,
      "---",
      "",
      "## Symptom",
      "",
      "Closed regression.",
      "",
    ].join("\n");
    await writeFile(path.join(incidentsDir, `${id}.md`), md, "utf-8");
  }

  const openId = "continuity-0001";
  const openMd = [
    "---",
    `id: ${JSON.stringify(openId)}`,
    'state: "open"',
    `openedAt: ${JSON.stringify(now)}`,
    `updatedAt: ${JSON.stringify(now)}`,
    "---",
    "",
    "## Symptom",
    "",
    "Still open incident.",
    "",
  ].join("\n");
  await writeFile(path.join(incidentsDir, `${openId}.md`), openMd, "utf-8");

  const res = await eng.synthesizeContinuityAudit({ period: "weekly", key: "2026-W08" });
  const report = await readFile(res.reportPath, "utf-8");
  assert.match(report, /Open incidents: 1/);
  assert.match(report, /- continuity-0001/);
});

test("v5 continuity audit treats unreadable identity anchor as absent", async () => {
  const memoryDir = tmpDir("engram-continuity-audit-unreadable-anchor-");
  const sharedDir = tmpDir("engram-continuity-audit-unreadable-anchor-shared-");
  await mkdir(path.join(memoryDir, "identity", "identity-anchor.md"), { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  cfg.continuityAuditEnabled = true;
  const eng = new CompoundingEngine(cfg);

  const res = await eng.synthesizeContinuityAudit({ period: "weekly", key: "2026-W10" });
  const report = await readFile(res.reportPath, "utf-8");
  assert.match(report, /Identity anchor drift: needs attention/);
});

test("v5 continuity audit reads encrypted identity artifacts through storage", async () => {
  const memoryDir = tmpDir("engram-continuity-audit-encrypted-");
  const sharedDir = tmpDir("engram-continuity-audit-encrypted-shared-");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  cfg.continuityAuditEnabled = true;
  const storage = new StorageManager(memoryDir);
  storage.setSecureStoreKey(Buffer.alloc(32, 0x4a), true);
  await storage.ensureDirectories();
  await storage.writeIdentityAnchor("# Identity Anchor\n\n- encrypted anchor baseline");
  await storage.writeIdentityImprovementLoops([
    "# Continuity Improvement Loops",
    "",
    "## weekly-check",
    "cadence: weekly",
    "purpose: Keep continuity audit honest.",
    "status: active",
    "killCondition: Audit no longer finds stale loops.",
    "lastReviewed: 2026-04-28T00:00:00.000Z",
    "",
  ].join("\n"));
  await storage.appendContinuityIncident({
    symptom: "Encrypted open incident remains visible to the continuity audit.",
  });

  const eng = new CompoundingEngine(cfg, storage);
  const res = await eng.synthesizeContinuityAudit({ period: "weekly", key: "2026-W09" });

  assert.ok(isEncryptedFile(await readFile(res.reportPath)), "continuity audit report should be encrypted");
  const report = await storage.readIdentityAudit("weekly", "2026-W09");
  assert.match(report ?? "", /Identity anchor drift: pass/);
  assert.match(report ?? "", /Improvement-loop coverage: pass/);
  assert.match(report ?? "", /Open incidents: 1/);
  assert.match(report ?? "", /- incident-/);
});
