import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { judgeFactDurability, JUDGE_SYSTEM_PROMPT, judgeMaxTokens, MAX_JUDGE_BATCH, MAX_JUDGE_TOKENS } from "./extraction-judge.js";
import { FallbackLlmClient } from "./fallback-llm.js";
import type { FallbackLlmOptions, FallbackLlmResponse } from "./fallback-llm.js";
import { LocalLlmClient } from "./local-llm.js";
import type { LocalLlmChatCompletionOptions, LocalLlmChatCompletionResult } from "./local-llm-helpers.js";

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

type ChatOptions = LocalLlmChatCompletionOptions;

/** A real FallbackLlmClient whose gateway call is replaced: records the options the judge passes. */
class RecordingFallbackLlm extends FallbackLlmClient {
  constructor(private readonly sink: FallbackLlmOptions[]) {
    super();
  }

  override isAvailable(): boolean {
    return true;
  }

  override async chatCompletion(
    _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: FallbackLlmOptions = {},
  ): Promise<FallbackLlmResponse | null> {
    this.sink.push(options);
    return { content: JSON.stringify([{ index: 0, durable: true, reason: "ok" }]), modelUsed: "recording-fake" };
  }
}

/** A real LocalLlmClient whose network call is replaced: records the options the judge passes. */
class RecordingLocalLlm extends LocalLlmClient {
  constructor(
    private readonly sink: ChatOptions[],
    private readonly reply: string,
  ) {
    super(parseConfig({}));
  }

  override async chatCompletion(
    _messages: Array<{ role: string; content: string }>,
    options: ChatOptions = {},
  ): Promise<LocalLlmChatCompletionResult | null> {
    this.sink.push(options);
    return { content: this.reply };
  }
}

interface ExampleVerdict {
  index?: number;
  kind?: string;
  reason?: string;
  durable?: boolean;
}

// Regression (Studio 2026-10-29): the judge hardcoded timeoutMs: 1500 while the
// deployed local model needs tens of seconds — 94 straight aborts, 0 completions.
// The timeout must come from config so operators can set one the model can meet.

test("judge forwards the configured timeout to the local LLM call", async () => {
  const config = parseConfig({ extractionJudgeTimeoutMs: 45_000 });
  const captured: ChatOptions[] = [];
  const localLlm = new RecordingLocalLlm(captured, JSON.stringify([{ index: 0, durable: true, reason: "ok" }]));

  await judgeFactDurability([candidate], config, localLlm, null, new Map(), new Map());

  assert.equal(captured.length, 1, "judge should call the local LLM once");
  assert.equal(captured[0]?.timeoutMs, 45_000);
});

// ---------------------------------------------------------------------------
// Compact verdict request (PR 3264 follow-up): the judge asks for a minimal
// `[{"index":N,"kind":"accept|reject|defer"}]` reply with a batch-scaled
// completion budget (≤256 tokens) instead of a flat 2048. The big budget let
// a verbose 59-305s reply hide inside the old 150s timeout; the compact one
// measures 2.1-2.5 s per call on a small fast judge model (13-22 s, 41 s
// verbose on the big shared core model), inside the 20s default.
// ---------------------------------------------------------------------------

function captureLocal(captured: ChatOptions[], content?: string): LocalLlmClient {
  return new RecordingLocalLlm(captured, content ?? JSON.stringify([{ index: 0, kind: "reject" }]));
}

const EIGHT_CANDIDATES = Array.from({ length: 8 }, (_, i) => ({
  text: `sample candidate fact ${i}`,
  category: "preference",
  confidence: 0.5,
}));

test("judge uses a compact completion budget scaled to the batch size", async () => {
  const config = parseConfig({});
  const captured: ChatOptions[] = [];

  await judgeFactDurability(EIGHT_CANDIDATES, config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured.length, 1, "judge should call the local LLM once");
  assert.equal(captured[0]?.maxTokens, judgeMaxTokens(8));
  assert.ok(
    (captured[0]?.maxTokens ?? Number.POSITIVE_INFINITY) <= judgeMaxTokens(8),
    `completion budget must stay small, got ${captured[0]?.maxTokens}`,
  );
});

test("judgeMaxTokens leaves room for one verdict per candidate, up to a cap", () => {
  assert.equal(judgeMaxTokens(1), 64);
  assert.equal(judgeMaxTokens(8), 192);
  assert.ok(judgeMaxTokens(50) >= 50 * 16, "a 50-candidate batch needs a verdict array that fits");
  assert.equal(judgeMaxTokens(500), 2048, "cap");
});

test("judge bounds the whole local call, retries included, with one deadline signal", async () => {
  const config = parseConfig({ extractionJudgeTimeoutMs: 45_000 });
  const captured: ChatOptions[] = [];

  await judgeFactDurability([candidate], config, captureLocal(captured), null, new Map(), new Map());

  assert.ok(captured[0]?.signal instanceof AbortSignal, "judge passes an AbortSignal so retries share one deadline");
  assert.equal(captured[0]?.signal?.aborted, false);
});


test("system prompt requests the compact verdict shape only", () => {
  const lines = JUDGE_SYSTEM_PROMPT.split("\n");
  const exampleIdx = lines.findIndex((l) => l.trim() === "Example output:");
  assert.ok(exampleIdx >= 0, "prompt must contain an 'Example output:' line");
  // SAFETY: the line is the example JSON checked into the prompt text this test pins.
  const example = JSON.parse(lines[exampleIdx + 1].trim()) as { verdicts?: ExampleVerdict[] };
  assert.ok(
    Array.isArray(example.verdicts) && example.verdicts.length > 0,
    'example must use the {"verdicts":[...]} wrapper — response_format json_object rejects a bare top-level array',
  );
  for (const item of example.verdicts) {
    assert.ok(Number.isInteger(item.index), "example index must be an integer");
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
  const captured: ChatOptions[] = [];
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

test("judge parses the {\"verdicts\":[...]} wrapper object the prompt requests", async () => {
  const config = parseConfig({});
  const captured: ChatOptions[] = [];
  const llm = captureLocal(
    captured,
    JSON.stringify({
      verdicts: [
        { index: 0, kind: "accept" },
        { index: 1, kind: "reject" },
      ],
    }),
  );
  const candidates = [
    { text: "user prefers dark mode", category: "preference", confidence: 0.5 },
    { text: "the build is running now", category: "task", confidence: 0.5 },
  ];

  const result = await judgeFactDurability(candidates, config, llm, null, new Map(), new Map());

  assert.equal(result.judged, 2, "both verdicts must resolve from the wrapper");
  assert.equal(result.verdicts.get(0)?.kind, "accept");
  assert.equal(result.verdicts.get(1)?.kind, "reject");
});

test("judge still parses the compact bare-array shape", async () => {
  const config = parseConfig({});
  const captured: ChatOptions[] = [];
  const llm = captureLocal(
    captured,
    JSON.stringify([
      { index: 0, kind: "reject" },
      { index: 1, kind: "accept" },
    ]),
  );
  const candidates = [
    { text: "the build is running now", category: "task", confidence: 0.5 },
    { text: "user prefers dark mode", category: "preference", confidence: 0.5 },
  ];

  const result = await judgeFactDurability(candidates, config, llm, null, new Map(), new Map());

  assert.equal(result.judged, 2, "both verdicts must resolve from the bare array");
  assert.equal(result.verdicts.get(0)?.kind, "reject");
  assert.equal(result.verdicts.get(1)?.kind, "accept");
});

test("judge treats a single verdict object as one verdict at its index, not the whole batch", async () => {
  const config = parseConfig({});
  const captured: ChatOptions[] = [];
  const llm = captureLocal(captured, JSON.stringify({ index: 1, kind: "reject" }));
  const candidates = [
    { text: "user prefers dark mode", category: "preference", confidence: 0.5 },
    { text: "the build is running now", category: "task", confidence: 0.5 },
    { text: "he said they'd follow up", category: "task", confidence: 0.5 },
  ];

  const result = await judgeFactDurability(candidates, config, llm, null, new Map(), new Map());

  assert.equal(result.judged, 1, "only the indexed candidate comes from the LLM");
  assert.equal(result.verdicts.get(1)?.kind, "reject");
  assert.equal(result.verdicts.get(1)?.durable, false);
  assert.equal(result.verdicts.get(0)?.kind, undefined, "index 0 must not inherit the reject");
  assert.equal(result.verdicts.get(0)?.durable, true, "index 0 fail-open approves");
  assert.equal(result.verdicts.get(2)?.kind, undefined, "index 2 must not inherit the reject");
  assert.equal(result.verdicts.get(2)?.durable, true, "index 2 fail-open approves");
});

// ---------------------------------------------------------------------------
// Judge model override: extractionJudgeModel must reach the LLM call options
// (options.model) on both the local and fallback paths, and stay absent when
// unset so routing keeps the default model.
// ---------------------------------------------------------------------------

test("judge forwards extractionJudgeModel to the local LLM options", async () => {
  const config = parseConfig({ extractionJudgeModel: "qwen3.8-27b-64k-nothink" });
  const captured: ChatOptions[] = [];

  await judgeFactDurability([candidate], config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured[0]?.model, "qwen3.8-27b-64k-nothink");
});

test("judge omits model from local LLM options when extractionJudgeModel is unset", async () => {
  const config = parseConfig({});
  const captured: ChatOptions[] = [];

  await judgeFactDurability([candidate], config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured[0]?.model, undefined);
});

test("judge forwards extractionJudgeModel to the fallback LLM options in gateway mode", async () => {
  const config = parseConfig({ modelSource: "gateway", extractionJudgeModel: "fast-judge" });
  const captured: FallbackLlmOptions[] = [];

  await judgeFactDurability([candidate], config, null, new RecordingFallbackLlm(captured), new Map(), new Map());

  assert.equal(captured[0]?.model, "fast-judge");
});

test("judge defaults to a 20s timeout when none is configured", async () => {
  const config = parseConfig({});
  const captured: FallbackLlmOptions[] = [];

  await judgeFactDurability([candidate], config, null, new RecordingFallbackLlm(captured), new Map(), new Map());

  assert.equal(captured[0]?.timeoutMs, 20_000);
});

test("a configured batch size above what the token cap can answer is split", async () => {
  const config = parseConfig({ extractionJudgeBatchSize: 200 });
  const captured: ChatOptions[] = [];
  const candidates = Array.from({ length: 200 }, (_, i) => ({
    text: `distinct candidate fact number ${i}`,
    category: "preference",
    confidence: 0.5,
  }));

  await judgeFactDurability(candidates, config, captureLocal(captured), null, new Map(), new Map());

  assert.equal(captured.length, 3, "200 candidates at 85 per request");
  for (const call of captured) {
    assert.ok((call.maxTokens ?? 0) <= MAX_JUDGE_TOKENS, "never above the cap");
  }
  assert.equal(MAX_JUDGE_BATCH * 24 <= MAX_JUDGE_TOKENS, true, "a full batch fits its own budget");
});
