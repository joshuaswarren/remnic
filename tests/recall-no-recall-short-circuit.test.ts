import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import type { PluginConfig } from "@remnic/core/types";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

function tmpDir(prefix: string): string {
  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), "remnic-tests", `${prefix}-${uniqueSuffix}`);
}

function baseConfig(memoryDir: string): PluginConfig {
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
    sharedContextEnabled: true,
    sharedContextDir: path.join(memoryDir, "shared-context"),
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: false,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: false,
    recallPlannerEnabled: true,
    recallPlannerMaxQmdResultsMinimal: 1,
    intentRoutingEnabled: false,
    intentRoutingBoost: 0.25,
    verbatimArtifactsEnabled: false,
    verbatimArtifactsMinConfidence: 0.8,
    verbatimArtifactCategories: ["decision", "commitment", "correction", "principle"],
    verbatimArtifactsMaxRecall: 5,
  });
}

test("recallInternal short-circuits no_recall before preamble reads", async () => {
  const memoryDir = tmpDir("engram-no-recall");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  let storageRouterTouched = false;
  (orchestrator as any).storageRouter = {
    storageFor: async () => {
      storageRouterTouched = true;
      throw new Error("storageFor should not run for no_recall");
    },
  };

  const out = await (orchestrator as any).recallInternal("ok", undefined);
  assert.equal(out, "");
  assert.equal(storageRouterTouched, false);
});

test("recallInternal no_recall records last recall without blocking the response", async () => {
  const memoryDir = tmpDir("engram-no-recall-last-recall");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  let recordStarted = false;
  let releaseRecord!: () => void;
  const recordPromise = new Promise<void>((resolve) => {
    releaseRecord = resolve;
  });
  (orchestrator.lastRecall as any).record = () => {
    recordStarted = true;
    return recordPromise;
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "ok",
    "user:test:no-recall-record",
  );
  const result = await Promise.race([
    recallPromise.then((value: string) => ({
      status: "returned" as const,
      value,
    })),
    new Promise<{ status: "blocked" }>((resolve) =>
      setTimeout(() => resolve({ status: "blocked" }), 250),
    ),
  ]);

  releaseRecord();
  await recordPromise;

  assert.deepEqual(result, { status: "returned", value: "" });
  assert.equal(recordStarted, true);
});

test("artifact recall searches all readable namespaces", async () => {
  const memoryDir = tmpDir("engram-artifact-ns");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  cfg.namespacesEnabled = true;
  cfg.defaultNamespace = "default";
  cfg.sharedNamespace = "shared";
  cfg.defaultRecallNamespaces = ["self", "shared"];
  cfg.verbatimArtifactsEnabled = true;

  const orchestrator = new Orchestrator(cfg);
  const touched: string[] = [];
  const mkArtifact = (id: string, content: string) => ({
    path: `/tmp/memory/artifacts/${id}.md`,
    content,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-21T00:00:00.000Z",
      updated: "2026-02-21T00:00:00.000Z",
      source: "artifact",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
  });

  (orchestrator as any).storageRouter = {
    storageFor: async (namespace: string) => {
      touched.push(namespace);
      return {
        searchArtifacts: async () =>
          namespace === "shared" ? [mkArtifact("shared-artifact", "shared quote anchor")] : [],
      };
    },
  };
  (orchestrator as any).resolveArtifactSourceStatuses = async () => new Map();

  const artifacts = await (orchestrator as any).recallArtifactsAcrossNamespaces(
    "shared quote",
    ["default", "shared"],
    5,
  );

  assert.equal(touched.includes("default"), true);
  assert.equal(touched.includes("shared"), true);
  assert.equal(artifacts.some((a: any) => a.content.includes("shared quote anchor")), true);
});

test("artifact recall tops up namespace fetch when stale sources are filtered", async () => {
  const memoryDir = tmpDir("engram-artifact-topup");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  const calls: number[] = [];
  const mkArtifact = (id: string, sourceMemoryId?: string) => ({
    path: `/tmp/memory/artifacts/${id}.md`,
    content: id,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-21T00:00:00.000Z",
      updated: "2026-02-21T00:00:00.000Z",
      source: "artifact",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      sourceMemoryId,
    },
  });

  (orchestrator as any).storageRouter = {
    storageFor: async () => ({
      searchArtifacts: async (_query: string, maxResults: number) => {
        calls.push(maxResults);
        if (maxResults <= 10) {
          return Array.from({ length: maxResults }, (_, i) =>
            mkArtifact(`stale-${i + 1}`, `s${i + 1}`),
          );
        }
        return [
          mkArtifact("stale-1", "s1"),
          mkArtifact("stale-2", "s2"),
          mkArtifact("active-1", "a1"),
          mkArtifact("active-2", "a2"),
        ];
      },
    }),
  };
  (orchestrator as any).resolveArtifactSourceStatuses = async (_storage: any, ids: string[]) => {
    const map = new Map<string, "active" | "superseded" | "archived" | "missing">();
    for (const id of ids) {
      if (id.startsWith("a")) map.set(id, "active");
      else map.set(id, "superseded");
    }
    return map;
  };

  const results = await (orchestrator as any).fetchActiveArtifactsForNamespace("default", "artifact", 2);
  assert.equal(results.length, 2);
  assert.equal(results.every((m: any) => m.frontmatter.sourceMemoryId?.startsWith("a")), true);
  assert.equal(calls.length >= 2, true);
});

test("qmd fetch tops up when artifact-heavy window underfills non-artifact budget", async () => {
  const memoryDir = tmpDir("engram-qmd-topup");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  const qmdSearchCalls: number[] = [];
  const qmdHybridCalls: number[] = [];
  const mkResult = (path: string, score: number) => ({
    docid: path,
    path,
    snippet: path,
    score,
  });

  (orchestrator as any).qmd = {
    search: async (_query: string, _collection: any, maxResults: number) => {
      qmdSearchCalls.push(maxResults);
      if (maxResults <= 8) {
        return Array.from({ length: maxResults }, (_, i) =>
          mkResult(`/tmp/memory/artifacts/${String.fromCharCode(97 + i)}.md`, 1 - i * 0.001),
        );
      }
      return [
        mkResult("/tmp/memory/artifacts/a.md", 1.0),
        mkResult("/tmp/memory/artifacts/b.md", 0.99),
        mkResult("/tmp/memory/artifacts/c.md", 0.98),
        mkResult("/tmp/memory/facts/1.md", 0.97),
        mkResult("/tmp/memory/facts/2.md", 0.96),
        mkResult("/tmp/memory/facts/3.md", 0.95),
      ];
    },
    hybridSearch: async (_query: string, _collection: any, maxResults: number) => {
      qmdHybridCalls.push(maxResults);
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp("topic", 3, 8, {
    namespacesEnabled: false,
    recallNamespaces: [],
    resolveNamespace: () => "default",
  });
  assert.equal(results.length, 3);
  assert.equal(results.every((r: any) => !r.path.includes("/artifacts/")), true);
  assert.equal(qmdSearchCalls.length >= 2, true);
  assert.equal(qmdHybridCalls.length, 0);
});

test("qmd top-up returns best partial results after bounded attempts", async () => {
  const memoryDir = tmpDir("engram-qmd-topup-partial");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  const qmdSearchCalls: number[] = [];
  const qmdHybridCalls: number[] = [];
  const mkResult = (path: string, score: number) => ({
    docid: path,
    path,
    snippet: path,
    score,
  });

  (orchestrator as any).qmd = {
    search: async (_query: string, _collection: any, maxResults: number) => {
      qmdSearchCalls.push(maxResults);
      const artifacts = Array.from({ length: maxResults }, (_, i) =>
        mkResult(`/tmp/memory/artifacts/${i + 1}.md`, 1 - i * 0.0001),
      );
      return [...artifacts, mkResult("/tmp/memory/facts/partial.md", 0.25)];
    },
    hybridSearch: async (_query: string, _collection: any, maxResults: number) => {
      qmdHybridCalls.push(maxResults);
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp("topic", 300, 30, {
    namespacesEnabled: false,
    recallNamespaces: [],
    resolveNamespace: () => "default",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.path, "/tmp/memory/facts/partial.md");
  assert.equal(qmdSearchCalls.length, 2);
  assert.equal(qmdHybridCalls.length, 0);
});

test("qmd top-up applies namespace filtering before cap", async () => {
  const memoryDir = tmpDir("engram-qmd-topup-namespace");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  const mkResult = (path: string, score: number) => ({
    docid: path,
    path,
    snippet: path,
    score,
  });

  (orchestrator as any).qmd = {
    search: async (_query: string, _collection: any, maxResults: number) => {
      if (maxResults <= 8) {
        return [
          mkResult("/tmp/memory/other/facts/a.md", 1.0),
          mkResult("/tmp/memory/other/facts/b.md", 0.99),
          mkResult("/tmp/memory/other/facts/c.md", 0.98),
          mkResult("/tmp/memory/other/facts/d.md", 0.975),
          mkResult("/tmp/memory/other/facts/e.md", 0.974),
          mkResult("/tmp/memory/other/facts/f.md", 0.973),
          mkResult("/tmp/memory/default/facts/1.md", 0.97),
          mkResult("/tmp/memory/default/facts/2.md", 0.96),
        ];
      }
      return [
        mkResult("/tmp/memory/other/facts/a.md", 1.0),
        mkResult("/tmp/memory/other/facts/b.md", 0.99),
        mkResult("/tmp/memory/other/facts/c.md", 0.98),
        mkResult("/tmp/memory/default/facts/1.md", 0.97),
        mkResult("/tmp/memory/default/facts/2.md", 0.96),
        mkResult("/tmp/memory/default/facts/3.md", 0.95),
      ];
    },
    hybridSearch: async (_query: string, _collection: any, maxResults: number) => {
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp("topic", 3, 8, {
    namespacesEnabled: true,
    recallNamespaces: ["default"],
    resolveNamespace: (path: string) => (path.includes("/default/") ? "default" : "other"),
  });

  assert.equal(results.length, 3);
  assert.equal(results.every((r: any) => r.path.includes("/default/")), true);
});

test("qmd top-up falls back to query when hybrid returns empty", async () => {
  const memoryDir = tmpDir("engram-qmd-topup-query-fallback-empty");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  let queryCalled = 0;
  const mkResult = (path: string, score: number) => ({
    docid: path,
    path,
    snippet: path,
    score,
  });

  (orchestrator as any).qmd = {
    hybridSearch: async () => [],
    search: async () => {
      queryCalled += 1;
      return [
        mkResult("/tmp/memory/artifacts/a.md", 0.99),
        mkResult("/tmp/memory/default/facts/1.md", 0.9),
        mkResult("/tmp/memory/default/facts/2.md", 0.89),
      ];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp("topic", 2, 8, {
    namespacesEnabled: true,
    recallNamespaces: ["default"],
    resolveNamespace: (path: string) => (path.includes("/default/") ? "default" : "other"),
  });

  assert.equal(queryCalled, 1);
  assert.equal(results.length, 2);
  assert.equal(results.every((r: any) => r.path.includes("/default/facts/")), true);
});

test("qmd top-up falls back to query after artifact-only hybrid window", async () => {
  const memoryDir = tmpDir("engram-qmd-topup-query-fallback-artifacts");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  let queryCalled = 0;
  const mkResult = (path: string, score: number) => ({
    docid: path,
    path,
    snippet: path,
    score,
  });

  (orchestrator as any).qmd = {
    hybridSearch: async (_query: string, _collection: any, maxResults: number) =>
      Array.from({ length: maxResults }, (_, i) => mkResult(`/tmp/memory/artifacts/${i + 1}.md`, 1 - i * 0.0001)),
    search: async () => {
      queryCalled += 1;
      return [
        mkResult("/tmp/memory/default/facts/a.md", 0.91),
        mkResult("/tmp/memory/default/facts/b.md", 0.9),
        mkResult("/tmp/memory/default/facts/c.md", 0.89),
      ];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp("topic", 2, 8, {
    namespacesEnabled: true,
    recallNamespaces: ["default"],
    resolveNamespace: (path: string) => (path.includes("/default/") ? "default" : "other"),
  });

  assert.equal(queryCalled, 1);
  assert.equal(results.length, 2);
  assert.equal(results.every((r: any) => r.path.includes("/default/facts/")), true);
});

test("recall does not fall back to archive when hot memory is empty", async () => {
  const memoryDir = tmpDir("engram-long-term-fallback");
  await mkdir(path.join(memoryDir, "archive", "2026-02-23"), { recursive: true });

  const archivedPath = path.join(memoryDir, "archive", "2026-02-23", "fact-archived-1.md");
  await writeFile(
    archivedPath,
    [
      "---",
      "id: fact-archived-1",
      "category: fact",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: archived",
      "---",
      "",
      "Historical API quota incident: the burst limiter failed when shard counts exceeded 64.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  const orchestrator = new Orchestrator(cfg);

  const context = await (orchestrator as any).recallInternal("What happened with burst limiter shard counts?", undefined);
  assert.doesNotMatch(context, /Long-Term Memories \(Fallback\)/);
  assert.doesNotMatch(context, /burst limiter failed/i);
});

test("archive-only cold fallback does not track an injected memory", async () => {
  const memoryDir = tmpDir("engram-long-term-pipeline");
  await mkdir(path.join(memoryDir, "archive", "2026-02-23"), { recursive: true });

  const archivedPath = path.join(memoryDir, "archive", "2026-02-23", "fact-archived-2.md");
  await writeFile(
    archivedPath,
    [
      "---",
      "id: fact-archived-2",
      "category: fact",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: archived",
      "---",
      "",
      "Legacy incident notes mention shard overflow behavior.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  const orchestrator = new Orchestrator(cfg);

  let boostCalled = 0;
  let tracked: string[] = [];
  let recalled: string[] = [];
  (orchestrator as any).boostSearchResults = async (results: any[]) => {
    boostCalled += 1;
    return results.map((r) => ({ ...r, score: r.score + 1 }));
  };
  (orchestrator as any).trackMemoryAccess = (ids: string[]) => {
    tracked = ids;
  };
  (orchestrator as any).lastRecall = {
    record: async (payload: { memoryIds: string[] }) => {
      recalled = payload.memoryIds;
    },
  };

  const context = await (orchestrator as any).recallInternal(
    "Do we have notes about shard overflow behavior?",
    "session-cold-pipeline",
  );

  assert.doesNotMatch(context, /Long-Term Memories \(Fallback\)/);
  assert.deepEqual(tracked, []);
  assert.deepEqual(recalled, []);
});

test("lifecycle stale filtering does not reopen archive fallback", async () => {
  const memoryDir = tmpDir("engram-long-term-lifecycle");
  await mkdir(path.join(memoryDir, "archive", "2026-02-23"), { recursive: true });

  const archivedPath = path.join(memoryDir, "archive", "2026-02-23", "fact-archived-3.md");
  await writeFile(
    archivedPath,
    [
      "---",
      "id: fact-archived-3",
      "category: fact",
      "created: 2025-01-01T00:00:00.000Z",
      "updated: 2025-01-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: archived",
      "lifecycleState: archived",
      "---",
      "",
      "Archived memory about shard migration edge cases.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  cfg.lifecyclePolicyEnabled = true;
  cfg.lifecycleFilterStaleEnabled = true;
  const orchestrator = new Orchestrator(cfg);

  const context = await (orchestrator as any).recallInternal("Any shard migration edge cases?", undefined);
  assert.doesNotMatch(context, /Long-Term Memories \(Fallback\)/);
  assert.doesNotMatch(context, /shard migration edge cases/i);
});

test("recall suppresses empty impression append when no memories are injected by default", async () => {
  const memoryDir = tmpDir("engram-empty-impression");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  const orchestrator = new Orchestrator(cfg);

  let recorded: Array<{ sessionKey: string; memoryIds: string[]; appendImpression?: boolean }> = [];
  (orchestrator as any).lastRecall = {
    record: async (payload: { sessionKey: string; memoryIds: string[]; appendImpression?: boolean }) => {
      recorded.push(payload);
    },
  };

  const context = await (orchestrator as any).recallInternal(
    "Please remember our QMD diagnostics.",
    "session-empty-impression",
  );

  assert.equal(context.includes("## Relevant Memories"), false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.sessionKey, "session-empty-impression");
  assert.deepEqual(recorded[0]?.memoryIds, []);
  assert.equal(recorded[0]?.appendImpression, false);
});

test("recall records empty impression when explicitly enabled", async () => {
  const memoryDir = tmpDir("engram-empty-impression-enabled");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  cfg.recordEmptyRecallImpressions = true;
  const orchestrator = new Orchestrator(cfg);

  let recorded: Array<{ sessionKey: string; memoryIds: string[]; appendImpression?: boolean }> = [];
  (orchestrator as any).lastRecall = {
    record: async (payload: { sessionKey: string; memoryIds: string[]; appendImpression?: boolean }) => {
      recorded.push(payload);
    },
  };

  const context = await (orchestrator as any).recallInternal(
    "Please remember our QMD diagnostics.",
    "session-empty-impression",
  );

  assert.equal(context.includes("## Relevant Memories"), false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.sessionKey, "session-empty-impression");
  assert.deepEqual(recorded[0]?.memoryIds, []);
  assert.equal(recorded[0]?.appendImpression, true);
});

test("recall records impressions when memories are injected even if empty impressions are disabled", async () => {
  const memoryDir = tmpDir("engram-non-empty-impression");
  await mkdir(path.join(memoryDir, "facts/2026-02-01"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "facts/2026-02-01/fact-1.md"),
    [
      "---",
      "id: fact-1",
      "category: fact",
      "created: 2026-02-01T00:00:00.000Z",
      "updated: 2026-02-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "---",
      "",
      "QMD diagnostics require a fallback memory impression test.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  cfg.recordEmptyRecallImpressions = false;
  const orchestrator = new Orchestrator(cfg);

  let recorded: Array<{ sessionKey: string; memoryIds: string[]; appendImpression?: boolean }> = [];
  (orchestrator as any).lastRecall = {
    record: async (payload: { sessionKey: string; memoryIds: string[]; appendImpression?: boolean }) => {
      recorded.push(payload);
    },
  };

  const context = await (orchestrator as any).recallInternal(
    "What do we know about QMD diagnostics?",
    "session-non-empty-impression",
  );

  assert.match(context, /QMD diagnostics require a fallback memory impression test/);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.sessionKey, "session-non-empty-impression");
  assert.deepEqual(recorded[0]?.memoryIds, ["fact-1"]);
  assert.equal(recorded[0]?.appendImpression, true);
});

test("recall does not append an empty impression when the shared budget admits no memories", async () => {
  const memoryDir = tmpDir("engram-budget-empty-impression");
  await mkdir(path.join(memoryDir, "facts/2026-02-01"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "facts/2026-02-01/fact-budget.md"),
    [
      "---",
      "id: fact-budget",
      "category: fact",
      "created: 2026-02-01T00:00:00.000Z",
      "updated: 2026-02-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "---",
      "",
      "This memory is intentionally excluded by the tiny shared budget.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = false;
  cfg.recallBudgetChars = 30;
  cfg.recordEmptyRecallImpressions = false;
  const orchestrator = new Orchestrator(cfg);

  let recorded: Array<{ sessionKey: string; memoryIds: string[]; appendImpression?: boolean }> = [];
  (orchestrator as any).lastRecall = {
    record: async (payload: { sessionKey: string; memoryIds: string[]; appendImpression?: boolean }) => {
      recorded.push(payload);
    },
  };

  const context = await (orchestrator as any).recallInternal(
    "What do we know about the tiny budget?",
    "session-budget-empty-impression",
  );

  assert.doesNotMatch(context, /## Relevant Memories/);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]?.memoryIds, []);
  assert.equal(recorded[0]?.appendImpression, false);
});

test("recall rejects unreadable namespace overrides before fetching memories", async () => {
  const memoryDir = tmpDir("engram-namespace-override-guard");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  cfg.namespacesEnabled = true;
  cfg.defaultNamespace = "global";
  cfg.defaultRecallNamespaces = ["self"];
  cfg.namespacePolicies = [
    {
      name: "project-x",
      readPrincipals: ["project-x"],
      writePrincipals: ["project-x"],
    },
    {
      name: "secret-team",
      readPrincipals: ["secret-team"],
      writePrincipals: ["secret-team"],
    },
  ];
  const orchestrator = new Orchestrator(cfg);

  let storageRouterTouched = false;
  (orchestrator as any).storageRouter = {
    storageFor: async () => {
      storageRouterTouched = true;
      throw new Error("storageFor should not run for unreadable namespace overrides");
    },
  };

  await assert.rejects(
    () => (orchestrator as any).recallInternal(
      "Need namespace-guard coverage.",
      "agent:project-x:chat",
      { namespace: "secret-team" },
    ),
    /namespace override is not readable: secret-team/,
  );
  assert.equal(storageRouterTouched, false);
});

test("recall accepts readable namespace overrides even when they are excluded from default recall routing", async () => {
  const memoryDir = tmpDir("engram-namespace-override-allowed");
  await mkdir(memoryDir, { recursive: true });

  const cfg = baseConfig(memoryDir);
  cfg.namespacesEnabled = true;
  cfg.defaultNamespace = "global";
  cfg.defaultRecallNamespaces = ["self"];
  cfg.namespacePolicies = [
    {
      name: "project-x",
      readPrincipals: ["project-x"],
      writePrincipals: ["project-x"],
    },
    {
      name: "audit-log",
      readPrincipals: ["project-x"],
      writePrincipals: ["audit-bot"],
      includeInRecallByDefault: false,
    },
  ];
  const orchestrator = new Orchestrator(cfg);

  let storageRouterTouched = false;
  (orchestrator as any).storageRouter = {
    storageFor: async () => {
      storageRouterTouched = true;
      throw new Error("storageFor should not run for no_recall");
    },
  };

  const out = await (orchestrator as any).recallInternal(
    "ok",
    "agent:project-x:chat",
    { namespace: "audit-log" },
  );

  assert.equal(out, "");
  assert.equal(storageRouterTouched, false);
});

test("cold fallback uses configured cold QMD collection before archive scan", async () => {
  const memoryDir = tmpDir("engram-cold-qmd");
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  const coldMemoryPath = path.join(factsDir, "fact-cold-qmd-1.md");
  await writeFile(
    coldMemoryPath,
    [
      "---",
      "id: fact-cold-qmd-1",
      "category: fact",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: active",
      "---",
      "",
      "Cold collection memory about shard migration edge cases.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const cfg = baseConfig(memoryDir);
  cfg.recallPlannerEnabled = false;
  cfg.qmdEnabled = true;
  (cfg as any).qmdColdTierEnabled = true;
  (cfg as any).qmdColdCollection = "openclaw-engram-cold";
  (cfg as any).qmdColdMaxResults = 3;
  const orchestrator = new Orchestrator(cfg);

  const calls: Array<{ collection?: string; maxResults?: number }> = [];
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async (_query: string, collection?: string, maxResults?: number) => {
      calls.push({ collection, maxResults });
      if (collection === "openclaw-engram-cold") {
        return [
          {
            docid: "fact-cold-qmd-1",
            path: coldMemoryPath,
            snippet: "Cold collection memory about shard migration edge cases",
            score: 0.91,
          },
        ];
      }
      return [];
    },
    search: async () => [],
  };

  const context = await (orchestrator as any).recallInternal("Any shard migration edge cases?", "s-cold-qmd");
  assert.match(context, /Long-Term Memories \(Fallback\)/);
  assert.match(context, /Cold collection memory about shard migration edge cases/i);
  assert.equal(calls.some((c) => c.collection === "openclaw-engram-cold"), true);
});
