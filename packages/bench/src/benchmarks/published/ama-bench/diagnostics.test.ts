import assert from "node:assert/strict";
import test from "node:test";

import type {
  BenchMemoryAdapter,
  BenchPhaseControl,
  Message,
  SearchResult,
} from "../../../adapters/types.ts";
import type { BenchmarkResult } from "../../../types.ts";
import {
  buildAmaBenchDiagnosticMatrixArtifact,
  buildAmaBenchDiagnosticVariantSummary,
  buildOracleTrajectoryRecall,
  createAmaBenchDiagnosticAdapter,
  extractMarkdownSectionsByTitle,
  isAmaBenchUnknownLikeAnswer,
  selectAmaBenchDiagnosticVariants,
  type AmaBenchDiagnosticVariant,
} from "./diagnostics.ts";

const DEFAULT_TEST_VARIANT_IDS = new Set([
  "remnic-full-normal",
  "explicit-only-normal",
  "oracle-trajectory-normal",
]);

class FakeAdapter implements BenchMemoryAdapter {
  recalledText = "";
  drainCalls = 0;
  storeCalls = 0;
  controls: BenchPhaseControl[] = [];
  responder = {
    async respond() {
      return {
        text: "normal answer",
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        model: "normal-responder",
      };
    },
  };

  async store(
    _sessionId: string,
    _messages: Message[],
    control?: BenchPhaseControl,
  ): Promise<void> {
    this.storeCalls += 1;
    if (control) {
      this.controls.push(control);
    }
  }

  async recall(
    _sessionId: string,
    _query: string,
    _budgetChars?: number,
    _options?: unknown,
    control?: BenchPhaseControl,
  ): Promise<string> {
    if (control) {
      this.controls.push(control);
    }
    return this.recalledText;
  }

  async search(
    _query: string,
    _limit: number,
    _sessionId?: string,
    control?: BenchPhaseControl,
  ): Promise<SearchResult[]> {
    if (control) {
      this.controls.push(control);
    }
    return [];
  }

  async reset(
    _sessionId?: string,
    control?: BenchPhaseControl,
  ): Promise<void> {
    if (control) {
      this.controls.push(control);
    }
  }

  async getStats(
    _sessionId?: string,
    control?: BenchPhaseControl,
  ): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
  }> {
    if (control) {
      this.controls.push(control);
    }
    return {
      totalMessages: 0,
      totalSummaryNodes: 0,
      maxDepth: 0,
    };
  }

  async destroy(): Promise<void> {}

  async drain(control?: BenchPhaseControl): Promise<void> {
    this.drainCalls += 1;
    if (control) {
      this.controls.push(control);
    }
  }
}

const explicitOnlyVariant: AmaBenchDiagnosticVariant = {
  id: "explicit-only-normal",
  label: "explicit",
  recallMode: "explicit-evidence-only",
  answererMode: "normal",
  description: "test",
};

test("extractMarkdownSectionsByTitle keeps only matching level-two sections", () => {
  const filtered = extractMarkdownSectionsByTitle(
    [
      "# Preamble",
      "not included",
      "## Explicit Cue Evidence",
      "[Action 1]: Open settings.",
      "",
      "## Remnic recall pipeline",
      "This should be stripped.",
      "",
      "## Explicit Cue Evidence",
      "[Observation 1]: Language was Spanish.",
    ].join("\n"),
    ["Explicit Cue Evidence"],
  );

  assert.match(filtered, /\[Action 1\]: Open settings/);
  assert.match(filtered, /\[Observation 1\]: Language was Spanish/);
  assert.doesNotMatch(filtered, /Remnic recall pipeline/);
  assert.doesNotMatch(filtered, /should be stripped/);
});

test("extractMarkdownSectionsByTitle handles CRLF and ignores deeper headings", () => {
  const filtered = extractMarkdownSectionsByTitle(
    [
      "##\tExplicit Cue Evidence",
      "kept",
      "### Explicit Cue Evidence",
      "still inside the previous section",
      "## Search evidence",
      "stripped",
    ].join("\r\n"),
    ["Explicit Cue Evidence"],
  );

  assert.match(filtered, /kept/);
  assert.match(filtered, /still inside the previous section/);
  assert.doesNotMatch(filtered, /stripped/);
});

test("diagnostic adapter supports explicit-evidence-only recall and strong responder override", async () => {
  const base = new FakeAdapter();
  base.recalledText = [
    "## Explicit Cue Evidence",
    "[Action 1]: Open settings.",
    "",
    "## Search evidence",
    "Unrelated search context.",
  ].join("\n");
  const strongResponder = {
    async respond() {
      return {
        text: "strong answer",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "strong-responder",
      };
    },
  };
  const adapter = createAmaBenchDiagnosticAdapter(
    base,
    { ...explicitOnlyVariant, answererMode: "strong" },
    { strongResponder },
  );

  assert.equal(adapter.responder, strongResponder);
  const recalled = await adapter.recall("ama-ep-1", "What happened?");
  assert.match(recalled, /\[Action 1\]: Open settings/);
  assert.doesNotMatch(recalled, /Search evidence/);
  assert.doesNotMatch(recalled, /Unrelated search context/);
});

test("diagnostic adapter forwards phase control to delegated adapter calls", async () => {
  const base = new FakeAdapter();
  const adapter = createAmaBenchDiagnosticAdapter(base, explicitOnlyVariant);
  const controller = new AbortController();
  const control: BenchPhaseControl = { signal: controller.signal };

  await adapter.store("ama-ep-1", [], control);
  await adapter.recall("ama-ep-1", "What happened?", undefined, undefined, control);
  await adapter.search("settings", 3, "ama-ep-1", control);
  await adapter.reset("ama-ep-1", control);
  await adapter.getStats("ama-ep-1", control);
  await adapter.drain?.(control);

  assert.equal(base.controls.length, 6);
  assert.ok(base.controls.every((seenControl) => seenControl === control));
});

test("oracle trajectory recall uses stored visible messages and clears on reset", async () => {
  const base = new FakeAdapter();
  const adapter = createAmaBenchDiagnosticAdapter(base, {
    id: "oracle-trajectory-normal",
    label: "oracle",
    recallMode: "oracle-trajectory",
    answererMode: "normal",
    description: "test",
  });
  const messages: Message[] = [
    { role: "user", content: "[Action 1]: Open settings." },
    {
      role: "assistant",
      content: "[Observation 1]: The profile language is Spanish.",
    },
  ];

  await adapter.store("ama-ep-1", messages);
  await adapter.drain?.();
  assert.equal(base.storeCalls, 0);
  assert.equal(base.drainCalls, 0);
  const recalled = await adapter.recall("ama-ep-1", "What language?");
  assert.match(recalled, /^## Explicit Cue Evidence/);
  assert.match(recalled, /\[Action 1\]: Open settings/);
  assert.match(recalled, /\[Observation 1\]: The profile language is Spanish/);
  assert.doesNotMatch(recalled, /expected answer/i);

  await adapter.reset();
  assert.equal(await adapter.recall("ama-ep-1", "What language?"), "");
});

test("oracle trajectory recall respects non-positive budgets", () => {
  assert.equal(
    buildOracleTrajectoryRecall(
      [{ role: "user", content: "[Action 1]: Open settings." }],
      0,
    ),
    "",
  );
});

test("diagnostic summary groups domain and QA type without raw answer text", () => {
  const variant = selectAmaBenchDiagnosticVariants({
    ids: ["remnic-full-normal"],
  })[0]!;
  const result: BenchmarkResult = {
    meta: {
      id: "run-1",
      benchmark: "ama-bench",
      benchmarkTier: "published",
      version: "2.0.0",
      remnicVersion: "test",
      gitSha: "abc",
      timestamp: "2026-05-05T00:00:00.000Z",
      mode: "full",
      runCount: 1,
      seeds: [0],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [
        {
          taskId: "q1",
          question: "redacted by summary",
          expected: "Spanish",
          actual: "Spanish",
          scores: { f1: 1, ama_bench_recommended_accuracy: 1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: {
            domain: "WEB",
            qaType: "recall",
            taskType: "web",
            episodeId: 1,
            recalledLength: 100,
            answeredLength: 7,
            recallSections: ["Explicit Cue Evidence"],
            responderModel: "normal",
            judgeModel: "judge",
            amaBenchCrossJudgeModel: "cross-judge",
            amaBenchCrossJudgeScore: 1,
          },
        },
        {
          taskId: "q2",
          question: "redacted by summary",
          expected: "disabled",
          actual: "There is not enough information.",
          scores: { f1: 0, ama_bench_recommended_accuracy: 0 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: {
            domain: "WEB",
            qaType: "state_updating",
            taskType: "web",
          },
        },
      ],
      aggregates: {},
    },
    environment: {
      os: "test",
      nodeVersion: "test",
    },
  };

  const summary = buildAmaBenchDiagnosticVariantSummary(variant, result, {
    runtimeProfile: "real",
    hasResponder: true,
  });
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.usesFullRemnicRecallProcess, true);
  assert.equal(summary.isPrimaryFullSystemScore, true);
  assert.equal(summary.unknownLikeRate, 0.5);
  assert.equal(summary.scoreMeans.f1, 0.5);
  assert.equal(summary.scoreCounts.ama_bench_recommended_accuracy, 2);
  assert.deepEqual(
    summary.byDomain.map((entry) => [entry.key, entry.taskCount]),
    [["WEB", 2]],
  );
  assert.deepEqual(
    summary.byQaType.map((entry) => [entry.key, entry.taskCount]),
    [
      ["recall", 1],
      ["state_updating", 1],
    ],
  );
  assert.equal("question" in summary.tasks[0]!, false);
  assert.equal("actual" in summary.tasks[0]!, false);
  assert.equal(summary.tasks[0]?.crossJudgeModel, "cross-judge");
  assert.equal(summary.tasks[0]?.crossJudgeScore, 1);
});

test("diagnostic summary can include bounded task evidence by opt-in", () => {
  const variant = selectAmaBenchDiagnosticVariants({
    ids: ["remnic-full-normal"],
  })[0]!;
  const result: BenchmarkResult = {
    meta: {
      id: "run-1",
      benchmark: "ama-bench",
      benchmarkTier: "published",
      version: "2.0.0",
      remnicVersion: "test",
      gitSha: "abc",
      timestamp: "2026-05-05T00:00:00.000Z",
      mode: "full",
      runCount: 1,
      seeds: [0],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [
        {
          taskId: "q1",
          question: "Which color was the small box?",
          expected: "red",
          actual: "The small box was red.",
          scores: { f1: 1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
          details: {
            domain: "Game",
            qaType: "A",
            taskType: "babaisai",
            recalledText: "## Explicit Cue Evidence\n[Action 1]: inspect small box",
          },
        },
      ],
      aggregates: {},
    },
    environment: {
      os: "test",
      nodeVersion: "test",
    },
  };

  const summary = buildAmaBenchDiagnosticVariantSummary(variant, result, {
    runtimeProfile: "real",
    hasResponder: true,
    includeTaskEvidence: true,
    taskEvidenceMaxChars: 12,
  });

  assert.equal(summary.tasks[0]?.evidence?.question, "Which color ");
  assert.equal(summary.tasks[0]?.evidence?.expected, "red");
  assert.equal(summary.tasks[0]?.evidence?.actual, "The small bo");
  assert.equal(summary.tasks[0]?.evidence?.recalledText, "## Explicit ");
  assert.deepEqual(summary.tasks[0]?.evidence?.truncatedFields, [
    "question",
    "actual",
    "recalledText",
  ]);
});

test("diagnostic summary only marks primary full-system scores for full real Remnic runs", () => {
  const variant = selectAmaBenchDiagnosticVariants({
    ids: ["remnic-full-normal"],
  })[0]!;
  const result: BenchmarkResult = {
    meta: {
      id: "run-1",
      benchmark: "ama-bench",
      benchmarkTier: "published",
      version: "2.0.0",
      remnicVersion: "test",
      gitSha: "abc",
      timestamp: "2026-05-05T00:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [0],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "lightweight",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: "test",
      nodeVersion: "test",
    },
  };

  const baselineSummary = buildAmaBenchDiagnosticVariantSummary(
    variant,
    result,
    { runtimeProfile: "baseline" },
  );
  assert.equal(baselineSummary.usesFullRemnicRecallProcess, false);
  assert.equal(baselineSummary.isPrimaryFullSystemScore, false);

  const quickRealSummary = buildAmaBenchDiagnosticVariantSummary(
    variant,
    result,
    { runtimeProfile: "real", hasResponder: true },
  );
  assert.equal(quickRealSummary.usesFullRemnicRecallProcess, true);
  assert.equal(quickRealSummary.isPrimaryFullSystemScore, false);

  const noResponderResult: BenchmarkResult = {
    ...result,
    meta: {
      ...result.meta,
      mode: "full",
    },
  };
  const noResponderSummary = buildAmaBenchDiagnosticVariantSummary(
    variant,
    noResponderResult,
    { runtimeProfile: "real", hasResponder: false },
  );
  assert.equal(noResponderSummary.usesFullRemnicRecallProcess, true);
  assert.equal(noResponderSummary.isPrimaryFullSystemScore, false);
});

test("diagnostic matrix artifact records sanitized run metadata", () => {
  const artifact = buildAmaBenchDiagnosticMatrixArtifact({
    mode: "quick",
    generatedAt: "2026-05-05T00:00:00.000Z",
    config: {
      runtimeProfile: "real",
      adapterMode: "direct",
      datasetDir: "/tmp/ama",
      limit: 2,
      seed: 7,
      amaBenchCrossJudgeProvider: {
        provider: "ollama",
        model: "gemma4:31b",
        baseUrl: "https://ollama.com/api",
      },
      internalProvider: {
        provider: "codex-cli",
        model: "gpt-5.5",
        baseUrl: "codex-cli://local",
      },
    },
    variants: [],
  });

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.benchmark, "ama-bench");
  assert.equal(artifact.config.runtimeProfile, "real");
  assert.equal(
    artifact.config.amaBenchCrossJudgeProvider?.baseUrl,
    "https://ollama.com/api",
  );
  assert.equal(artifact.config.internalProvider?.provider, "codex-cli");
  assert.equal(artifact.config.internalProvider?.model, "gpt-5.5");
  assert.equal(artifact.config.internalProvider?.baseUrl, "codex-cli://local");
  assert.equal(artifact.config.limit, 2);
});

test("diagnostic variant selection rejects unknown ids and can include strong rows", () => {
  assert.deepEqual(
    selectAmaBenchDiagnosticVariants().map((variant) => variant.id),
    ["remnic-full-normal", "explicit-only-normal", "oracle-trajectory-normal"],
  );
  assert.ok(
    selectAmaBenchDiagnosticVariants({ includeStrong: true }).some(
      (variant) => variant.id === "remnic-full-strong",
    ),
  );
  assert.deepEqual(
    selectAmaBenchDiagnosticVariants({ includeStrong: true })
      .filter((variant) => !DEFAULT_TEST_VARIANT_IDS.has(variant.id))
      .map((variant) => variant.answererMode),
    ["strong", "strong", "strong"],
  );
  assert.throws(
    () => selectAmaBenchDiagnosticVariants({ ids: ["missing"] }),
    /Unknown AMA-Bench diagnostic variant/,
  );
});

test("unknown-like answer detection catches underspecified answer patterns", () => {
  assert.equal(isAmaBenchUnknownLikeAnswer("unknown"), true);
  assert.equal(
    isAmaBenchUnknownLikeAnswer("There is insufficient context to answer."),
    true,
  );
  assert.equal(isAmaBenchUnknownLikeAnswer("Spanish"), false);
});
