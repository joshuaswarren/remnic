import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { setCodexCliFallbackRunnerForProcess } from "@remnic/core";

import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

test("LCM summarization uses gateway internal LLM when modelSource is gateway", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lcm-gateway-"));
  const calls: Array<{ modelId: string; agentPrompt: string; timeoutMs?: number }> = [];
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
      gatewayAgentId: "remnic-bench-internal",
      fastGatewayAgentId: "remnic-bench-internal",
      gatewayConfig: {
        agents: {
          defaults: {
            model: { primary: "remnic-bench-internal/gpt-5.5" },
          },
          list: [
            {
              id: "remnic-bench-internal",
              name: "Remnic bench internal provider",
              model: { primary: "remnic-bench-internal/gpt-5.5" },
            },
          ],
        },
        models: {
          providers: {
            "remnic-bench-internal": {
              baseUrl: "codex-cli://local",
              api: "codex-cli",
              codexCliReasoningEffort: "xhigh",
              models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
            },
          },
        },
      },
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
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.modelId, "gpt-5.5");
    assert.equal(calls[0]?.timeoutMs, 1234);
    assert.match(calls[0]?.agentPrompt ?? "", /gateway too/);
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
});
