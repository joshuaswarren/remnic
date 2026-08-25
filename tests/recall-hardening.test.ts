import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "@remnic/core/orchestrator";
import { parseConfig } from "@remnic/core/config";
import type { RecallSectionBuckets } from "@remnic/core/orchestration/recall-section-coordinator";
import {
  buildQmdRecallCacheKey,
  clearQmdRecallCache,
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "@remnic/core/qmd-recall-cache";

async function makeOrchestrator(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

function runtimeQmdFetchLimit(
  orchestrator: Orchestrator,
  mode: "full" | "minimal" | "no_recall" = "full",
): number {
  const config = (orchestrator as any).config;
  const baseRecallResultLimit =
    mode === "no_recall"
      ? 0
      : mode === "minimal"
        ? Math.max(
            0,
            Math.min(
              config.qmdMaxResults,
              config.recallPlannerMaxQmdResultsMinimal,
            ),
          )
        : config.qmdMaxResults;
  const memoriesSectionEnabled = (orchestrator as any).isRecallSectionEnabled(
    "memories",
  );
  const memorySectionMaxResults = (orchestrator as any).getRecallSectionNumber(
    "memories",
    "maxResults",
  );
  const recallResultLimit = memoriesSectionEnabled
    ? memorySectionMaxResults !== undefined
      ? Math.min(baseRecallResultLimit, memorySectionMaxResults)
      : baseRecallResultLimit
    : 0;
  const recallHeadroom = config.verbatimArtifactsEnabled
    ? Math.max(12, config.verbatimArtifactsMaxRecall * 4)
    : 12;
  return recallResultLimit === 0
    ? 0
    : Math.max(
        recallResultLimit,
        Math.min(200, recallResultLimit + recallHeadroom),
  );
}

test("recall rejects missing principals before namespace-enabled retrieval", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-auth-", {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    principalFromSessionKeyMode: "disabled",
    principalFromSessionKeyRules: [],
  });

  await assert.rejects(
    () => orchestrator.recall("namespace search", undefined),
    /authentication required/,
  );
});

test("assembleRecallSections preserves memories within the recall budget", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-", {
    recallBudgetChars: 220,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });

  const sectionBuckets = new Map<string, string[]>();
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "profile",
    `## User Profile\n\n${"Profile detail ".repeat(30)}`,
  );
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories\n\n- Shared incident context survived the assembly budget.",
  );

  const assembled = (orchestrator as any).assembleRecallSections(
    sectionBuckets,
  );
  const context = assembled.sections.join("\n\n---\n\n");

  assert.equal(assembled.includedIds.includes("memories"), true);
  assert.equal(assembled.truncated, true);
  assert.match(context, /Relevant Memories/);
  assert.ok(context.length <= 220);
});

test("assembleRecallSections allocates budget in configured pipeline order", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-pipeline-order-", {
    recallBudgetChars: 80,
    recallProfileMaxRatio: 1,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(40),
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(25),
    { atomic: true, memoryId: "memory-pipeline", memoryPath: "facts/pipeline.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.includedIds, ["profile", "memories"]);
  assert.deepEqual(assembled.omittedIds, []);
  assert.deepEqual(assembled.includedMemoryIds, ["memory-pipeline"]);
  assert.equal(assembled.includedMemoryPaths[0], "facts/pipeline.md");
  assert.match(assembled.sections.join("\n\n---\n\n"), /M{25}/);
  assert.doesNotMatch(assembled.sections.join("\n\n---\n\n"), /Relevant Memories/);
  assert.ok(assembled.finalChars <= 80);
});

test("assembleRecallSections applies memory reservations before section caps", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-reservation-", {
    recallBudgetChars: 4000,
    recallPipeline: [
      { id: "profile", enabled: true, maxChars: 500 },
      { id: "memories", enabled: true },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(500),
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(900),
    { atomic: true, memoryId: "memory-reserved", memoryPath: "facts/reserved.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.includedIds, ["profile", "memories"]);
  assert.deepEqual(assembled.omittedIds, []);
  assert.deepEqual(assembled.includedMemoryIds, ["memory-reserved"]);
});

test("assembleRecallSections does not omit earlier sections when protected sections will truncate anyway", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-tight-", {
    recallBudgetChars: 60,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });

  const sectionBuckets = new Map<string, string[]>();
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(50),
  );
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(50),
  );

  const assembled = (orchestrator as any).assembleRecallSections(
    sectionBuckets,
  );
  const context = assembled.sections.join("\n\n---\n\n");

  assert.deepEqual(assembled.includedIds, ["profile", "memories"]);
  assert.equal(assembled.omittedIds.length, 0);
  assert.equal(assembled.truncated, true);
  assert.ok(context.length <= 60);
});

test("assembleRecallSections reports included and omitted memory metadata", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-metadata-", {
    recallBudgetChars: 55,
    recallPipeline: [{ id: "memories", enabled: true }],
  });

  const sectionBuckets: RecallSectionBuckets = new Map();
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "first memory",
    { atomic: true, memoryId: "memory-first", memoryPath: "facts/first.md" },
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "second memory that exceeds the remaining budget",
    { atomic: true, memoryId: "memory-second", memoryPath: "facts/second.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.includedMemoryIds, ["memory-first"]);
  assert.deepEqual(assembled.includedMemoryPaths, ["facts/first.md"]);
  assert.deepEqual(assembled.omittedMemoryIds, ["memory-second"]);
});

test("assembleRecallSections keeps earlier atomic memories ahead of later helper text", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-atomic-order-", {
    recallBudgetChars: 80,
    recallPipeline: [{ id: "memories", enabled: true }],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "atomic memory",
    { atomic: true, memoryId: "memory-atomic", memoryPath: "facts/atomic.md" },
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Retrieval Feedback Helper\n\nThis later helper must not starve the memory.",
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );
  const context = assembled.sections.join("\n\n---\n\n");

  assert.match(context, /atomic memory/);
  assert.doesNotMatch(context, /Retrieval Feedback Helper/);
  assert.deepEqual(assembled.includedMemoryIds, ["memory-atomic"]);
});

test("assembleRecallSections keeps later helper text when no atomic memory fits", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-helper-fallback-", {
    recallBudgetChars: 70,
    recallPipeline: [{ id: "memories", enabled: true }],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "A".repeat(100),
    { atomic: true, memoryId: "memory-too-large", memoryPath: "facts/too-large.md" },
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "Retrieval Feedback Helper",
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.match(assembled.sections.join("\n\n---\n\n"), /Retrieval Feedback Helper/);
  assert.doesNotMatch(assembled.sections.join("\n\n---\n\n"), /## Relevant Memories/);
  assert.deepEqual(assembled.includedMemoryIds, []);
  assert.deepEqual(assembled.omittedMemoryIds, ["memory-too-large"]);
});


test("assembleRecallSections uses the profile truncation marker at the shared budget boundary", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-profile-boundary-", {
    recallBudgetChars: 140,
    recallProfileMaxRatio: 0.8,
    recallPipeline: [
      { id: "memories", enabled: true },
      { id: "profile", enabled: true },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "memory content that consumes part of the budget",
    { atomic: true, memoryId: "memory-budget", memoryPath: "facts/budget.md" },
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    `${"profile line\n".repeat(20)}`,
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );
  const context = assembled.sections.join("\n\n---\n\n");

  assert.match(context, /\.\.\.\(profile context trimmed\)/);
  assert.doesNotMatch(context, /\.\.\.\(memory context trimmed\)/);
});

test("recall aborts the in-flight pipeline when the outer timeout fires", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-timeout-");
  let observedAbortSignal: AbortSignal | undefined;
  const callerAbortController = new AbortController();
  (orchestrator as any).initPromise = null;
  (orchestrator as any).recallInternal = async (
    _prompt: string,
    _sessionKey?: string,
    options: { abortSignal?: AbortSignal } = {},
  ) =>
    await new Promise<string>((_resolve, reject) => {
      observedAbortSignal = options.abortSignal;
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          const err = new Error("recall aborted");
          Object.defineProperty(err, "name", { value: "AbortError" });
          reject(err);
        },
        { once: true },
      );
    });

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: any[]
  ) =>
    originalSetTimeout(
      handler,
      timeout === 75_000 ? 5 : timeout,
      ...args,
    )) as typeof setTimeout;

  try {
    const result = await orchestrator.recall(
      "timeout test",
      "agent:test:timeout",
      {
        abortSignal: callerAbortController.signal,
      },
    );
    assert.equal(result, "");
    assert.ok(observedAbortSignal);
    assert.notEqual(observedAbortSignal, callerAbortController.signal);
    assert.equal(observedAbortSignal?.aborted, true);
    assert.equal(callerAbortController.signal.aborted, false);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("recall propagates an already-aborted external signal to the inner controller", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-preaborted-");
  const callerAbortController = new AbortController();
  callerAbortController.abort();

  let observedAbortSignal: AbortSignal | undefined;
  (orchestrator as any).initPromise = null;
  (orchestrator as any).recallInternal = async (
    _prompt: string,
    _sessionKey?: string,
    options: { abortSignal?: AbortSignal } = {},
  ) => {
    observedAbortSignal = options.abortSignal;
    throw new Error("should not reach active recall work");
  };

  const result = await orchestrator.recall(
    "pre-aborted test",
    "agent:test:preaborted",
    {
      abortSignal: callerAbortController.signal,
    },
  );

  assert.equal(result, "");
  assert.ok(observedAbortSignal);
  assert.notEqual(observedAbortSignal, callerAbortController.signal);
  assert.equal(observedAbortSignal?.aborted, true);
});

test("recall aborts while waiting on the init gate", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-init-gate-abort-");
  const callerAbortController = new AbortController();
  let recallInternalCalled = false;
  (orchestrator as any).initPromise = new Promise<void>(() => {});
  (orchestrator as any).recallInternal = async () => {
    recallInternalCalled = true;
    return "should not run";
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: any[]
  ) =>
    originalSetTimeout(
      handler,
      timeout === 15_000 ? 100 : timeout,
      ...args,
    )) as typeof setTimeout;

  try {
    const startedAt = Date.now();
    const recallPromise = orchestrator.recall(
      "init gate abort test",
      "agent:test:init-gate",
      {
        abortSignal: callerAbortController.signal,
      },
    );
    setTimeout(() => callerAbortController.abort(), 5);

    const result = await recallPromise;
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result, "");
    assert.equal(recallInternalCalled, false);
    assert.ok(
      elapsedMs < 80,
      `expected init gate abort before timeout fallback, saw ${elapsedMs}ms`,
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("cold fallback abort stops before its query-aware step", async () => {
  const orchestrator = await makeOrchestrator("engram-cold-fallback-abort-", {
    qmdColdTierEnabled: true,
    qmdEnabled: true,
  });
  const callerAbortController = new AbortController();
  callerAbortController.abort();

  let queryAwareFallbackCalls = 0;
  (orchestrator as any).qmd = { isAvailable: () => true };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [];
  (orchestrator as any).searchQueryAwareFallback = async () => {
    queryAwareFallbackCalls += 1;
    return [];
  };

  await assert.rejects(
    (orchestrator as any).applyColdFallbackPipeline({
      prompt: "fallback abort test",
      recallNamespaces: ["default"],
      recallResultLimit: 5,
      recallMode: "minimal",
      abortSignal: callerAbortController.signal,
    }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(queryAwareFallbackCalls, 0);
});

test("recallInternal aborts while phase-one preamble promises are still pending", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-phase-one-abort-");
  const callerAbortController = new AbortController();
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context";
  // Deterministic handshake instead of a wall-clock poll: the stub signals when
  // the preamble read has started, and never completes until this test releases
  // it. A time budget here only measured machine load (issue #2300).
  let releaseSharedRead: (() => void) | null = null;
  let sharedReadCompleted = false;
  let signalSharedReadStarted: (() => void) | null = null;
  const sharedReadStarted = new Promise<void>((resolve) => {
    signalSharedReadStarted = resolve;
  });
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      signalSharedReadStarted?.();
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      sharedReadCompleted = true;
      return "slow priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "phase one abort test",
    "agent:test:phase-one",
    {
      mode: "full",
      abortSignal: callerAbortController.signal,
    },
  );

  await sharedReadStarted;
  try {
    callerAbortController.abort();

    await assert.rejects(
      recallPromise,
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );

    // The contract, stated directly: the abort surfaced without waiting for the
    // preamble, which is still pending because only this test can release it.
    assert.equal(sharedReadCompleted, false, "recall rejected while the preamble read was still pending");
  } finally {
    // Always release: a failing assertion must not leave the stubbed read
    // pending and its promise unsettled for the rest of the run.
    const release = releaseSharedRead as (() => void) | null;
    release?.();
  }
});
test("recallInternal forwards abort to each phase-one shared-context read", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-phase-one-cancel-");
  const callerAbortController = new AbortController();
  type SharedContextReadSurface = {
    readPriorities: (signal?: AbortSignal) => Promise<string>;
    readLatestRoundtable: (signal?: AbortSignal) => Promise<string>;
    readLatestCrossSignals: (signal?: AbortSignal) => Promise<string>;
  };
  type RecallInternalHarness = {
    isRecallSectionEnabled: (id: string) => boolean;
    sharedContext: SharedContextReadSurface;
    recallInternal: (
      prompt: string,
      sessionKey: string,
      options: { mode: "full"; abortSignal: AbortSignal },
    ) => Promise<unknown>;
  };
  const harness = orchestrator as unknown as RecallInternalHarness;
  harness.isRecallSectionEnabled = (id: string) => id === "shared-context";

  let readsStarted = 0;
  let readsCancelled = 0;
  let resolveReadsStarted: (() => void) | null = null;
  const allReadsStarted = new Promise<void>((resolve) => {
    resolveReadsStarted = resolve;
  });
  const cancelledRead = (signal?: AbortSignal): Promise<string> =>
    new Promise<string>((_resolve, reject) => {
      assert.ok(signal);
      readsStarted += 1;
      if (readsStarted === 3) resolveReadsStarted?.();
      signal.addEventListener(
        "abort",
        () => {
          readsCancelled += 1;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  harness.sharedContext = {
    readPriorities: cancelledRead,
    readLatestRoundtable: cancelledRead,
    readLatestCrossSignals: cancelledRead,
  };

  const recallPromise = harness.recallInternal(
    "phase one cancellation test",
    "agent:test:phase-one-cancel",
    {
      mode: "full",
      abortSignal: callerAbortController.signal,
    },
  );

  await allReadsStarted;
  callerAbortController.abort();

  await assert.rejects(
    recallPromise,
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(readsCancelled, 3);
});

test("recallInternal does not launch phase-one preamble work for an already-aborted signal", async () => {
  const orchestrator = await makeOrchestrator(
    "engram-recall-phase-one-preaborted-",
  );
  const callerAbortController = new AbortController();
  callerAbortController.abort();

  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context";
  let sharedReadStarted = false;
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      sharedReadStarted = true;
      return "should not run";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };

  await assert.rejects(
    (orchestrator as any).recallInternal(
      "phase one pre-aborted test",
      "agent:test:phase-one-preaborted",
      {
        mode: "full",
        abortSignal: callerAbortController.signal,
      },
    ),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );

  assert.equal(sharedReadStarted, false);
});

test("recallInternal fails open when qmd enrichment rejects before phase-two assembly", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-qmd-fail-open-", {
    qmdEnabled: true,
  });

  let releaseSharedRead: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "qmd";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => {
    throw new Error("qmd fetch exploded");
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-fail-open",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const release = releaseSharedRead as (() => void) | null;
  release?.();

  const context = await recallPromise;
  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /Relevant Memories/);
});

test("recallInternal reuses stale qmd cache while qmd reprobe cooldown is active", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-stale-cache-",
    {
      qmdEnabled: true,
      qmdRecallCacheTtlMs: 0,
      qmdRecallCacheStaleTtlMs: 60_000,
    },
  );

  const { id: memoryId } = await (orchestrator as any).storage.writeMemory(
    "fact",
    "stale cache memory",
  );
  const memory = await (orchestrator as any).storage.getMemoryById(memoryId);
  assert.ok(memory);

  const cacheKey = buildQmdRecallCacheKey({
    query: "Summarize the current project state.",
    namespaces: ["default"],
    recallMode: "full",
    maxResults: runtimeQmdFetchLimit(orchestrator),
    memoryDir: (orchestrator as any).config.memoryDir,
  });
  setCachedQmdRecall(
    cacheKey,
    {
      memoryResultsLists: [
        [
          {
            docid: memory.frontmatter.id,
            path: memory.path,
            snippet: "stale cache memory",
            score: 0.91,
          },
        ],
      ],
      globalResults: [],
      preAugmentTopScore: 0.91,
      maxSpecializedScore: 0,
    },
    { maxEntries: 8 },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));

  (orchestrator as any).qmd = {
    isAvailable: () => false,
    probe: async () => false,
    debugStatus: () => "qmd unavailable",
  };
  (orchestrator as any).lastQmdReprobeAtMs = Date.now();

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-stale-cache",
    { mode: "full" },
  );

  assert.match(context, /stale cache memory/);
});

test("recallInternal uses already-settled qmd results after the enrichment budget expires", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-ready-after-budget-",
    {
      qmdEnabled: true,
      memoryBoxesEnabled: true,
      boxRecallDays: 1,
      recallEnrichmentDeadlineMs: 5,
    },
  );

  const { id: memoryId } = await (orchestrator as any).storage.writeMemory(
    "fact",
    "ready qmd memory",
  );
  const memory = await (orchestrator as any).storage.getMemoryById(memoryId);
  assert.ok(memory);

  (orchestrator as any).boxBuilderFor = () => ({
    readRecentBoxes: async () => {
      await new Promise<never>(() => {});
      return [];
    },
  });

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    probe: async () => true,
    debugStatus: () => "qmd ready",
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: memory.path,
      snippet: "ready qmd memory",
      score: 0.91,
    },
  ];

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-ready-after-budget",
    { mode: "full" },
  );

  assert.match(context, /ready qmd memory/);
});

test("recallInternal does not cache empty qmd result sets", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-empty-cache-",
    {
      qmdEnabled: true,
      qmdRecallCacheTtlMs: 60_000,
      qmdRecallCacheStaleTtlMs: 60_000,
    },
  );

  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [];

  await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-empty-cache",
    { mode: "full" },
  );

  const cacheKey = buildQmdRecallCacheKey({
    query: "Summarize the current project state.",
    namespaces: ["default"],
    recallMode: "full",
    maxResults: runtimeQmdFetchLimit(orchestrator),
    memoryDir: (orchestrator as any).config.memoryDir,
  });

  assert.equal(
    getCachedQmdRecall(cacheKey, {
      freshTtlMs: 60_000,
      staleTtlMs: 60_000,
    }),
    null,
  );
});

test("recallInternal times out hung enrichment work without blocking assembly", async () => {
  const orchestrator = await makeOrchestrator(
    "engram-recall-hung-enrichment-",
    {
      compoundingInjectEnabled: true,
      recallEnrichmentDeadlineMs: 5,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "compounding";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).compounding = {
    buildRecallSection: async () => await new Promise<string | null>(() => {}),
  };

  const startedAt = Date.now();
  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:hung-enrichment",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const release = releaseSharedRead as (() => void) | null;
  release?.();

  const context = await recallPromise;
  const elapsedMs = Date.now() - startedAt;

  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /compounding/i);
  assert.ok(
    elapsedMs < 100,
    `expected enrichment timeout to avoid long assembly stalls, saw ${elapsedMs}ms`,
  );
});

test("recallInternal fails open when a deferred enrichment promise rejects before assembly", async () => {
  const orchestrator = await makeOrchestrator(
    "engram-recall-enrichment-fail-open-",
    {
      compoundingInjectEnabled: true,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "compounding";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).compounding = {
    buildRecallSection: async () => {
      throw new Error("compounding exploded");
    },
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:enrichment-fail-open",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const release = releaseSharedRead as (() => void) | null;
  release?.();

  const context = await recallPromise;
  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /compounding/i);
});

test("recallInternal cancels timed-out qmd enrichment work", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-timeout-cancel-",
    {
      qmdEnabled: true,
      recallEnrichmentDeadlineMs: 80,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  let observedAbortSignal: AbortSignal | undefined;
  let qmdAborted = false;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "memories";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async (
    _query: string,
    _maxResults: number,
    _hybridFetchLimit: number,
    options: { abortSignal?: AbortSignal } = {},
  ) => {
    observedAbortSignal = options.abortSignal;
    if (options.abortSignal?.aborted) {
      qmdAborted = true;
      const err = new Error("qmd enrichment aborted");
      Object.defineProperty(err, "name", { value: "AbortError" });
      throw err;
    }
    await new Promise<never>((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          qmdAborted = true;
          const err = new Error("qmd enrichment aborted");
          Object.defineProperty(err, "name", { value: "AbortError" });
          reject(err);
        },
        { once: true },
      );
    });
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-timeout-cancel",
    { mode: "full" },
  );

  for (let attempt = 0; attempt < 100 && !observedAbortSignal; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(observedAbortSignal, "expected qmd enrichment to start");
  await new Promise((resolve) => setTimeout(resolve, 90));
  const release = releaseSharedRead as (() => void) | null;
  release?.();

  const context = await recallPromise;
  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /Relevant Memories/);
  assert.ok(observedAbortSignal);
  assert.equal(observedAbortSignal?.aborted, true);
  assert.equal(qmdAborted, true);
});

test("recallInternal shares one enrichment timeout budget across sequential enrichment awaits", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-shared-enrichment-budget-",
    {
      qmdEnabled: true,
      compoundingInjectEnabled: true,
      recallEnrichmentDeadlineMs: 120,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  let releaseQmd: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "memories" || id === "compounding";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () =>
    await new Promise<[]>((
      resolve,
    ) => {
      releaseQmd = () => resolve([]);
    });
  (orchestrator as any).compounding = {
    buildRecallSection: async () => await new Promise<string | null>(() => {}),
  };

  const startedAt = Date.now();
  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:shared-enrichment-budget",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const release = releaseSharedRead as (() => void) | null;
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 70));
  const releaseQmdNow = releaseQmd as (() => void) | null;
  releaseQmdNow?.();

  const context = await recallPromise;
  const elapsedMs = Date.now() - startedAt;

  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /compounding/i);
  assert.doesNotMatch(context, /Relevant Memories/);
  assert.ok(
    elapsedMs < 170,
    `expected compounding to share the remaining enrichment budget, saw ${elapsedMs}ms`,
  );
});

test("recallInternal keeps qmd safety reads deadline-bound when qmd settles during the qmd wait", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-settles-during-wait-",
    {
      qmdEnabled: true,
      recallEnrichmentDeadlineMs: 1000,
    },
  );

  const { id: memoryId } = await (orchestrator as any).storage.writeMemory(
    "fact",
    "qmd settled during wait memory",
  );
  const memory = await (orchestrator as any).storage.getMemoryById(memoryId);
  assert.ok(memory);

  const observedSafetyDeadlines: Array<number | null> = [];
  const originalFilterSearchResultsForRecall =
    (orchestrator as any).filterSearchResultsForRecall.bind(orchestrator);
  (orchestrator as any).filterSearchResultsForRecall = async (
    results: unknown[],
    preloadedMemoryMap?: unknown,
    options?: { deadlineAtMs?: number | null },
  ) => {
    if (
      options &&
      Object.prototype.hasOwnProperty.call(options, "deadlineAtMs")
    ) {
      observedSafetyDeadlines.push(options.deadlineAtMs ?? null);
    }
    return originalFilterSearchResultsForRecall(
      results,
      preloadedMemoryMap,
      options,
    );
  };

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    probe: async () => true,
    debugStatus: () => "qmd ready",
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [
      {
        docid: memory.frontmatter.id,
        path: memory.path,
        snippet: "qmd settled during wait memory",
        score: 0.91,
      },
    ];
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-settles-during-wait",
    { mode: "full" },
  );

  assert.match(context, /qmd settled during wait memory/);
  assert.equal(observedSafetyDeadlines.length, 1);
  assert.equal(typeof observedSafetyDeadlines[0], "number");
});

test("cold fallback deadline stops before cold QMD and the query-aware fallback", async () => {
  const orchestrator = await makeOrchestrator("engram-cold-fallback-deadline-", {
    qmdColdTierEnabled: true,
    qmdEnabled: true,
  });

  let coldQmdReads = 0;
  let queryAwareFallbackCalls = 0;
  (orchestrator as any).qmd = { isAvailable: () => true };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => {
    coldQmdReads += 1;
    return [];
  };
  (orchestrator as any).searchQueryAwareFallback = async () => {
    queryAwareFallbackCalls += 1;
    return [];
  };

  const results = await (orchestrator as any).applyColdFallbackPipeline({
    prompt: "fallback deadline test",
    recallNamespaces: ["default"],
    recallResultLimit: 5,
    recallMode: "minimal",
    deadlineAtMs: Date.now() - 1,
  });

  assert.deepEqual(results, []);
  assert.equal(coldQmdReads, 0);
  assert.equal(queryAwareFallbackCalls, 0);
});

test("cold fallback resolves QMD cold collection-prefixed result paths", async () => {
  const orchestrator = await makeOrchestrator("engram-cold-fallback-qmd-prefix-", {
    qmdColdTierEnabled: true,
    qmdEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
  });
  const storage = (orchestrator as any).storage;
  const { id: memoryId } = await storage.writeMemory(
    "fact",
    "cold collection-prefixed memory",
  );
  const hotMemory = await storage.getMemoryById(memoryId);
  assert.ok(hotMemory);
  const migrated = await storage.migrateMemoryToTier(hotMemory, "cold");
  const coldRelativePath = path
    .relative(path.join(storage.dir, "cold"), migrated.targetPath)
    .split(path.sep)
    .join("/");
  const coldCollectionPath = `openclaw-engram-cold/${coldRelativePath}`;

  let queryAwareFallbackCalls = 0;
  (orchestrator as any).qmd = { isAvailable: () => true };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: hotMemory.frontmatter.id,
      path: coldCollectionPath,
      snippet: "cold collection-prefixed memory",
      score: 0.91,
    },
  ];
  (orchestrator as any).searchQueryAwareFallback = async () => {
    queryAwareFallbackCalls += 1;
    return [];
  };

  const results = await (orchestrator as any).applyColdFallbackPipeline({
    prompt: "cold collection prefix test",
    recallNamespaces: ["default"],
    recallResultLimit: 5,
    recallMode: "minimal",
  });

  assert.equal(queryAwareFallbackCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].docid, hotMemory.frontmatter.id);
  assert.equal(results[0].path, coldCollectionPath);
});

test("recallInternal skips embedding fallback after assembly budget expires", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-embedding-fallback-deadline-",
    {
      qmdEnabled: true,
      embeddingFallbackEnabled: true,
      memoryBoxesEnabled: true,
      boxRecallDays: 1,
      recallEnrichmentDeadlineMs: 5,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  // Drive the shared post-retrieval assembly budget deterministically instead
  // of racing the 5ms wall clock: the deadline is set on the first clock read
  // (base) and every later read is far past it, so the "skip after budget
  // expired" gate fires every time rather than flapping on scheduler jitter.
  let assemblyClockReads = 0;
  const assemblyClockBase = Date.now();
  (orchestrator as any).recallAssemblyClockMs = () =>
    assemblyClockBase + assemblyClockReads++ * 60_000;

  (orchestrator as any).boxBuilderFor = () => ({
    readRecentBoxes: async () => {
      await new Promise<never>(() => {});
      return [];
    },
  });
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    probe: async () => true,
    debugStatus: () => "qmd ready",
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [];
  let embeddingCalls = 0;
  (orchestrator as any).searchEmbeddingFallback = async () => {
    embeddingCalls += 1;
    return [
      {
        docid: "late-embedding",
        path: "facts/2026-03-11/late-embedding.md",
        snippet: "late embedding memory",
        score: 0.9,
      },
    ];
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:embedding-fallback-deadline",
    { mode: "full" },
  );

  assert.equal(embeddingCalls, 0);
  assert.doesNotMatch(context, /late embedding memory/);
});

test("recallInternal skips no-QMD hot fallback after assembly budget expires", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-no-qmd-fallback-deadline-",
    {
      qmdEnabled: true,
      embeddingFallbackEnabled: true,
      memoryBoxesEnabled: true,
      boxRecallDays: 1,
      recallEnrichmentDeadlineMs: 5,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  // Drive the shared post-retrieval assembly budget deterministically instead
  // of racing the 5ms wall clock (this test was ~1-in-3 flaky on Node 22): the
  // deadline is set on the first clock read (base) and every later read is far
  // past it, so the "skip after budget expired" gate fires every time.
  let assemblyClockReads = 0;
  const assemblyClockBase = Date.now();
  (orchestrator as any).recallAssemblyClockMs = () =>
    assemblyClockBase + assemblyClockReads++ * 60_000;

  (orchestrator as any).boxBuilderFor = () => ({
    readRecentBoxes: async () => {
      await new Promise<never>(() => {});
      return [];
    },
  });
  (orchestrator as any).qmd = {
    isAvailable: () => false,
    probe: async () => false,
    debugStatus: () => "qmd unavailable",
  };
  let embeddingCalls = 0;
  (orchestrator as any).searchEmbeddingFallback = async () => {
    embeddingCalls += 1;
    return [
      {
        docid: "late-no-qmd-embedding",
        path: "facts/2026-03-11/late-no-qmd-embedding.md",
        snippet: "late no-qmd embedding memory",
        score: 0.9,
      },
    ];
  };
  let recentScanReads = 0;
  (orchestrator as any).readAllMemoriesForNamespaces = async () => {
    recentScanReads += 1;
    return [];
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:no-qmd-fallback-deadline",
    { mode: "full" },
  );

  assert.equal(embeddingCalls, 0);
  assert.equal(recentScanReads, 0);
  assert.doesNotMatch(context, /late no-qmd embedding memory/);
});

test("assembleRecallSections omits an empty memories section when no chunk fits", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-empty-memory-", {
    recallBudgetChars: 40,
    recallPipeline: [{ id: "memories", enabled: true }],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(100),
    { atomic: true, memoryId: "memory-too-large", memoryPath: "facts/too-large.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.sections, []);
  assert.deepEqual(assembled.includedIds, []);
  assert.deepEqual(assembled.omittedIds, ["memories"]);
  assert.equal(assembled.finalChars, 0);
});

test("assembleRecallSections drops an oversized leading heading before a fitting memory", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-heading-memory-", {
    recallBudgetChars: 40,
    recallPipeline: [{ id: "memories", enabled: true }],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(20),
    { atomic: true, memoryId: "memory-fits", memoryPath: "facts/fits.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.sections, ["M".repeat(20)]);
  assert.deepEqual(assembled.includedIds, ["memories"]);
  assert.deepEqual(assembled.includedMemoryIds, ["memory-fits"]);
  assert.deepEqual(assembled.includedMemoryPaths, ["facts/fits.md"]);
});

test("assembleRecallSections reserves only the atomic memory after a leading heading", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-heading-reserve-", {
    recallBudgetChars: 100,
    recallProfileMaxRatio: 1,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(40),
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "H".repeat(50),
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(20),
    { atomic: true, memoryId: "memory-heading-reserve", memoryPath: "facts/heading-reserve.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.match(assembled.sections[0] ?? "", /^P{40}$/);
  assert.deepEqual(assembled.includedMemoryIds, ["memory-heading-reserve"]);
  assert.deepEqual(assembled.includedMemoryPaths, ["facts/heading-reserve.md"]);
  assert.ok(assembled.finalChars <= 100);
});

test("assembleRecallSections does not reserve an oversized atomic memory", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-oversized-memory-", {
    recallBudgetChars: 120,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    "profile context",
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(200),
    { atomic: true, memoryId: "memory-too-large", memoryPath: "facts/too-large.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.includedIds, ["profile"]);
  assert.deepEqual(assembled.omittedIds, ["memories"]);
  assert.match(assembled.sections.join("\n"), /profile context/);
});
test("assembleRecallSections reserves a later fitting atomic memory", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-later-memory-", {
    recallBudgetChars: 100,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(40),
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(200),
    { atomic: true, memoryId: "memory-too-large", memoryPath: "facts/too-large.md" },
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(20),
    { atomic: true, memoryId: "memory-fits-later", memoryPath: "facts/fits-later.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.includedMemoryIds, ["memory-fits-later"]);
  assert.deepEqual(assembled.includedMemoryPaths, ["facts/fits-later.md"]);
  assert.match(assembled.sections.join("\n"), /M{20}/);
});

test("assembleRecallSections reserves a memory that fits its section cap without the separator", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-separator-", {
    recallBudgetChars: 50,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true, maxChars: 20 },
    ],
  });
  const sectionBuckets: RecallSectionBuckets = new Map();

  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(30),
  );
  orchestrator.recallSectionCoordinator.appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(20),
    { atomic: true, memoryId: "memory-section-fit", memoryPath: "facts/section-fit.md" },
  );

  const assembled = orchestrator.recallSectionCoordinator.assembleRecallSections(
    sectionBuckets,
  );

  assert.deepEqual(assembled.includedMemoryIds, ["memory-section-fit"]);
  assert.deepEqual(assembled.includedMemoryPaths, ["facts/section-fit.md"]);
  assert.ok(assembled.finalChars <= 50);
});

function captureRecallTimings(
  orchestrator: Orchestrator,
): () => Record<string, string> {
  let captured: Record<string, string> = {};
  (orchestrator as any).emitTrace = (event: { kind: string; timings?: Record<string, string> }) => {
    if (event.kind === "recall_summary" && event.timings) captured = event.timings;
  };
  return () => captured;
}

test("a stalled artifact provider degrades at the core deadline instead of holding recall", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-artifact-deadline-", {
    verbatimArtifactsEnabled: true,
    // A real timer, not a guessed wait: the stub below never settles on its own,
    // so the deadline decides this test regardless of machine load.
    recallCoreDeadlineMs: 25,
  });
  const recallTimings = captureRecallTimings(orchestrator);
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "verbatim-artifacts" || id === "memories";

  let sectionSignal: AbortSignal | undefined;
  let cancelledDuringScan = false;
  (orchestrator as any).recallArtifactsAcrossNamespaces = async (
    _prompt: string,
    _namespaces: string[],
    _targetCount: number,
    options?: { abortSignal?: AbortSignal },
  ) => {
    sectionSignal = options?.abortSignal;
    const cancelled = Promise.withResolvers<void>();
    options?.abortSignal?.addEventListener("abort", () => {
      cancelledDuringScan = true;
      cancelled.resolve();
    });
    await cancelled.promise;
    return [];
  };

  const context = await (orchestrator as any).recallInternal(
    "which artifacts mention the deploy runbook?",
    "agent:test:artifact-deadline",
    { mode: "full" },
  );

  // The contract: recall returned at all, and the slow provider was told to stop.
  assert.equal(typeof context, "string");
  assert.ok(sectionSignal, "the artifact scan received a cancellation signal");
  assert.equal(cancelledDuringScan, true);
  assert.match(recallTimings().artifacts ?? "", /^timeout\(\d+ms\)$/);
});

test("a stalled entity provider degrades at the core deadline instead of holding recall", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-entity-deadline-", {
    entityRetrievalEnabled: true,
    recallCoreDeadlineMs: 25,
  });
  const recallTimings = captureRecallTimings(orchestrator);
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "entity-retrieval";

  const scanStarted = Promise.withResolvers<void>();
  // Stall the entity section's first read. On a large or slow memory tree the
  // scans it fans out to take minutes; here one never returns, so only the
  // deadline can release the response — the guarantee issue #2291 asked for.
  (orchestrator as any).transcript = {
    readRecent: async () => {
      scanStarted.resolve();
      await Promise.withResolvers<void>().promise;
      return [];
    },
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "what do we know about the deploy runbook?",
    "agent:test:entity-deadline",
    { mode: "full" },
  );
  await scanStarted.promise;

  const context = await recallPromise;
  assert.equal(typeof context, "string");
  assert.match(recallTimings().entityRetrieval ?? "", /^timeout\(\d+ms\)$/);
});
