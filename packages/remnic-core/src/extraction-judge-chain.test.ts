import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { judgeFactDurability } from "./extraction-judge.js";
import type { FallbackLlmClient } from "./fallback-llm.js";

// Regression for cursor review on #1425: the extraction judge must route gateway
// fallback calls through the SAME precedence as ExtractionEngine.withGatewayAgent
// — taskModelChain wins over gatewayAgentId — so judge-gated extractions use the
// configured task chain instead of silently using the persona/default chain.

function captureLlm(captured: Array<Record<string, unknown>>): FallbackLlmClient {
  return {
    isAvailable: () => true,
    chatCompletion: async (_messages: unknown, options: Record<string, unknown>) => {
      captured.push(options);
      // A parseable batch verdict so the judge doesn't error after the call.
      return { content: JSON.stringify([{ index: 0, durable: true, reason: "ok" }]) };
    },
  } as unknown as FallbackLlmClient;
}

// "preference" is not auto-approved (only "correction"/"principle" are), so a
// non-critical preference candidate reaches the LLM path.
const candidate = { text: "user prefers dark mode", category: "preference", confidence: 0.5 };

test("judge forwards taskModelChain to the fallback LLM in gateway mode", async () => {
  const config = parseConfig({
    modelSource: "gateway",
    gatewayAgentId: "persona-agent",
    taskModelChain: { primary: "zai/glm-4.7-flash", fallbacks: ["fireworks/x/glm-5p1"] },
  });
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability([candidate], config, null, captureLlm(captured), new Map(), new Map());

  assert.equal(captured.length, 1, "judge should call the fallback LLM once");
  assert.deepEqual(captured[0]?.modelChain, {
    primary: "zai/glm-4.7-flash",
    fallbacks: ["fireworks/x/glm-5p1"],
  });
  assert.equal(captured[0]?.agentId, undefined, "taskModelChain takes precedence over gatewayAgentId");
});

test("judge falls back to gatewayAgentId when no taskModelChain is set", async () => {
  const config = parseConfig({ modelSource: "gateway", gatewayAgentId: "persona-agent" });
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability([candidate], config, null, captureLlm(captured), new Map(), new Map());

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.agentId, "persona-agent");
  assert.equal(captured[0]?.modelChain, undefined);
});
