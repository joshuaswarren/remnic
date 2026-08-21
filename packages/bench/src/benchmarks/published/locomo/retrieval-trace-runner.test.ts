import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BenchMemoryAdapter, BenchRecallTrace, Message } from "../../../adapters/types.js";
import {
  buildProviderFreeLoCoMoRetrievalConfig,
  captureLoCoMoRetrievalTrace,
  preflightLoCoMoRetrievalTraceCapture,
  selectLoCoMoRetrievalTraceTasks,
} from "./retrieval-trace-runner.js";
import { prioritizeLoCoMoRecallTextWithTrace, transformLoCoMoRecallText } from "./runner.js";

const RAW_RECALL_SENTINEL = "RAW-RECALL-MUST-NOT-PERSIST";
const QUESTION_SENTINEL = "QUESTION-MUST-NOT-PERSIST";
const GOLD_SENTINEL = "GOLD-MUST-NOT-PERSIST";
const EVIDENCE_SENTINEL = "D99:99-MUST-NOT-PERSIST";
const RAW_MEMORY_ID_SENTINEL = "RAW-MEMORY-ID-MUST-NOT-PERSIST";
const FUTURE_RESULT_SENTINEL = "FUTURE-RESULT-FIELD-MUST-NOT-PERSIST";
const FUTURE_SCORE_SENTINEL = "FUTURE-SCORE-FIELD-MUST-NOT-PERSIST";
const PROVIDER_CONFIG_SENTINEL = "PROVIDER-CONFIG-MUST-NOT-PERSIST";

function structuralTrace(): BenchRecallTrace {
  const trace: BenchRecallTrace = {
    schemaVersion: 1,
    sensitivity: {
      classification: "restricted",
      contentEncoding: "sha256+length",
      containsGold: false,
    },
    sections: [
      {
        id: "lcm-summary",
        source: "lcm-summary",
        separatorStart: 0,
        contentStart: 0,
        contentEnd: 8,
        composedStart: 0,
        composedEnd: 8,
        visibleStart: 0,
        visibleEnd: 8,
        visibleChars: 8,
      },
    ],
    selections: [
      {
        sectionId: "lcm-summary",
        kind: "lcm-summary",
        lineageStatus: "exact",
        composedStart: 0,
        composedEnd: 8,
        visibleStart: 0,
        visibleEnd: 8,
        summary: { id: "NONDETERMINISTIC-SUMMARY", depth: 1, msgStart: 0, msgEnd: 2 },
      },
    ],
    lcmCandidates: [],
    coreCapture: {
      snapshotId: "NONDETERMINISTIC-SNAPSHOT",
      capturedAt: 999999,
      traceId: "NONDETERMINISTIC-TRACE",
      budget: { chars: 10, used: 8 },
      filters: [{ name: "validity", considered: 1, admitted: 1 }],
      results: [
        {
          memoryIdRef: {
            sha256: "41e54cfc49c4c28e85951506dd19bce5742464feefdcaa17556f8a8b63d30d98",
            length: 23,
          },
          servedBy: "hybrid",
          scoreDecomposition: { final: 0.8 },
          admittedBy: ["validity"],
        },
      ],
    },
    budget: { requestedChars: 10, composedChars: 8, returnedChars: 8, truncated: false },
  };
  const result = trace.coreCapture?.results[0] as unknown as Record<string, unknown>;
  result.memoryId = RAW_MEMORY_ID_SENTINEL;
  result.futureSensitiveField = FUTURE_RESULT_SENTINEL;
  (result.scoreDecomposition as Record<string, unknown>).futureSensitiveScore = FUTURE_SCORE_SENTINEL;
  return trace;
}

function fakeAdapter(calls: string[], traceFactory: () => BenchRecallTrace = structuralTrace): BenchMemoryAdapter {
  return {
    async reset() {
      calls.push("reset");
    },
    async store(sessionId: string, _messages: Message[]) {
      calls.push(`store:${sessionId}`);
    },
    async drain() {
      calls.push("drain");
    },
    async recall() {
      throw new Error("plain recall must not be called");
    },
    async recallWithTrace(sessionId, question, budgetChars) {
      calls.push(`trace:${sessionId}:${budgetChars}`);
      assert.match(question, new RegExp(QUESTION_SENTINEL));
      return { text: `${RAW_RECALL_SENTINEL} Maya moved to Seattle.`, trace: traceFactory() };
    },
    async assessRecallSupport() {
      throw new Error("support must not be called");
    },
    async search() {
      throw new Error("search must not be called by the capture runner");
    },
    async getStats() {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    async destroy() {},
    responder: {
      async respond() {
        throw new Error("responder must not be called");
      },
    },
    judge: {
      async score() {
        throw new Error("judge must not be called");
      },
    },
  };
}

async function withDataset(run: (datasetDir: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-locomo-trace-"));
  try {
    await writeFile(
      path.join(directory, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "safe-conversation",
          conversation: {
            speaker_a: "Maya",
            session_1: [{ speaker: "Maya", dia_id: "D1:1", text: "Maya moved to Seattle." }],
          },
          qa: [
            {
              question: `${QUESTION_SENTINEL}: where did Maya move?`,
              answer: GOLD_SENTINEL,
              evidence: [EVIDENCE_SENTINEL],
              category: 1,
            },
          ],
        },
      ])
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("capture emits deterministic restricted retrieval-only receipts without provider surfaces", async () => {
  await withDataset(async (datasetDir) => {
    const calls: string[] = [];
    const options = {
      datasetDir,
      runtimeProfile: "real" as const,
      system: fakeAdapter(calls),
      retrievalConfig: buildProviderFreeLoCoMoRetrievalConfig({
        lcmEnabled: true,
        skipExtractionLcmFirst: true,
        openaiApiKey: PROVIDER_CONFIG_SENTINEL,
        gatewayConfig: { token: PROVIDER_CONFIG_SENTINEL },
        internalProvider: { provider: PROVIDER_CONFIG_SENTINEL },
      }),
      selector: { taskIds: ["safe-conversation-q0-single_hop"] },
      gitSha: "abc123",
      remnicVersion: "9.6.31",
      providerFreeConfirmed: true as const,
    };
    const first = await captureLoCoMoRetrievalTrace(options);
    const second = await captureLoCoMoRetrievalTrace({ ...options, system: fakeAdapter([]) });
    assert.deepEqual(first, second);
    assert.deepEqual(calls, [
      "reset",
      "store:safe-conversation-session_1",
      "drain",
      "trace:safe-conversation-session_1:24000",
    ]);
    assert.equal(first.sensitivity.containsGold, false);
    assert.equal(first.sensitivity.containsRawContent, false);
    assert.equal(first.provenance.providerFree, true);
    assert.equal(first.provenance.replayExtractionMode, "skip");
    assert.match(first.artifactHash, /^[0-9a-f]{64}$/u);

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      RAW_RECALL_SENTINEL,
      QUESTION_SENTINEL,
      GOLD_SENTINEL,
      EVIDENCE_SENTINEL,
      "safe-conversation-session_1",
      "NONDETERMINISTIC-SNAPSHOT",
      "NONDETERMINISTIC-TRACE",
      "NONDETERMINISTIC-MEMORY",
      "NONDETERMINISTIC-SUMMARY",
      RAW_MEMORY_ID_SENTINEL,
      FUTURE_RESULT_SENTINEL,
      FUTURE_SCORE_SENTINEL,
      PROVIDER_CONFIG_SENTINEL,
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(first.tasks[0]?.sessions[0]?.trace.coreCapture?.results[0]?.memoryIdRef, {
      sha256: "41e54cfc49c4c28e85951506dd19bce5742464feefdcaa17556f8a8b63d30d98",
      length: 23,
    });
  });
});

test("provider-free config disables every model and embedding escape hatch", () => {
  const input = {
    lcmEnabled: true,
    recallPlannerTimeoutMs: 4321,
    nestedSafe: {
      threshold: 0.75,
      apiKey: PROVIDER_CONFIG_SENTINEL,
      gatewayConfig: { token: PROVIDER_CONFIG_SENTINEL },
      llmModel: PROVIDER_CONFIG_SENTINEL,
    },
    openaiApiKey: PROVIDER_CONFIG_SENTINEL,
    authorization: PROVIDER_CONFIG_SENTINEL,
    gatewayConfig: { token: PROVIDER_CONFIG_SENTINEL },
    gatewayAgentId: PROVIDER_CONFIG_SENTINEL,
    fastGatewayAgentId: PROVIDER_CONFIG_SENTINEL,
    internalProvider: { provider: PROVIDER_CONFIG_SENTINEL },
    llmProvider: PROVIDER_CONFIG_SENTINEL,
    llmModel: PROVIDER_CONFIG_SENTINEL,
    modelSource: "gateway",
    localLlmEnabled: true,
    localLlmFastEnabled: true,
    recallPlannerEnabled: true,
    embeddingFallbackEnabled: true,
    hostEmbeddingProviderEnabled: true,
  };
  const original = structuredClone(input);
  const config = buildProviderFreeLoCoMoRetrievalConfig(input);
  assert.deepEqual(input, original);
  assert.equal(config.lcmEnabled, true);
  assert.equal(config.recallPlannerTimeoutMs, 4321);
  assert.deepEqual(config.nestedSafe, { threshold: 0.75 });
  assert.equal(JSON.stringify(config).includes(PROVIDER_CONFIG_SENTINEL), false);
  assert.deepEqual(
    config,
    buildProviderFreeLoCoMoRetrievalConfig({
      lcmEnabled: true,
      recallPlannerTimeoutMs: 4321,
      nestedSafe: { threshold: 0.75 },
    }),
    "omitted provider material must not influence the hashed retrieval config"
  );
  assert.deepEqual(
    {
      localLlmEnabled: config.localLlmEnabled,
      localLlmFastEnabled: config.localLlmFastEnabled,
      recallPlannerEnabled: config.recallPlannerEnabled,
      embeddingFallbackEnabled: config.embeddingFallbackEnabled,
      hostEmbeddingProviderEnabled: config.hostEmbeddingProviderEnabled,
      openaiApiKey: config.openaiApiKey,
      modelSource: config.modelSource,
    },
    {
      localLlmEnabled: false,
      localLlmFastEnabled: false,
      recallPlannerEnabled: false,
      embeddingFallbackEnabled: false,
      hostEmbeddingProviderEnabled: false,
      openaiApiKey: false,
      modelSource: "plugin",
    }
  );
  assert.doesNotThrow(() => buildProviderFreeLoCoMoRetrievalConfig({ openaiApiKey: false }));
});

test("capture fails closed without recallWithTrace and rejects secret or provider-capable config", async () => {
  await withDataset(async (datasetDir) => {
    const base = fakeAdapter([]);
    const withoutTrace = { ...base, recallWithTrace: undefined };
    await assert.rejects(
      captureLoCoMoRetrievalTrace({
        datasetDir,
        runtimeProfile: "baseline",
        system: withoutTrace,
        retrievalConfig: buildProviderFreeLoCoMoRetrievalConfig({}),
        selector: { taskIds: ["safe-conversation-q0-single_hop"] },
        gitSha: "abc",
        remnicVersion: "1",
        providerFreeConfirmed: true,
      }),
      /requires system\.recallWithTrace/
    );
    const providerFree = buildProviderFreeLoCoMoRetrievalConfig({});
    for (const retrievalConfig of [
      { ...providerFree, openaiApiKey: "secret" },
      { ...providerFree, modelSource: "gateway" },
      { ...providerFree, localLlmEnabled: true },
      { ...providerFree, embeddingFallbackEnabled: true },
      { ...providerFree, hostEmbeddingProviderEnabled: true },
      { ...providerFree, gatewayConfig: { token: "secret" } },
      { ...providerFree, nested: { clientSecret: "secret" } },
      { ...providerFree, llmProvider: "openai" },
    ]) {
      await assert.rejects(
        captureLoCoMoRetrievalTrace({
          datasetDir,
          runtimeProfile: "baseline",
          system: fakeAdapter([]),
          retrievalConfig,
          selector: { taskIds: ["safe-conversation-q0-single_hop"] },
          gitSha: "abc",
          remnicVersion: "1",
          providerFreeConfirmed: true,
        }),
        /configuration|provider-free/
      );
    }
  });
});

test("capture fails closed on malformed content-free memory references", async () => {
  await withDataset(async (datasetDir) => {
    const invalidTrace = structuralTrace();
    const invalidResult = invalidTrace.coreCapture?.results[0];
    assert.ok(invalidResult);
    for (const memoryIdRef of [
      { sha256: "invalid", length: 1 },
      { sha256: "A".repeat(64), length: 1 },
      { sha256: "a".repeat(64), length: 0 },
    ]) {
      invalidResult.memoryIdRef = memoryIdRef;
      await assert.rejects(
        captureLoCoMoRetrievalTrace({
          datasetDir,
          runtimeProfile: "baseline",
          system: fakeAdapter([], () => invalidTrace),
          retrievalConfig: buildProviderFreeLoCoMoRetrievalConfig({}),
          selector: { taskIds: ["safe-conversation-q0-single_hop"] },
          gitSha: "abc",
          remnicVersion: "1",
          providerFreeConfirmed: true,
        }),
        /valid content-free memoryIdRef/
      );
    }
  });
});

test("task selectors validate explicit ids and use stable seeded sampling in dataset order", () => {
  const tasks = ["task-c", "task-a", "task-b"].map((taskId) => ({ taskId }));
  const first = selectLoCoMoRetrievalTraceTasks(tasks, { sampleSize: 2, seed: 42 });
  const second = selectLoCoMoRetrievalTraceTasks([...tasks].reverse(), { sampleSize: 2, seed: 42 });
  assert.deepEqual(new Set(first.selectedTaskIds), new Set(second.selectedTaskIds));
  assert.deepEqual(
    first.selectedTaskIds,
    tasks.map((task) => task.taskId).filter((id) => first.selectedTaskIds.includes(id))
  );
  assert.throws(() => selectLoCoMoRetrievalTraceTasks(tasks, { taskIds: ["task-a", "task-a"] }), /duplicates/);
  assert.throws(() => selectLoCoMoRetrievalTraceTasks(tasks, { taskIds: ["unknown"] }), /Unknown/);
  assert.throws(() => selectLoCoMoRetrievalTraceTasks(tasks, { sampleSize: 0, seed: 1 }), /sampleSize/);
  assert.throws(
    () => selectLoCoMoRetrievalTraceTasks(tasks, { taskIds: ["task-a"], sampleSize: 1, seed: 1 } as never),
    /exactly one/
  );
});

test("composition tracing preserves normal transform bytes and maps duplicate lines by running ordinal", () => {
  const question = "Which organization is associated with Maya's sister?";
  const recalledText = ["Maya's sister is Lena.", "Maya's sister is Lena.", "Lena volunteers at Harbor Aid."].join(
    "\n"
  );
  const traced = prioritizeLoCoMoRecallTextWithTrace({
    question,
    recalledText,
    multiHopRecallComposition: true,
  });
  assert.equal(transformLoCoMoRecallText({ question, recalledText, multiHopRecallComposition: true }), traced.text);
  assert.equal(traced.receipt.selectedLines[0]?.inputOrdinal, 0);
  assert.equal(
    traced.receipt.selectedLines.some((line) => line.inputOrdinal === 1),
    false
  );
  assert.equal(JSON.stringify(traced.receipt).includes(recalledText), false);
  for (const line of traced.receipt.selectedLines) {
    assert.equal(line.outputEnd - line.outputStart, line.output.charCount);
    assert.equal(line.visibleEnd - line.visibleStart, line.visible ? line.output.charCount : 0);
  }
});

test("composition visibility never credits the truncation marker to a dropped bracket-prefixed row", () => {
  const direct = Array.from(
    { length: 10 },
    (_, index) => `needle BridgeToken direct-${index} ${"d".repeat(430 - String(index).length)}`
  );
  const linked = Array.from({ length: 4 }, (_, index) => {
    const prefix = index === 3 ? "[ BridgeToken" : "BridgeToken";
    return `${prefix} linked-${index} ${"l".repeat(430 - String(index).length)}`;
  });
  const traced = prioritizeLoCoMoRecallTextWithTrace({
    question: "needle",
    recalledText: [...direct, ...linked].join("\n"),
    multiHopRecallComposition: true,
  });
  assert.match(traced.text, /\[LoCoMo context truncated to 6000 characters\]$/u);
  const dropped = traced.receipt.selectedLines.find((line) => line.inputOrdinal === 13);
  assert.ok(dropped);
  assert.equal(dropped.visible, false);
  assert.equal(dropped.visibleEnd - dropped.visibleStart, 0);
});

test("preflight rejects invalid selectors before any adapter is required", async () => {
  await withDataset(async (datasetDir) => {
    await assert.rejects(
      preflightLoCoMoRetrievalTraceCapture({
        datasetDir,
        runtimeProfile: "baseline",
        retrievalConfig: buildProviderFreeLoCoMoRetrievalConfig({}),
        selector: { taskIds: ["unknown"] },
        gitSha: "abc",
        remnicVersion: "1",
        providerFreeConfirmed: true,
      }),
      /Unknown/
    );
  });
});
