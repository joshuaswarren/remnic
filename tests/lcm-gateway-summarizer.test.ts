import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { z } from "zod";

import { setCodexCliFallbackRunnerForProcess } from "@remnic/core";
import { estimateTokens } from "@remnic/core/lcm";

import { Orchestrator } from "@remnic/core/orchestrator";
import { parseConfig } from "@remnic/core/config";

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
    // destroy() drains the startup fact-hash warm-up, so nothing is still
    // writing state/ when rm runs (a hand-rolled teardown raced it: ENOTEMPTY).
    await orchestrator.destroy();
    orchestrator.lcmEngine?.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("LCM summarization uses gateway internal LLM when modelSource is gateway", async () => {
  const calls = await captureLcmGatewaySummary();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.modelId, "main-model");
  // Unified Codex headroom: min(25, max(1, floor(timeout/10))) = 25.
  // Provider call budget is localLlmFastTimeoutMs - headroom = 1234 - 25.
  assert.equal(calls[0]?.timeoutMs, 1209);
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

/** The chat-completion request fields the gateway budget test asserts on. */
const ChatRequestSchema = z.object({
  max_tokens: z.number().int(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

const BoundPortSchema = z.object({ port: z.number().int() });

/** Loopback OpenAI-compatible endpoint that records raw chat-completion bodies. */
async function startLoopbackChatCompletions(): Promise<{
  baseUrl: string;
  bodies: string[];
  close: () => Promise<void>;
}> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/chat/completions")) bodies.push(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Gateway summary." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = BoundPortSchema.parse(server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

function makeLoopbackGatewayConfig(baseUrl: string) {
  return {
    agents: {
      defaults: { model: { primary: "loopback-provider/loopback-model" } },
      list: [
        {
          id: "loopback-agent",
          name: "Loopback provider",
          model: { primary: "loopback-provider/loopback-model" },
        },
      ],
    },
    models: {
      providers: {
        "loopback-provider": {
          baseUrl,
          api: "openai-completions",
          models: [{ id: "loopback-model", name: "loopback-model" }],
        },
      },
    },
  };
}

test("LCM gateway summarize sizes max_tokens by the text it sends, not the whole batch (#3407)", async () => {
  const stub = await startLoopbackChatCompletions();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lcm-gateway-budget-"));
  try {
    const engine = new Orchestrator(
      parseConfig({
        memoryDir,
        lcmEnabled: true,
        localLlmEnabled: false,
        modelSource: "gateway",
        gatewayAgentId: "loopback-agent",
        gatewayConfig: makeLoopbackGatewayConfig(stub.baseUrl),
      }),
    ).lcmEngine;
    assert.ok(engine, "LCM engine should be enabled");
    const summarizeFn = engine["summarizeFn"];

    // LcmSummarizer targets 25% of the whole batch; the call sends only a
    // prefix. Batch sizing would ask this gateway route for well over 16,384.
    const batch = "[user] the deploy failed at step three; retry it with the cached artifact.\n\n".repeat(3_000);
    const batchTarget = Math.max(64, Math.ceil(estimateTokens(batch) * 0.25));
    assert.ok(batchTarget * 2 > 16_384, "fixture must exceed a common provider output cap under batch sizing");

    const result = await summarizeFn(batch, batchTarget, false);

    assert.equal(result, "Gateway summary.");
    assert.equal(stub.bodies.length, 1, "the gateway route serves the LCM summarize call");
    const request = ChatRequestSchema.parse(JSON.parse(stub.bodies[0]));
    const [system, user] = request.messages;
    const sentTokens = estimateTokens(user.content);
    assert.equal(user.content.length, 12_000, "only the 12,000-character prefix is sent");
    assert.ok(
      request.max_tokens <= 2 * (Math.ceil(sentTokens * 0.25) + 1),
      `max_tokens ${request.max_tokens} must track the ${sentTokens} tokens sent`,
    );
    assert.ok(system.content.includes(`maximum ${request.max_tokens / 2} tokens`));
  } finally {
    await stub.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
