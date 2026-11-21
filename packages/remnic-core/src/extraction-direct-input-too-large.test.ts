import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { isRequestTooLargeError } from "./extraction-error-classification.js";
import { ExtractionEngine } from "./extraction.js";
import type { StructuredParseResult } from "./fallback-llm-codex-subscription.js";
import type { BufferTurn, ExtractionResult } from "./types.js";

// Issue #3531: forced and fail-closed flushes send the whole window as one
// atomic direct-client request. When the provider refuses it as too large, the
// failure must say so instead of surfacing as a gateway "no parsed output", and
// it must stay retryable so the retained turns are never parked or dropped.

const SENTENCE = "Moonlight's theme color is green, not blue. ";

// A synthetic window far over the 12,000-char per-call budget.
const OVERSIZED_WINDOW: BufferTurn[] = Array.from({ length: 40 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: SENTENCE.repeat(250),
  timestamp: `2026-11-20T12:${String(index).padStart(2, "0")}:00.000Z`,
}));

class FakeBadRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`${status} ${message}`);
    this.status = status;
  }
}

function engineWithDirectFailure(
  err: Error,
  gatewayResult: StructuredParseResult<ExtractionResult> = {
    result: null,
    failureReason: "no_models",
    errorClass: "no_models",
  },
) {
  const engine = new ExtractionEngine(parseConfig({ openaiApiKey: "fixture-key" }));
  let direct = 0;
  let gateway = 0;
  const client = {
    chat: {
      completions: {
        async create() {
          direct += 1;
          throw err;
        },
      },
    },
  };
  const fallbackLlm = {
    async parseWithSchemaDetailed() {
      gateway += 1;
      return gatewayResult;
    },
  };
  assert.equal(Reflect.set(engine, "client", client), true);
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);
  return { engine, directCalls: () => direct, gatewayCalls: () => gateway };
}

test("an oversized atomic direct request fails as direct_input_too_large and stays retryable", async () => {
  const { engine, directCalls } = engineWithDirectFailure(
    new FakeBadRequestError(400, "The total text input size exceeds 8 MB"),
  );

  const result = await engine.extract(OVERSIZED_WINDOW);

  assert.equal(directCalls(), 1);
  assert.equal(result.extractionFailure, "direct_input_too_large");
  // provider_retryable keeps the window: the drain never counts it toward a drop
  // and the retry layer never long-parks it as a parse failure.
  assert.equal(result.extractionFailureClass, "provider_retryable");
  assert.deepEqual(result.facts, []);
});

test("an HTTP 413 from the direct client is a size rejection too", async () => {
  const { engine } = engineWithDirectFailure(new FakeBadRequestError(413, "Request Entity Too Large"));
  const result = await engine.extract(OVERSIZED_WINDOW);
  assert.equal(result.extractionFailure, "direct_input_too_large");
});

test("the gateway fallback still runs and wins after a direct size rejection", async () => {
  const { engine, gatewayCalls } = engineWithDirectFailure(
    new FakeBadRequestError(400, "This model's maximum context length is 128000 tokens"),
    {
      modelUsed: "fixture-gateway",
      result: {
        facts: [{ category: "fact", content: SENTENCE.trim(), confidence: 0.95, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
    },
  );

  const result = await engine.extract(OVERSIZED_WINDOW);

  assert.equal(gatewayCalls(), 1);
  assert.equal(result.extractionFailure, undefined);
  assert.equal(result.facts[0]?.content, SENTENCE.trim());
});

test("a direct 400 that is not about size keeps the gateway failure", async () => {
  const { engine } = engineWithDirectFailure(new FakeBadRequestError(400, "invalid model id"));
  const result = await engine.extract(OVERSIZED_WINDOW);
  assert.equal(result.extractionFailure, "fallback_no_parsed_output");
});

test("isRequestTooLargeError rejects 400s whose 'exceed' is not about input size", () => {
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "max_tokens exceeds maximum allowed")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "temperature exceeds 2.0")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "quota exceeded")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "spending limit exceeded")), false);
  assert.equal(
    isRequestTooLargeError(new FakeBadRequestError(400, "You exceeded your current quota, please check your plan")),
    false,
  );
});

test("isRequestTooLargeError matches size rejections only", () => {
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(413, "Payload Too Large")), true);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "The total text input size exceeds 8 MB")), true);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "maximum context length is 8192 tokens")), true);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "prompt is too long")), true);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "invalid model id")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(500, "upstream payload too large")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(429, "rate limit exceeded")), false);
  assert.equal(isRequestTooLargeError(new Error("input too large")), false);
});

test("isRequestTooLargeError needs an input subject for 'too large' and 'too long' (#3533)", () => {
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "temperature is too large")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "max_tokens is too large: 9000")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "top_k value is too large")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "stop sequence is too long")), false);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "Request too large for model")), true);
  assert.equal(isRequestTooLargeError(new FakeBadRequestError(400, "prompt is too long")), true);
});
