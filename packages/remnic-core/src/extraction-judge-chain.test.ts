import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { judgeFactDurability, JUDGE_SYSTEM_PROMPT, judgeMaxTokens } from "./extraction-judge.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import type { LocalLlmClient } from "./local-llm.js";

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

// Regression (Studio 2026-10-29): the judge hardcoded timeoutMs: 1500 while the
// deployed local model needs tens of seconds — 94 straight aborts, 0 completions.
// The timeout must come from config so operators can set one the model can meet.

test("judge forwards the configured timeout to the local LLM call", async () => {
  const config = parseConfig({ extractionJudgeTimeoutMs: 45_000 });
  const captured: Array<Record<string, unknown>> = [];
  const localLlm = {
    chatCompletion: async (_messages: unknown, options: Record<string, unknown>) => {
      captured.push(options);
      return { content: JSON.stringify([{ index: 0, durable: true, reason: "ok" }]) };
    },
  } as unknown as LocalLlmClient;

  await judgeFactDurability([candidate], config, localLlm, null, new Map(), new Map());

  assert.equal(captured.length, 1, "judge should call the local LLM once");
  assert.equal(captured[0]?.timeoutMs, 45_000);
});

// ---------------------------------------------------------------------------
// Compact verdict request (PR 3264 follow-up): the judge asks for a minimal
// `[{"index":N,"kind":"accept|reject|defer"}]` reply with a batch-scaled
// completion budget (≤256 tokens) instead of a flat 2048. The big budget let
// a verbose 59-305s reply hide inside the old 150s timeout; the compact one
// makes each call fast enough for the new 20s default.
// ---------------------------------------------------------------------------

function captureLocal(captured: Array<Record<string, unknown>>, content?: string): LocalLlmClient {
  return {
    chatCompletion: async (_messages: unknown, options: Record<string, unknown>) => {
      captured.push(options);
      return {
        content:
          content ??
          JSON.stringify([{ index: 0, kind: "reject" }]),
      };
    },
  } as unknown as LocalLlmClient;
}

const EIGHT_CANDIDATES = Array.from({ length: 8 }, (_, i) => ({
  text: `sample candidate fact ${i}`,
  category: "preference",
  confidence: 0.5,
}));

test("judge uses a compact completion budget scaled to the batch size", async () => {
  const config = parseConfig({});
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability(EIGHT_CANDIDATES, config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured.length, 1, "judge should call the local LLM once");
  assert.equal(captured[0]?.maxTokens, judgeMaxTokens(8));
  assert.ok(
    (captured[0]?.maxTokens as number) <= 256,
    `completion budget must stay small, got ${captured[0]?.maxTokens}`,
  );
});

test("judgeMaxTokens scales with batch size under a small cap", () => {
  assert.equal(judgeMaxTokens(1), 64);
  assert.equal(judgeMaxTokens(8), 192);
  assert.equal(judgeMaxTokens(20), 256);
  assert.equal(judgeMaxTokens(500), 256, "small cap");
});

test("system prompt requests the compact verdict shape only", () => {
  const lines = JUDGE_SYSTEM_PROMPT.split("\n");
  const exampleIdx = lines.findIndex((l) => l.trim() === "Example output:");
  assert.ok(exampleIdx >= 0, "prompt must contain an 'Example output:' line");
  const example = JSON.parse(lines[exampleIdx + 1].trim()) as Array<Record<string, unknown>>;
  assert.ok(example.length > 0);
  for (const item of example) {
    assert.equal(typeof item.index, "number");
    assert.ok(
      item.kind === "accept" || item.kind === "reject" || item.kind === "defer",
      `example kind must be a parser-accepted verdict, got ${item.kind}`,
    );
    assert.equal(item.reason, undefined, "compact request must not ask for reasons");
    assert.equal(item.durable, undefined, "compact request must not ask for the durable flag");
  }
});

test("judge still accepts the legacy verbose verdict shape", async () => {
  const config = parseConfig({});
  const captured: Array<Record<string, unknown>> = [];
  const llm = captureLocal(
    captured,
    JSON.stringify([
      { index: 0, kind: "accept", durable: true, reason: "Stable preference" },
      { index: 1, durable: false, reason: "Ephemeral build status" },
      { index: 2, kind: "defer", durable: false, reason: "Ambiguous pronoun" },
    ]),
  );
  const candidates = [
    { text: "user prefers dark mode", category: "preference", confidence: 0.5 },
    { text: "the build is running now", category: "task", confidence: 0.5 },
    { text: "he said they'd follow up", category: "task", confidence: 0.5 },
  ];

  const result = await judgeFactDurability(candidates, config, llm, null, new Map(), new Map());

  assert.deepEqual(
    { ...result.verdicts.get(0) },
    { durable: true, reason: "Stable preference", kind: "accept" },
  );
  assert.deepEqual(
    { ...result.verdicts.get(1) },
    { durable: false, reason: "Ephemeral build status" },
  );
  assert.deepEqual(
    { ...result.verdicts.get(2) },
    { durable: false, reason: "Ambiguous pronoun", kind: "defer" },
  );
});

// ---------------------------------------------------------------------------
// Judge model override: extractionJudgeModel must reach the LLM call options
// (options.model) on both the local and fallback paths, and stay absent when
// unset so routing keeps the default model.
// ---------------------------------------------------------------------------

test("judge forwards extractionJudgeModel to the local LLM options", async () => {
  const config = parseConfig({ extractionJudgeModel: "qwen3.8-27b-64k-nothink" });
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability([candidate], config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured[0]?.model, "qwen3.8-27b-64k-nothink");
});

test("judge omits model from local LLM options when extractionJudgeModel is unset", async () => {
  const config = parseConfig({});
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability([candidate], config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured[0]?.model, undefined);
});

test("judge forwards extractionJudgeModel to the fallback LLM options in gateway mode", async () => {
  const config = parseConfig({ modelSource: "gateway", extractionJudgeModel: "fast-judge" });
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability([candidate], config, null, captureLlm(captured), new Map(), new Map());

  assert.equal(captured[0]?.model, "fast-judge");
});

test("judge defaults to a 20s timeout when none is configured", async () => {
  const config = parseConfig({});
  const captured: Array<Record<string, unknown>> = [];

  await judgeFactDurability([candidate], config, null, captureLlm(captured), new Map(), new Map());

  assert.equal(captured[0]?.timeoutMs, 20_000);
});
