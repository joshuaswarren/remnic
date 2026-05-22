import assert from "node:assert/strict";
import test from "node:test";

import {
  createGatewayResponder,
  createProviderBackedAmaBenchRecommendedJudge,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createResponderFromProvider,
  createStructuredJudgeFromProvider,
  compactResponderContext,
  compactResponderQuestion,
} from "./responders.ts";
import { createTimeoutGuardedAdapter } from "./adapters/timeout-guard.ts";
import type { LlmProvider } from "./providers/types.ts";

function createFakeProvider(
  resultText: string,
  onPrompt?: (prompt: string) => void,
): LlmProvider {
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    id: "fake:test-model",
    name: "test-model",
    provider: "openai",
    async complete(prompt) {
      onPrompt?.(prompt);
      inputTokens += prompt.length;
      outputTokens += resultText.length;
      return {
        text: resultText,
        tokens: {
          input: prompt.length,
          output: resultText.length,
        },
        latencyMs: 12,
        model: "test-model",
      };
    },
    getUsage() {
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    },
    resetUsage() {
      inputTokens = 0;
      outputTokens = 0;
    },
  };
}

test("responder wrappers adapt a provider instance into answer-generation and judge surfaces", async () => {
  const responderProvider = createFakeProvider("final answer");
  const responder = createResponderFromProvider(responderProvider);
  const response = await responder.respond("What is the plan?", "Stored memory context");

  assert.equal(response.text, "final answer");
  assert.equal(response.tokens.input > 0, true);
  assert.equal(response.tokens.output > 0, true);
  assert.equal(response.latencyMs, 12);

  const judgeProvider = createFakeProvider("0.82");
  const judge = createProviderBackedJudge({ provider: "openai", model: "gpt-5.4-mini" }, judgeProvider);
  const score = await judge.score("q", "predicted", "expected");
  assert.equal(score, 0.82);
  const judgeResult = await judge.scoreWithMetrics?.("q", "predicted", "expected");
  assert.equal(judgeResult?.score, 0.82);
  assert.equal(judgeResult?.tokens.input > 0, true);
  assert.equal(judgeResult?.tokens.output > 0, true);
  assert.equal(judgeResult?.latencyMs, 12);
  assert.equal(judgeResult?.model, "test-model");

  const cuedJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score: 0.82\nmetadata id: 17"),
  );
  assert.equal(await cuedJudge.score("q", "predicted", "expected"), 0.82);

  const cuedFractionJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Final score: 8/10\ncase: 99"),
  );
  assert.equal(await cuedFractionJudge.score("q", "predicted", "expected"), 0.8);

  const noJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("No."),
  );
  assert.equal(
    (await noJudge.scoreBinaryPrompt?.("yes/no prompt"))?.score,
    0,
  );

  const yesJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Yes."),
  );
  assert.equal(
    (await yesJudge.scoreBinaryPrompt?.("yes/no prompt"))?.score,
    1,
  );

  const invalidBinaryJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("I cannot determine the answer from the prompt."),
  );
  assert.equal(
    (await invalidBinaryJudge.scoreBinaryPrompt?.("yes/no prompt"))?.score,
    -1,
  );

  const structuredProvider = createFakeProvider("{\"identity_accuracy\":0.9,\"stance_coherence\":0.8,\"novelty\":0.7,\"calibration\":0.6,\"notes\":\"ok\"}");
  const structuredJudge = createStructuredJudgeFromProvider(structuredProvider);
  const raw = await structuredJudge.evaluate({
    system: "judge-system",
    user: "judge-user",
    rubricId: "assistant-rubric-v1",
    taskId: "task-1",
  });
  assert.match(raw, /identity_accuracy/);
});

test("responder context compaction preserves referenced trajectory evidence", async () => {
  let capturedPrompt = "";
  const recalledText = Array.from({ length: 80 }, (_, index) => {
    const step = index + 1;
    return `[Action ${step}]: move-${step}\n[Observation ${step}]: state-${step}`;
  }).join("\n");
  const responder = createProviderBackedResponder(
    {
      provider: "openai",
      model: "gpt-5.4-mini",
      responderContextBudgetChars: 900,
    },
    createFakeProvider("answer", (prompt) => {
      capturedPrompt = prompt;
    }),
  );

  await responder.respond(
    "What changed between Actions 41-42?",
    recalledText,
  );

  assert.equal(capturedPrompt.includes("state-42"), true);
  assert.equal(capturedPrompt.includes("move-2"), false);
  assert.equal(capturedPrompt.length < recalledText.length, true);
});

test("responder context compaction preserves trajectory analysis before raw transcript lines", () => {
  const recalledText = [
    "## Explicit Cue Evidence",
    "[Action 115]: go to garbagecan 1",
    "[Observation 115]: You arrive at garbagecan 1.",
    "",
    "## Trajectory analysis",
    "Analyzed labeled action/observation transcript window: steps 0-115 (at).",
    "Timeline for cd 2:",
    "[Action 80]: take cd 2 from desk 2",
    "Inferred cd 2 location at step 115: inventory.",
    "Timeline for cd 3:",
    "[Action 20]: take cd 3 from drawer 4",
    "[Action 24]: move cd 3 to safe 1",
    "Inferred cd 3 location at step 115: safe 1.",
    "",
    "## Search evidence",
    ...Array.from({ length: 120 }, (_, index) =>
      `[Action ${index}]: noisy old action ${index}`,
    ),
  ].join("\n");

  const compacted = compactResponderContext(
    recalledText,
    "What is the location of cd 3, cd 2 at step 115?",
    900,
  );

  assert.match(compacted, /## Trajectory analysis/);
  assert.match(compacted, /Inferred cd 2 location at step 115: inventory/);
  assert.match(compacted, /Inferred cd 3 location at step 115: safe 1/);
  assert.match(compacted, /Action 115/);
  assert.equal(compacted.length <= 900, true);
});

test("compactResponderContext falls back to deterministic head/tail context without trajectory references", () => {
  const compacted = compactResponderContext(
    "alpha ".repeat(200) + "omega",
    "What is the summary?",
    320,
  );

  assert.equal(compacted.length <= 320, true);
  assert.match(compacted, /alpha/);
  assert.match(compacted, /omega/);
  assert.match(compacted, /omitted unrelated recalled context/);
});

test("responder prompt compaction preserves the question and concise agentic protocol", async () => {
  let capturedPrompt = "";
  const longProtocolQuestion = [
    "What did Action 42 accomplish?",
    "",
    "Benchmark answer protocol:",
    "- Use only the supplied Remnic memory context as evidence.",
    "- Return the shortest complete answer that satisfies the question.",
    "",
    "Agentic trajectory protocol:",
    ...Array.from({ length: 40 }, (_, index) =>
      `- Detailed trajectory instruction ${index + 1}.`,
    ),
  ].join("\n");
  const responder = createProviderBackedResponder(
    {
      provider: "openai",
      model: "gpt-5.4-mini",
      responderPromptBudgetChars: 1_200,
    },
    createFakeProvider("answer", (prompt) => {
      capturedPrompt = prompt;
    }),
  );

  await responder.respond(longProtocolQuestion, "[Action 42]: right");

  assert.match(capturedPrompt, /What did Action 42 accomplish\?/);
  assert.match(capturedPrompt, /Agentic trajectory protocol/);
  assert.match(capturedPrompt, /Action N causes Observation N/);
  assert.match(capturedPrompt, /First five and Complete inventory summaries/);
  assert.doesNotMatch(capturedPrompt, /Detailed trajectory instruction 40/);
});

test("compactResponderQuestion validates the prompt budget", () => {
  assert.throws(
    () => compactResponderQuestion("question", 0),
    /responder prompt budget must be a positive integer/,
  );
});

test("provider-backed responder factories reject invalid configs and produce typed wrappers", () => {
  assert.throws(
    () => createProviderBackedResponder({ provider: "openai", model: "" } as never),
    /provider-backed responder requires a non-empty model/i,
  );

  assert.throws(
    () => createProviderBackedJudge({ provider: "openai", model: "" } as never),
    /provider-backed judge requires a non-empty model/i,
  );

  const responder = createProviderBackedResponder({
    provider: "openai",
    model: "gpt-5.4-mini",
  });
  assert.equal(typeof responder.respond, "function");
});

test("gateway responder requires gateway config", () => {
  assert.throws(
    () => createGatewayResponder({}),
    /gateway responder requires gatewayConfig/i,
  );
});

test("gateway responder forwards profile-scoped auth context to the fallback client", async () => {
  let capturedGatewayConfig: unknown;
  let capturedRuntimeContext: unknown;

  const responder = createGatewayResponder({
    gatewayConfig: {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
    },
    agentId: "memory-primary",
    agentDir: "/tmp/openclaw-profile/agents/main/agent",
    workspaceDir: "/tmp/openclaw-profile/workspace",
    llmFactory(gatewayConfig, runtimeContext) {
      capturedGatewayConfig = gatewayConfig;
      capturedRuntimeContext = runtimeContext;
      return {
        async chatCompletion() {
          return {
            content: "answer",
            modelUsed: "openai/gpt-5.4-mini",
            usage: {
              inputTokens: 5,
              outputTokens: 2,
            },
          };
        },
      };
    },
  });

  const response = await responder.respond("What changed?", "Context");

  assert.equal(response.text, "answer");
  assert.deepEqual(capturedGatewayConfig, {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.4-mini",
        },
      },
    },
  });
  assert.deepEqual(capturedRuntimeContext, {
    agentDir: "/tmp/openclaw-profile/agents/main/agent",
    workspaceDir: "/tmp/openclaw-profile/workspace",
  });
});

test("gateway responder forwards benchmark abort signals to the fallback client", async () => {
  let observedAbort = false;

  const responder = createGatewayResponder({
    gatewayConfig: {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
    },
    llmFactory() {
      return {
        async chatCompletion(_messages, options) {
          assert.ok(options.signal, "expected gateway responder to pass the benchmark signal");
          await new Promise<never>((_, reject) => {
            options.signal!.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(options.signal!.reason);
              },
              { once: true },
            );
          });
        },
      };
    },
  });

  const adapter = createTimeoutGuardedAdapter(
    {
      async store() {},
      async recall() {
        return "";
      },
      async search() {
        return [];
      },
      async reset() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      async destroy() {},
      responder,
    },
    {
      benchmarkId: "gateway-responder-test",
      timeoutMs: 5,
    },
  );

  await assert.rejects(
    () => adapter.responder!.respond("What changed?", "Context"),
    /benchmark phase timed out after 5ms: gateway-responder-test:respond/,
  );
  assert.equal(observedAbort, true);
});

test("provider-backed judge parses fraction and percent score formats", async () => {
  const fractionJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("8/10"),
  );
  assert.equal(await fractionJudge.score("q", "predicted", "expected"), 0.8);

  const extendedFractionJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score: 7/20"),
  );
  assert.equal(await extendedFractionJudge.score("q", "predicted", "expected"), 0.35);

  const percentJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("75%"),
  );
  assert.equal(await percentJudge.score("q", "predicted", "expected"), 0.75);

  const outOfJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score: 8 out of 10"),
  );
  assert.equal(await outOfJudge.score("q", "predicted", "expected"), 0.8);
});

test("AMA-Bench recommended judge uses binary JSON scoring", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider('{"score":1,"reason":"same fact"}'),
  );

  const result = await judge.scoreWithMetrics?.("q", "predicted", "expected");
  assert.equal(result?.score, 1);
  assert.equal(result?.model, "test-model");
});

test("AMA-Bench recommended judge parses incorrect before correct", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("incorrect"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0);
});

test("AMA-Bench recommended judge scans multiple JSON objects for score", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider('Reasoning object: {"note":"ignore"}\nFinal: {"score":1,"reason":"same fact"}'),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 1);
});

test("AMA-Bench recommended judge prefers the last scored JSON object", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider('Draft: {"score":0,"reason":"scratch"}\nFinal: {"score":1,"reason":"same fact"}'),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 1);
});

test("AMA-Bench recommended judge parses nested JSON score objects", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider('{"analysis":{"note":"nested braces are valid"},"score":1}'),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 1);
});

test("AMA-Bench recommended judge does not treat benign no-phrases as negative", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("No issues found; the answer is correct."),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 1);
});

test("AMA-Bench recommended judge treats negated negative labels as correct", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("This is not incorrect."),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 1);

  const failJudge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("It doesn't fail."),
  );

  assert.equal(await failJudge.score("q", "predicted", "expected"), 1);
});

test("AMA-Bench recommended judge treats negated positive labels as incorrect", async () => {
  const judge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("The answer is not correct."),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0);

  const passJudge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("This does not pass."),
  );

  assert.equal(await passJudge.score("q", "predicted", "expected"), 0);

  const adjectiveJudge = createProviderBackedAmaBenchRecommendedJudge(
    { provider: "openai", model: "qwen3-32b" },
    createFakeProvider("This is not a correct answer."),
  );

  assert.equal(await adjectiveJudge.score("q", "predicted", "expected"), 0);
});

test("provider-backed judge ignores date-like fractions and uses the trailing score", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 2026/04/19. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});

test("provider-backed judge does not treat month/day text as a slash score", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 4/20. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});

test("provider-backed judge rejects date-like slash triplets before trailing scores", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 4/5/2026. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});

test("provider-backed judge does not treat month/day pairs as slash scores", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 4/5. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});

test("provider-backed judge ignores trailing large scalar metadata after a normalized score", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score is 0.5. Reviewed 2026"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.5);
});

test("provider-backed judge keeps out-of parsing stable across repeated calls", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score: 8 out of 10"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.8);
  assert.equal(await judge.score("q", "predicted", "expected"), 0.8);
});
