/**
 * Tests for reasoning_trace extraction recognition (issue #564 PR 2).
 *
 * Covers:
 * - ExtractedFactSchema accepts a reasoningTrace payload with steps[],
 *   finalAnswer, and optional observedOutcome.
 * - normalizeReasoningTrace handles both camelCase (finalAnswer,
 *   observedOutcome) and snake_case (final_answer, observed_outcome) keys
 *   coming from loose LLM output.
 * - normalizeReasoningTrace rejects payloads without steps or without a
 *   final answer (conservative gate).
 * - buildReasoningTraceMarkdownBody + parseReasoningTraceFromBody round-trip.
 * - looksLikeReasoningTrace heuristic recognizes ordered multi-step traces
 *   with a final answer, and rejects short / unstructured prose.
 * - The gateway + local-LLM extraction prompts mention reasoning_trace so
 *   the model actually emits it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ExtractedFactSchema } from "../packages/remnic-core/src/schemas.js";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { ExtractionEngine } from "../packages/remnic-core/src/extraction.js";
import type { BufferTurn } from "../packages/remnic-core/src/types.js";
import {
  buildReasoningTraceMarkdownBody,
  buildReasoningTracePersistBody,
  looksLikeReasoningTrace,
  normalizeReasoningTrace,
  normalizeReasoningTraceSteps,
  parseReasoningTraceFromBody,
} from "../packages/remnic-core/src/reasoning-trace-types.js";

describe("ExtractedFactSchema reasoningTrace", () => {
  it("accepts a reasoningTrace with steps and finalAnswer", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "How I picked route-b for the low-latency path",
      confidence: 0.9,
      tags: ["routing"],
      reasoningTrace: {
        steps: [
          { order: 1, description: "Enumerated candidate routes" },
          { order: 2, description: "Measured round-trip times" },
          { order: 3, description: "Picked the lowest p95 under SLO" },
        ],
        finalAnswer: "route-b wins and was pinned",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("accepts reasoningTrace with observedOutcome", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "How I debugged the latency spike",
      confidence: 0.85,
      tags: [],
      reasoningTrace: {
        steps: [
          { order: 1, description: "Checked dashboards" },
          { order: 2, description: "Tailed cache logs" },
        ],
        finalAnswer: "Root cause was undersized cache eviction policy",
        observedOutcome: "Bumped cache size; p95 dropped back within 10m",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("also accepts facts without reasoningTrace (optional field)", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "fact",
      content: "The user runs Postgres 15",
      confidence: 0.95,
      tags: [],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects reasoningTrace with only one step at the schema layer", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "Not a real chain",
      confidence: 0.8,
      tags: [],
      reasoningTrace: {
        steps: [{ order: 1, description: "only one" }],
        finalAnswer: "done",
      },
    });
    assert.equal(parsed.success, false);
  });

  it("accepts snake_case final_answer and observed_outcome at the schema layer", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "Gateway-loose JSON with snake_case keys",
      confidence: 0.8,
      tags: [],
      reasoningTrace: {
        steps: [
          { order: 1, description: "a" },
          { order: 2, description: "b" },
        ],
        final_answer: "answer",
        observed_outcome: "outcome",
      },
    });
    assert.equal(parsed.success, true);
  });

  it("rejects reasoningTrace missing finalAnswer in both camel and snake forms", () => {
    const parsed = ExtractedFactSchema.safeParse({
      category: "reasoning_trace",
      content: "Missing final answer",
      confidence: 0.8,
      tags: [],
      reasoningTrace: {
        steps: [
          { order: 1, description: "a" },
          { order: 2, description: "b" },
        ],
      },
    });
    assert.equal(parsed.success, false);
  });
});

describe("normalizeReasoningTraceSteps", () => {
  it("normalizes string-array steps into numbered step records", () => {
    const steps = normalizeReasoningTraceSteps([
      "First I listed the constraints",
      "Then I ran the spike",
      "Finally I picked React",
    ]);
    assert.equal(steps.length, 3);
    assert.deepEqual(steps.map((s) => s.order), [1, 2, 3]);
    assert.equal(steps[2].description, "Finally I picked React");
  });

  it("accepts object steps with intent / step / text aliases", () => {
    const steps = normalizeReasoningTraceSteps([
      { order: 1, description: "checked dashboards" },
      { intent: "tailed logs" },
      { step: "found the issue" },
    ]);
    assert.equal(steps.length, 3);
    assert.equal(steps[1].description, "tailed logs");
    assert.equal(steps[1].order, 2);
    assert.equal(steps[2].description, "found the issue");
  });

  it("filters out empty / malformed entries", () => {
    const steps = normalizeReasoningTraceSteps([
      { order: 1, description: "" },
      { order: 2, description: "real step" },
      null,
      42,
    ] as unknown as unknown[]);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].description, "real step");
  });
});

describe("normalizeReasoningTrace", () => {
  it("accepts camelCase keys", () => {
    const trace = normalizeReasoningTrace({
      steps: [
        { order: 1, description: "Checked metrics" },
        { order: 2, description: "Rolled back" },
      ],
      finalAnswer: "Deploy had a regression",
      observedOutcome: "Rollback restored service",
    });
    assert.ok(trace);
    assert.equal(trace?.steps.length, 2);
    assert.equal(trace?.finalAnswer, "Deploy had a regression");
    assert.equal(trace?.observedOutcome, "Rollback restored service");
  });

  it("accepts snake_case keys from loose LLM output", () => {
    const trace = normalizeReasoningTrace({
      steps: ["ran tests", "saw failure"],
      final_answer: "Tests flaked because of shared fixtures",
      observed_outcome: "Isolating the fixture fixed it",
    });
    assert.ok(trace);
    assert.equal(trace?.finalAnswer, "Tests flaked because of shared fixtures");
    assert.equal(trace?.observedOutcome, "Isolating the fixture fixed it");
  });

  it("returns null when steps are missing", () => {
    const trace = normalizeReasoningTrace({
      finalAnswer: "yes",
    });
    assert.equal(trace, null);
  });

  it("returns null when finalAnswer is missing", () => {
    const trace = normalizeReasoningTrace({
      steps: [
        { order: 1, description: "step a" },
        { order: 2, description: "step b" },
      ],
    });
    assert.equal(trace, null);
  });

  it("rejects single-step traces (category requires >=2 ordered steps)", () => {
    const trace = normalizeReasoningTrace({
      steps: [{ order: 1, description: "only one step" }],
      finalAnswer: "done",
    });
    assert.equal(trace, null);
  });

  it("returns null for non-objects", () => {
    assert.equal(normalizeReasoningTrace(null), null);
    assert.equal(normalizeReasoningTrace("string"), null);
    assert.equal(normalizeReasoningTrace([1, 2, 3]), null);
  });
});

describe("buildReasoningTraceMarkdownBody / parseReasoningTraceFromBody", () => {
  it("round-trips a normalized trace", () => {
    const trace = {
      steps: [
        { order: 1, description: "Enumerated candidate routes" },
        { order: 2, description: "Measured round-trip times" },
        { order: 3, description: "Picked the lowest p95 under SLO" },
      ],
      finalAnswer: "route-b wins and was pinned",
      observedOutcome: "Latency-budget alarm cleared within the hour",
    };
    const body = buildReasoningTraceMarkdownBody(trace);
    const parsed = parseReasoningTraceFromBody(body);
    assert.ok(parsed);
    assert.equal(parsed?.steps.length, 3);
    assert.equal(parsed?.steps[0].order, 1);
    assert.equal(parsed?.finalAnswer, "route-b wins and was pinned");
    assert.equal(parsed?.observedOutcome, "Latency-budget alarm cleared within the hour");
  });

  it("round-trips a trace without observed outcome", () => {
    const trace = {
      steps: [
        { order: 1, description: "A" },
        { order: 2, description: "B" },
      ],
      finalAnswer: "answer",
    };
    const body = buildReasoningTraceMarkdownBody(trace);
    const parsed = parseReasoningTraceFromBody(body);
    assert.ok(parsed);
    assert.equal(parsed?.observedOutcome, undefined);
  });

  it("parseReasoningTraceFromBody returns null for unrelated markdown", () => {
    assert.equal(parseReasoningTraceFromBody(""), null);
    assert.equal(
      parseReasoningTraceFromBody("Just a random paragraph with no structure."),
      null,
    );
  });

  it("parseReasoningTraceFromBody rejects single-step bodies (>=2 invariant)", () => {
    const body = [
      "## Step 1",
      "",
      "only one step",
      "",
      "## Final Answer",
      "",
      "done",
    ].join("\n");
    assert.equal(parseReasoningTraceFromBody(body), null);
  });

  it("buildReasoningTracePersistBody prepends a title", () => {
    const body = buildReasoningTracePersistBody("How I picked route-b", {
      steps: [
        { order: 1, description: "A" },
        { order: 2, description: "B" },
      ],
      finalAnswer: "route-b",
    });
    assert.ok(body.startsWith("How I picked route-b"));
    assert.ok(body.includes("## Step 1"));
    assert.ok(body.includes("## Final Answer"));
  });
});

describe("looksLikeReasoningTrace heuristic", () => {
  it("recognizes explicit numbered steps with a final answer", () => {
    const msg = [
      "Here's how I debugged the latency spike:",
      "Step 1: I checked the dashboards and CPU was flat.",
      "Step 2: I tailed the cache logs.",
      "Step 3: I saw eviction storms.",
      "Final answer: the cache was undersized.",
    ].join("\n");
    assert.equal(looksLikeReasoningTrace(msg), true);
  });

  it("recognizes first/second/finally ordinal markers", () => {
    const msg = [
      "Let me walk through what I did.",
      "First, I looked at the metrics panel to get a baseline.",
      "Then, I ran a traceroute through the cache tier.",
      "Finally, I verified eviction counters and confirmed the spike.",
      "So the answer is: we had an undersized cache.",
    ].join("\n");
    assert.equal(looksLikeReasoningTrace(msg), true);
  });

  it("rejects short one-liners", () => {
    assert.equal(looksLikeReasoningTrace("Just a single sentence."), false);
  });

  it("rejects prose without ordered steps", () => {
    const msg =
      "I thought about it for a while and decided to switch to Postgres. It felt like the right call.";
    assert.equal(looksLikeReasoningTrace(msg), false);
  });

  it("rejects ordered steps with no resolution marker", () => {
    const msg = [
      "I did a few things:",
      "1. ran the tests",
      "2. reviewed the diff",
      "3. opened a PR",
    ].join("\n");
    assert.equal(looksLikeReasoningTrace(msg), false);
  });

  it("recognizes `answer:` and `result:` final markers in prose (no trailing word required)", () => {
    const withAnswer = [
      "Walk-through:",
      "Step 1: I pulled the logs.",
      "Step 2: I narrowed down the stack trace.",
      "answer: a NullPointerException in the cache layer.",
    ].join("\n");
    assert.equal(looksLikeReasoningTrace(withAnswer), true);

    const withResult = [
      "Here is how I looked into it.",
      "First, I checked dashboards.",
      "Then, I correlated with the deploy log.",
      "result: a stuck canary blocked promotion.",
    ].join("\n");
    assert.equal(looksLikeReasoningTrace(withResult), true);
  });

  it("does not double-count when multiple marker styles appear on one line", () => {
    // Single real step with both "Step 1:" and a "First," marker on one
    // physical line; the heuristic must not treat this as two steps.
    const msg = [
      "Here's a single step but with multiple marker styles blended in.",
      "Step 1: First, I checked the metrics and saw a flat CPU.",
      "So the answer is we had a slow downstream service.",
    ].join("\n");
    assert.equal(looksLikeReasoningTrace(msg), false);
  });
});

describe("extraction prompt includes reasoning_trace guidance", () => {
  // Drive the real extraction paths and assert on the prompt each one actually
  // sends. Grepping the source would pass on text no request ever carries.
  const SOURCE_TURN: BufferTurn = {
    role: "user",
    content: "Here is how I debugged the latency spike, step by step.",
    timestamp: "2026-08-02T12:00:00.000Z",
  };
  const EMPTY_RESULT = JSON.stringify({
    facts: [],
    profileUpdates: [],
    entities: [],
    questions: [],
  });
  const CONTEXT_SIZES = {
    calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }),
  };

  it("the local prompt the model receives describes reasoning_trace", async () => {
    const engine = new ExtractionEngine(
      parseConfig({ localLlmEnabled: true, localLlmModel: "fixture-local", localLlmFallback: false }),
    );
    let prompt = "";
    const localLlm = {
      async chatCompletion(messages: Array<{ content: string }>) {
        prompt = messages[1]?.content ?? "";
        return { content: EMPTY_RESULT };
      },
    };
    assert.equal(Reflect.set(engine, "localLlm", localLlm), true);
    assert.equal(Reflect.set(engine, "modelRegistry", CONTEXT_SIZES), true);

    await engine.extract([SOURCE_TURN]);

    assert.match(prompt, /reasoning_trace: Stored solution chains/);
    assert.ok(
      prompt.includes('"category": "reasoning_trace"'),
      "local prompt should show a reasoning_trace fact example",
    );
    assert.ok(prompt.includes('"reasoningTrace"'), "local prompt should carry the reasoningTrace field");
  });

  it("the gateway prompt the model receives describes reasoning_trace", async () => {
    const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
    let prompt = "";
    const fallbackLlm = {
      async parseWithSchemaDetailed(messages: Array<{ content: string }>) {
        prompt = messages[0]?.content ?? "";
        return { modelUsed: "fixture-gateway", result: JSON.parse(EMPTY_RESULT) };
      },
    };
    assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);

    await engine.extract([SOURCE_TURN]);

    assert.match(prompt, /reasoning_trace: A stored solution chain/);
  });

  it("the direct-client request carries the guidance and the reasoningTrace response shape", async () => {
    const engine = new ExtractionEngine(parseConfig({ openaiApiKey: "fixture-key" }));
    let prompt = "";
    const client = {
      chat: {
        completions: {
          async create(request: { messages: Array<{ content: string }> }) {
            prompt = request.messages[0]?.content ?? "";
            return { choices: [{ message: { content: EMPTY_RESULT } }] };
          },
        },
      },
    };
    assert.equal(Reflect.set(engine, "client", client), true);

    await engine.extract([SOURCE_TURN]);

    assert.match(prompt, /reasoning_trace: A stored solution chain/);
    assert.ok(
      prompt.includes('"reasoningTrace"'),
      "direct-client prompt should carry the reasoningTrace response shape",
    );
  });

  it("normalizeExtractionResultPayload accepts snake_case reasoning_trace key", async () => {
    const src = await readFile(
      new URL("../packages/remnic-core/src/extraction.ts", import.meta.url),
      "utf-8",
    );
    // Source-level guarantee: the normalize path must also read
    // `reasoning_trace` so loose local/direct-client LLM output that uses
    // snake_case keys still surfaces the structured chain.
    assert.ok(
      src.includes("f?.reasoning_trace"),
      "normalizeExtractionResultPayload should fall back to snake_case reasoning_trace",
    );
  });
});
