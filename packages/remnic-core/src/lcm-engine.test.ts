import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LcmEngine } from "./lcm/engine.js";
import { openLcmDatabase } from "./lcm/schema.js";
import type { PluginConfig } from "./types.js";

function createPluginConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    model: "test-model",
    reasoningEffort: "none",
    triggerMode: "smart",
    bufferMaxTurns: 10,
    bufferMaxMinutes: 10,
    consolidateEveryN: 10,
    highSignalPatterns: [],
    maxMemoryTokens: 2048,
    qmdEnabled: false,
    qmdCollection: "test",
    qmdMaxResults: 5,
    qmdTierMigrationEnabled: false,
    qmdTierDemotionMinAgeDays: 30,
    qmdTierDemotionValueThreshold: 0.1,
    qmdTierPromotionValueThreshold: 0.9,
    qmdTierParityGraphEnabled: false,
    qmdTierParityHiMemEnabled: false,
    qmdTierAutoBackfillEnabled: false,
    embeddingFallbackEnabled: false,
    embeddingFallbackProvider: "auto",
    openaiApiKey: undefined,
    openaiBaseUrl: undefined,
    debug: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    identityInjectionMode: "minimal",
    identityMaxInjectChars: 0,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 30,
    workspaceDir: memoryDir,
    captureMode: "implicit",
    agentAccessHttp: {
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024,
    },
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 1,
    boostAccessCount: false,
    recordEmptyRecallImpressions: false,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 0,
    queryExpansionMinTokenLen: 0,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 0,
    rerankTimeoutMs: 0,
    rerankCacheEnabled: false,
    rerankCacheTtlMs: 0,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0,
    negativeExamplesPenaltyCap: 0,
    chunkingEnabled: false,
    chunkingTargetTokens: 0,
    chunkingMinTokens: 0,
    chunkingOverlapSentences: 0,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0,
    contradictionMinConfidence: 0,
    contradictionAutoResolve: false,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 0,
    summarizationEnabled: false,
    summarizationTriggerCount: 0,
    summarizationRecentToKeep: 0,
    summarizationImportanceThreshold: 0,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 0,
    transcriptEnabled: false,
    transcriptRetentionDays: 0,
    transcriptSkipChannelTypes: [],
    transcriptRecallHours: 0,
    maxTranscriptTurns: 0,
    maxTranscriptTokens: 0,
    checkpointEnabled: false,
    checkpointTurns: 0,
    compactionResetEnabled: false,
    hourlySummariesEnabled: false,
    daySummaryEnabled: false,
    hourlySummaryCronAutoRegister: false,
    nightlyGovernanceCronAutoRegister: false,
    summaryRecallHours: 0,
    maxSummaryCount: 0,
    summaryModel: "test-model",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 0,
    conversationIndexEnabled: false,
    lcmEnabled: true,
    lcmLeafBatchSize: 1,
    lcmRollupFanIn: 4,
    lcmFreshTailTurns: 16,
    lcmMaxDepth: 5,
    lcmDeterministicMaxTokens: 128,
    lcmTelemetryPrefilterEnabled: true,
    lcmArchiveRetentionDays: 90,
    lcmRecallBudgetShare: 0.15,
    lcmObserveConcurrency: 1,
    messagePartsEnabled: true,
    messagePartsRecallMaxResults: 6,
  } as unknown as PluginConfig;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("LCM deterministically compresses mechanical telemetry without calling the summarizer", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-telemetry-prefilter-"),
  );
  let summarizeCalls = 0;

  try {
    const engine = new LcmEngine(
      {
        ...createPluginConfig(memoryDir),
        lcmLeafBatchSize: 8,
      } as PluginConfig,
      async () => {
        summarizeCalls += 1;
        throw new Error("summarizer should not run for mechanical telemetry");
      },
    );

    await engine.observeMessages("session-telemetry", [
      { role: "user", content: "[Action 1]: right" },
      { role: "assistant", content: "[Observation 1]: baba moved right" },
      { role: "user", content: "[Action 2]: up" },
      { role: "assistant", content: "[Observation 2]: wall blocks the path" },
      { role: "user", content: "[Action 3]: left" },
      { role: "assistant", content: "[Observation 3]: baba moved left" },
      { role: "user", content: "[Action 4]: wait" },
      { role: "assistant", content: "[Observation 4]: state unchanged" },
    ]);
    await engine.waitForSessionObserveIdle("session-telemetry");

    assert.equal(summarizeCalls, 0);
    const summary = await engine.describeContext("session-telemetry", 0, 0);
    assert.match(summary?.summary ?? "", /\[Action 1\]/);
    assert.equal(summary?.depth, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("LCM keeps semantic summarization when telemetry contains durable cues", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-telemetry-durable-cue-"),
  );
  let summarizeCalls = 0;

  try {
    const engine = new LcmEngine(
      {
        ...createPluginConfig(memoryDir),
        lcmLeafBatchSize: 8,
      } as PluginConfig,
      async () => {
        summarizeCalls += 1;
        return "semantic durable summary";
      },
    );

    await engine.observeMessages("session-telemetry", [
      { role: "user", content: "[Action 1]: right" },
      { role: "assistant", content: "[Observation 1]: remember this route preference" },
      { role: "user", content: "[Action 2]: up" },
      { role: "assistant", content: "[Observation 2]: wall blocks the path" },
      { role: "user", content: "[Action 3]: left" },
      { role: "assistant", content: "[Observation 3]: baba moved left" },
      { role: "user", content: "[Action 4]: wait" },
      { role: "assistant", content: "[Observation 4]: state unchanged" },
    ]);
    await engine.waitForSessionObserveIdle("session-telemetry");

    assert.equal(summarizeCalls, 1);
    const summary = await engine.describeContext("session-telemetry", 0, 0);
    assert.equal(summary?.summary, "semantic durable summary");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observeMessages resolves before summarize finishes and background worker persists results", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-engine-"));
  const summarizeStarted = deferred<void>();
  const releaseSummarize = deferred<void>();
  let summarizeCalls = 0;

  try {
    const engine = new LcmEngine(
      createPluginConfig(memoryDir),
      async (text, targetTokens, aggressive) => {
        summarizeCalls += 1;
        summarizeStarted.resolve();
        await releaseSummarize.promise;
        return `summary:${aggressive ? "aggressive" : "normal"}:${targetTokens}:${text.length}`;
      },
    );

    const observePromise = engine.observeMessages("session-1", [
      { role: "user", content: "hello queued world" },
    ]);
    await observePromise;

    await summarizeStarted.promise;
    assert.equal(engine.observeQueueInFlightCount, 1);

    const beforeRelease = await engine.searchContextFull(
      "hello",
      10,
      "session-1",
    );
    assert.equal(beforeRelease.length, 1);
    assert.equal(
      beforeRelease[0]?.content.includes("hello queued world"),
      true,
    );

    releaseSummarize.resolve();
    await engine.waitForObserveQueueIdle();

    assert.equal(summarizeCalls, 1);
    assert.equal(engine.observeQueueInFlightCount, 0);
    assert.equal(engine.observeQueueDepth, 0);

    const afterRelease = await engine.searchContextFull(
      "queued",
      10,
      "session-1",
    );
    assert.equal(afterRelease.length, 1);

    const summary = await engine.describeContext("session-1", 0, 0);
    assert.equal(summary?.summary.startsWith("summary:"), true);
    assert.equal(summary?.turn_count, 1);
    assert.equal(summary?.depth, 0);
  } finally {
    releaseSummarize.resolve();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observe queue honors configured concurrency across sessions", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-engine-concurrency-"),
  );
  const releaseSummaries = deferred<void>();
  const twoSummariesStarted = deferred<void>();
  const startedFor = new Set<string>();

  try {
    const engine = new LcmEngine(
      {
        ...createPluginConfig(memoryDir),
        lcmObserveConcurrency: 2,
      },
      async (text) => {
        if (text.includes("alpha")) {
          startedFor.add("session-1");
        }
        if (text.includes("bravo")) {
          startedFor.add("session-2");
        }
        if (startedFor.size === 2) {
          twoSummariesStarted.resolve();
        }
        await releaseSummaries.promise;
        return "summary";
      },
    );

    await engine.observeMessages("session-1", [
      { role: "user", content: "alpha" },
    ]);
    await engine.observeMessages("session-2", [
      { role: "user", content: "bravo" },
    ]);

    await twoSummariesStarted.promise;
    assert.equal(engine.observeQueueInFlightCount, 2);

    releaseSummaries.resolve();
    await engine.waitForObserveQueueIdle();

    assert.deepEqual([...startedFor].sort(), ["session-1", "session-2"]);
    assert.equal(engine.observeQueueInFlightCount, 0);
    assert.equal(engine.observeQueueDepth, 0);
  } finally {
    releaseSummaries.resolve();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("waitForSessionObserveIdle waits for deferred enqueue registration", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-engine-init-gap-"),
  );
  const summarizeStarted = deferred<void>();
  const releaseSummarize = deferred<void>();

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      summarizeStarted.resolve();
      await releaseSummarize.promise;
      return "summary";
    });

    await engine.ensureInitialized();

    engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "queued after init" },
    ]);

    let sessionIdleResolved = false;
    const sessionIdlePromise = engine
      .waitForSessionObserveIdle("session-1")
      .then(() => {
        sessionIdleResolved = true;
      });

    await Promise.resolve();
    await Promise.resolve();
    await summarizeStarted.promise;

    assert.equal(sessionIdleResolved, false);

    releaseSummarize.resolve();
    await sessionIdlePromise;
    assert.equal(sessionIdleResolved, true);
  } finally {
    releaseSummarize.resolve();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("waitForSessionObserveIdle resolves once the target session drains even if other work remains", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-engine-session-idle-"),
  );
  const summarizeStarted = deferred<void>();
  const releaseSummarize = deferred<void>();
  let firstSession = true;

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      if (firstSession) {
        firstSession = false;
        summarizeStarted.resolve();
        await releaseSummarize.promise;
      }
      return "summary";
    });

    await engine.observeMessages("session-1", [
      { role: "user", content: "first" },
    ]);
    await summarizeStarted.promise;
    await engine.observeMessages("session-2", [
      { role: "user", content: "second" },
    ]);

    let sessionOneIdle = false;
    const sessionOneIdlePromise = engine
      .waitForSessionObserveIdle("session-1")
      .then(() => {
        sessionOneIdle = true;
      });

    await Promise.resolve();
    assert.equal(sessionOneIdle, false);

    releaseSummarize.resolve();
    await sessionOneIdlePromise;

    assert.equal(sessionOneIdle, true);
    assert.ok(
      engine.observeQueueInFlightCount > 0 || engine.observeQueueDepth > 0,
    );
    await engine.waitForObserveQueueIdle();
  } finally {
    releaseSummarize.resolve();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("LCM normalizes session IDs across observe, stats, and clear", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-session-normalize-"),
  );

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      return "summary";
    });

    await engine.observeMessages("  session-normalized  ", [
      { role: "user", content: "normalization marker alpha" },
    ]);
    await engine.waitForSessionObserveIdle("session-normalized");

    assert.equal((await engine.getStats("session-normalized")).totalMessages, 1);
    assert.equal((await engine.getStats("  session-normalized  ")).totalMessages, 1);
    assert.equal(
      (await engine.searchContextFull(
        "normalization",
        10,
        "session-normalized",
      )).length,
      1,
    );

    await engine.clearSession("  session-normalized  ");

    assert.equal((await engine.getStats("session-normalized")).totalMessages, 0);
    assert.equal(
      (await engine.searchContextFull(
        "normalization",
        10,
        "session-normalized",
      )).length,
      0,
    );

    await engine.observeMessages("   ", [
      { role: "user", content: "blank session should be ignored" },
    ]);
    await engine.waitForObserveQueueIdle();
    assert.equal((await engine.getStats()).totalMessages, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("close prevents deferred observe work from reinitializing the engine", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-engine-close-"),
  );

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      return "summary";
    });

    await engine.ensureInitialized();
    engine.close();

    await (engine as any).processObserveMessages("session-1", [
      { role: "user", content: "should not reopen" },
    ]);

    assert.equal((engine as any).db, null);
    assert.equal((engine as any).archive, null);
    assert.equal((engine as any).dag, null);
    assert.equal((engine as any).summarizer, null);
    assert.equal((engine as any).observeQueue, null);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observeMessages stores structured message parts and file-aware recall finds them", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-message-parts-"),
  );

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      return "summary";
    });

    await engine.observeMessages("session-1", [
      {
        role: "assistant",
        content: "Edited src/auth.ts to repair the login flow.",
        parts: [],
        rawContent: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { path: "src/auth.ts" },
            },
          ],
        },
        sourceFormat: "anthropic",
      },
    ]);
    await engine.waitForSessionObserveIdle("session-1");

    const matches = await engine.searchStructuredParts(
      "session-1",
      "what changed in src/auth.ts.",
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.file_path, "src/auth.ts");
    assert.equal(matches[0]!.kind, "file_write");

    const section = engine.formatStructuredRecall(matches, 1000);
    assert.match(section, /Structured Session Matches/);
    assert.match(section, /src\/auth\.ts/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observeMessages derives message parts from content when rawContent is absent", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-message-parts-content-"),
  );

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      return "summary";
    });

    await engine.observeMessages("session-1", [
      {
        role: "assistant",
        content: "Reviewed packages/remnic-core/src/auth.ts for the login fix.",
      },
    ]);
    await engine.observeMessages("session-2", [
      {
        role: "assistant",
        content: "Reviewed packages/remnic-core/src/other.ts for a different fix.",
      },
    ]);
    await engine.waitForSessionObserveIdle("session-1");
    await engine.waitForSessionObserveIdle("session-2");

    const matches = await engine.searchStructuredParts(
      "session-1",
      "what happened in packages/remnic-core/src/auth.ts",
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.session_id, "session-1");
    assert.equal(matches[0]!.file_path, "packages/remnic-core/src/auth.ts");
    assert.equal(matches[0]!.kind, "file_read");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observeMessages does not capture message parts when disabled", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-message-parts-disabled-"),
  );

  try {
    const engine = new LcmEngine(
      {
        ...createPluginConfig(memoryDir),
        messagePartsEnabled: false,
      } as PluginConfig,
      async () => {
        return "summary";
      },
    );

    await engine.observeMessages("session-1", [
      {
        role: "assistant",
        content: "Reviewed packages/remnic-core/src/auth.ts for the login fix.",
        rawContent: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { path: "packages/remnic-core/src/auth.ts" },
            },
          ],
        },
        sourceFormat: "anthropic",
      },
    ]);
    await engine.waitForSessionObserveIdle("session-1");

    const db = openLcmDatabase(memoryDir);
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM lcm_message_parts")
        .get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("observeMessages preserves snake_case normalized part metadata", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-lcm-message-parts-snake-"),
  );

  try {
    const engine = new LcmEngine(createPluginConfig(memoryDir), async () => {
      return "summary";
    });

    await engine.observeMessages("session-1", [
      {
        role: "assistant",
        content: "Edited src/config.ts.",
        parts: [
          {
            kind: "file_write",
            payload: { path: "src/config.ts" },
            tool_name: "Edit",
            file_path: "src/config.ts",
          },
        ],
      },
    ]);
    await engine.waitForSessionObserveIdle("session-1");

    const matches = await engine.searchStructuredParts(
      "session-1",
      "what changed in src/config.ts",
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.file_path, "src/config.ts");
    assert.equal(matches[0]!.tool_name, "Edit");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
