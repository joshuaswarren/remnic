import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { setCodexCliFallbackRunnerForProcess } from "@remnic/core";

import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

type CapturedGatewayCall = {
  modelId: string;
  agentPrompt: string;
  timeoutMs?: number;
};

function makeGatewayConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: "default-provider/default-model" },
      },
      list: [
        {
          id: "main-agent",
          name: "Main Remnic provider",
          model: { primary: "main-provider/main-model" },
        },
        {
          id: "fast-agent",
          name: "Fast Remnic provider",
          model: { primary: "fast-provider/fast-model" },
        },
      ],
    },
    models: {
      providers: {
        "default-provider": {
          baseUrl: "codex-cli://local",
          api: "codex-cli",
          models: [{ id: "default-model", name: "default-model" }],
        },
        "main-provider": {
          baseUrl: "codex-cli://local",
          api: "codex-cli",
          models: [{ id: "main-model", name: "main-model" }],
        },
        "fast-provider": {
          baseUrl: "codex-cli://local",
          api: "codex-cli",
          models: [{ id: "fast-model", name: "fast-model" }],
        },
        "task-provider": {
          baseUrl: "codex-cli://local",
          api: "codex-cli",
          models: [{ id: "task-model", name: "task-model" }],
        },
      },
    },
  };
}

async function captureLcmGatewaySummary(
  overrides: Record<string, unknown> = {},
): Promise<CapturedGatewayCall[]> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lcm-gateway-"));
  const calls: CapturedGatewayCall[] = [];
  const restoreRunner = setCodexCliFallbackRunnerForProcess(
    async (request) => {
      calls.push({
        modelId: request.modelId,
        agentPrompt: request.messages.map((message) => message.content).join("\n"),
        timeoutMs: request.options.timeoutMs,
      });
      return {
        content: "Codex gateway summary.",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      };
    },
  );
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      lcmEnabled: true,
      lcmLeafBatchSize: 2,
      lcmRollupFanIn: 100,
      localLlmEnabled: false,
      localLlmFastTimeoutMs: 1234,
      modelSource: "gateway",
      gatewayAgentId: "main-agent",
      gatewayConfig: makeGatewayConfig(),
      ...overrides,
    }),
  );

  try {
    await orchestrator.initialize();
    assert.ok(orchestrator.lcmEngine, "LCM engine should be enabled");

    orchestrator.lcmEngine!.enqueueObserveMessages("session-1", [
      {
        role: "user",
        content: "The benchmark answerer used Codex CLI as the primary model.",
      },
      {
        role: "assistant",
        content: "The internal Remnic summarizer should use the gateway too.",
      },
    ]);
    await orchestrator.lcmEngine!.waitForObserveQueueIdle();

    const stats = await orchestrator.lcmEngine!.getStats("session-1");
    assert.equal(stats.totalSummaryNodes, 1);
    return [...calls];
  } finally {
    restoreRunner();
    const teardown = orchestrator as unknown as {
      abortDeferredInit(): void;
      deferredReady: Promise<void>;
      qmd: { dispose?(): void | Promise<void> };
      qmdMaintenanceTimer?: NodeJS.Timeout | null;
    };
    teardown.abortDeferredInit();
    if (teardown.qmdMaintenanceTimer) {
      clearTimeout(teardown.qmdMaintenanceTimer);
      teardown.qmdMaintenanceTimer = null;
    }
    await Promise.race([
      teardown.deferredReady.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await teardown.qmd.dispose?.();
    orchestrator.lcmEngine?.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("LCM summarization uses gateway internal LLM when modelSource is gateway", async () => {
  const calls = await captureLcmGatewaySummary();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.modelId, "main-model");
  assert.equal(calls[0]?.timeoutMs, 1234);
  assert.match(calls[0]?.agentPrompt ?? "", /gateway too/);
});

test("LCM summarization uses taskModelChain when no fast gateway persona is configured", async () => {
  const calls = await captureLcmGatewaySummary({
    taskModelChain: { primary: "task-provider/task-model" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.modelId, "task-model");
});

test("LCM summarization preserves fastGatewayAgentId over taskModelChain", async () => {
  const calls = await captureLcmGatewaySummary({
    fastGatewayAgentId: "fast-agent",
    taskModelChain: { primary: "task-provider/task-model" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.modelId, "fast-model");
});
