import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  planRecallModeLLM,
  resolveRecallPlannerLlmOptions,
} from "./recall-planner-llm.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import type { RecallPlanMode } from "./types.js";

// A stub FallbackLlmClient that records the options it was called with and
// returns a scripted classification (or simulates a failure).
function stubLlm(opts: {
  available?: boolean;
  capturedOptions?: Array<Record<string, unknown>>;
  result?: { mode: RecallPlanMode; reason?: string | null } | null;
  modelUsed?: string;
  throwError?: string;
}): FallbackLlmClient {
  return {
    isAvailable: () => opts.available !== false,
    parseWithSchemaDetailed: async (
      _messages: unknown,
      schema: { parse: (v: unknown) => unknown },
      options: Record<string, unknown>,
    ) => {
      opts.capturedOptions?.push(options);
      if (opts.throwError) throw new Error(opts.throwError);
      if (opts.result === null || opts.result === undefined) return null;
      // Exercise the real schema so malformed scripted output is caught too.
      const parsed = schema.parse(opts.result);
      return { result: parsed, modelUsed: opts.modelUsed ?? "test/model" };
    },
  } as unknown as FallbackLlmClient;
}

test("returns heuristic without calling the LLM when recallPlannerLlmEnabled is false", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: false });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ capturedOptions: captured, result: { mode: "no_recall" } });

  const result = await planRecallModeLLM("what did we decide about auth?", undefined, config, llm);

  assert.equal(captured.length, 0, "LLM must not be contacted when disabled");
  assert.equal(result.source, "heuristic");
  assert.equal(result.fallbackUsed, false);
  // Memory-seeking question → heuristic "full".
  assert.equal(result.mode, "full");
  assert.equal(result.heuristicMode, "full");
});

test("uses the LLM classification when enabled", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const llm = stubLlm({ result: { mode: "graph_mode", reason: "asks for root cause" }, modelUsed: "anthropic/claude" });

  const result = await planRecallModeLLM("restart the gateway", undefined, config, llm);

  assert.equal(result.source, "llm");
  assert.equal(result.mode, "graph_mode");
  assert.equal(result.reason, "asks for root cause");
  assert.equal(result.modelUsed, "anthropic/claude");
  assert.equal(result.fallbackUsed, false);
});

test("forwards taskModelChain AND recallPlannerModel in gateway mode (provider-agnostic routing)", async () => {
  const config = parseConfig({
    recallPlannerLlmEnabled: true,
    modelSource: "gateway",
    gatewayAgentId: "persona-agent",
    taskModelChain: { primary: "zai/glm-4.7-flash", fallbacks: ["fireworks/x/glm-5p1"] },
    recallPlannerModel: "anthropic/claude-haiku-4-5",
  });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ capturedOptions: captured, result: { mode: "minimal" } });

  await planRecallModeLLM("check status", undefined, config, llm);

  assert.equal(captured.length, 1);
  // recallPlannerModel is tried first (prepended), taskModelChain is the fallback chain.
  assert.equal(captured[0]?.model, "anthropic/claude-haiku-4-5");
  assert.deepEqual(captured[0]?.modelChain, {
    primary: "zai/glm-4.7-flash",
    fallbacks: ["fireworks/x/glm-5p1"],
  });
  // taskModelChain wins over the agent persona (gotcha #22).
  assert.equal(captured[0]?.agentId, undefined);
  assert.equal(captured[0]?.timeoutMs, config.recallPlannerTimeoutMs);
});

test("plugin mode passes only the explicit model, no gateway chain", async () => {
  const config = parseConfig({
    recallPlannerLlmEnabled: true,
    modelSource: "plugin",
    recallPlannerModel: "openai/gpt-5.5",
  });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ capturedOptions: captured, result: { mode: "full" } });

  await planRecallModeLLM("summarize the project", undefined, config, llm);

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.model, "openai/gpt-5.5");
  assert.equal(captured[0]?.modelChain, undefined);
  assert.equal(captured[0]?.agentId, undefined);
});

test("falls back to heuristic when the LLM throws", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const llm = stubLlm({ throwError: "boom" });

  const result = await planRecallModeLLM("what happened during the outage?", undefined, config, llm);

  assert.equal(result.source, "heuristic-fallback");
  assert.equal(result.fallbackUsed, true);
  assert.match(result.reason, /llm-error:boom/);
  // "what happened" → heuristic graph_mode.
  assert.equal(result.mode, "graph_mode");
  assert.equal(result.mode, result.heuristicMode);
});

test("falls back to heuristic when the LLM returns no parseable result", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const llm = stubLlm({ result: null });

  const result = await planRecallModeLLM("how did we get here?", undefined, config, llm);

  assert.equal(result.source, "heuristic-fallback");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.reason, "llm-empty");
});

test("falls back without a network attempt when the chain is empty and the model is bare (default gpt-5.5)", async () => {
  // The legacy default recallPlannerModel "gpt-5.5" is bare (no provider/),
  // which FallbackLlmClient cannot resolve — so with no gateway chain there is
  // nothing routable and the planner must short-circuit to the heuristic
  // (issue #1367 review on PR #1428), not log an invalid-model warning per call.
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ available: false, capturedOptions: captured, result: { mode: "full" } });

  const result = await planRecallModeLLM("anything", undefined, config, llm);

  assert.equal(captured.length, 0, "no network attempt when nothing is routable");
  assert.equal(result.source, "heuristic-fallback");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.reason, "llm-no-model");
});

test("attempts the call (and falls back) when a provider-qualified model override is set even if the chain is empty", async () => {
  // A qualified `provider/model` override is genuinely routable, so we attempt
  // it even when the chain probe reports unavailable, then fall back on a null
  // response.
  const config = parseConfig({ recallPlannerLlmEnabled: true, recallPlannerModel: "openai/gpt-5.5" });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ available: false, capturedOptions: captured, result: null });

  const result = await planRecallModeLLM("anything", undefined, config, llm);

  assert.equal(captured.length, 1, "qualified model override → still attempt the call");
  assert.equal(captured[0]?.model, "openai/gpt-5.5");
  assert.equal(result.source, "heuristic-fallback");
  assert.equal(result.reason, "llm-empty");
});

test("an already-aborted recall short-circuits to the heuristic without an LLM call", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true, recallPlannerModel: "openai/gpt-5.5" });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ capturedOptions: captured, result: { mode: "full" } });
  const ac = new AbortController();
  ac.abort();

  const result = await planRecallModeLLM("what did we decide?", undefined, config, llm, ac.signal);

  assert.equal(captured.length, 0, "no LLM call when the recall is already aborted");
  assert.equal(result.source, "heuristic-fallback");
  assert.equal(result.reason, "aborted");
  assert.equal(result.fallbackUsed, true);
});

test("forwards the abort signal into the LLM call (cancellation contract)", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true, recallPlannerModel: "openai/gpt-5.5" });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ capturedOptions: captured, result: { mode: "minimal" } });
  const ac = new AbortController();

  await planRecallModeLLM("check status", undefined, config, llm, ac.signal);

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.signal, ac.signal, "recall abort signal must reach FallbackLlmClient");
});

test("empty prompts skip the LLM entirely", async () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true });
  const captured: Array<Record<string, unknown>> = [];
  const llm = stubLlm({ capturedOptions: captured, result: { mode: "full" } });

  const result = await planRecallModeLLM("   ", undefined, config, llm);

  assert.equal(captured.length, 0);
  assert.equal(result.mode, "no_recall"); // heuristic returns no_recall for empty
  assert.equal(result.source, "heuristic");
});

test("resolveRecallPlannerLlmOptions clamps timeout and sets deterministic decoding", () => {
  const config = parseConfig({ recallPlannerLlmEnabled: true, recallPlannerTimeoutMs: 0 });
  const options = resolveRecallPlannerLlmOptions(config);
  assert.equal(options.temperature, 0);
  assert.equal(options.maxTokens, 64);
  assert.equal(options.timeoutMs, 1500, "non-positive timeout falls back to 1500");
});

test("resolveRecallPlannerLlmOptions drops bare model names but keeps provider-qualified ones", () => {
  // Bare "gpt-5.5" is unresolvable by FallbackLlmClient → dropped (routing falls
  // through to the chain); a qualified value is forwarded as the override.
  const bare = resolveRecallPlannerLlmOptions(
    parseConfig({ recallPlannerLlmEnabled: true, recallPlannerModel: "gpt-5.5" }),
  );
  assert.equal(bare.model, undefined);
  const qualified = resolveRecallPlannerLlmOptions(
    parseConfig({ recallPlannerLlmEnabled: true, recallPlannerModel: "anthropic/claude-haiku-4-5" }),
  );
  assert.equal(qualified.model, "anthropic/claude-haiku-4-5");
});
