import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL,
  OpenAiResponsesJudgeError,
  createOpenAiResponsesBenchJudge,
  createOpenAiResponsesProvider,
} from "./openai-responses.js";

const completedPayload = (score = 1) => ({
  model: DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL,
  status: "completed",
  usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({ score, decision: score === 0 ? "fail" : "pass", reason: "graded" }),
    }],
  }],
});

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withMockFetch(
  implementation: typeof fetch,
  callback: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Responses judge defaults to gpt-5.6 and sends a strict JSON schema", async () => {
  let requestUrl = "";
  let requestBody: Record<string, any> = {};
  await withMockFetch(async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return jsonResponse(completedPayload());
  }, async () => {
    const provider = createOpenAiResponsesProvider({ apiKey: "test-key" });
    const result = await provider.judge({ rubric: "rubric", rubricVersion: "v1", input: "input" });
    assert.equal(result.ok, true);
  });

  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(requestBody.model, DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.deepEqual(requestBody.text.format.schema.required, ["score", "decision", "reason"]);
});

test("Responses judge forwards an explicit model override", async () => {
  let requestedModel = "";
  await withMockFetch(async (_input, init) => {
    requestedModel = JSON.parse(String(init?.body)).model;
    return jsonResponse({ ...completedPayload(), model: "gpt-5.6-2026-07-01" });
  }, async () => {
    const provider = createOpenAiResponsesProvider({ model: "gpt-5.6-2026-07-01" });
    const result = await provider.judge({ rubric: "rubric", rubricVersion: "v1", input: "input" });
    assert.equal(result.ok, true);
  });
  assert.equal(requestedModel, "gpt-5.6-2026-07-01");
});

test("Responses judge trims an adversarial trailing-slash suffix in linear time", async () => {
  let requestUrl = "";
  const repeatedSlashes = "/".repeat(100_000);
  await withMockFetch(async (input) => {
    requestUrl = String(input);
    return jsonResponse(completedPayload());
  }, async () => {
    const provider = createOpenAiResponsesProvider({
      baseUrl: `https://gateway.example/internal//v1${repeatedSlashes}`,
    });
    const result = await provider.judge({ rubric: "rubric", rubricVersion: "v1", input: "input" });
    assert.equal(result.ok, true);
  });

  assert.equal(requestUrl, "https://gateway.example/internal//v1/responses");
});

test("a genuine score of zero is a successful verdict with safe telemetry", async () => {
  await withMockFetch(async () => jsonResponse(completedPayload(0)), async () => {
    const provider = createOpenAiResponsesProvider();
    const result = await provider.judge({
      rubric: "private rubric text",
      rubricVersion: "memcorrect-v1",
      input: "private benchmark input",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.verdict.score, 0);
    assert.deepEqual(provider.getUsage(), { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    const telemetry = provider.getTelemetryEvents()[0];
    assert.deepEqual(telemetry, {
      model: DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL,
      rubricVersion: "memcorrect-v1",
      inputTokens: 12,
      outputTokens: 4,
      latencyMs: telemetry?.latencyMs,
    });
    assert.doesNotMatch(JSON.stringify(telemetry), /private rubric|private benchmark/);
  });
});

test("refusal, malformed verdict, API error, and exhausted rate limit are distinct failures", async (t) => {
  const cases = [
    {
      name: "refusal",
      payload: {
        ...completedPayload(),
        output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot grade" }] }],
      },
      status: 200,
      code: "refusal",
    },
    {
      name: "malformed verdict",
      payload: {
        ...completedPayload(),
        output: [{ type: "message", content: [{ type: "output_text", text: "not-json" }] }],
      },
      status: 200,
      code: "malformed_verdict",
    },
    { name: "API error", payload: { error: { code: "bad_request" } }, status: 400, code: "api_error" },
    { name: "rate limit", payload: { error: { code: "rate_limit_exceeded" } }, status: 429, code: "rate_limited" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withMockFetch(async () => jsonResponse(entry.payload, entry.status), async () => {
        const provider = createOpenAiResponsesProvider({ retryOptions: { maxAttempts: 1 } });
        const result = await provider.judge({ rubric: "rubric", rubricVersion: "v1", input: "input" });
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error.code, entry.code);
        assert.notEqual(result.error.code, "score_0");
      });
    });
  }
});

test("rate-limit retries reuse retryFetch and preserve the structured request", async () => {
  let calls = 0;
  const bodies: string[] = [];
  await withMockFetch(async (_input, init) => {
    calls += 1;
    bodies.push(String(init?.body));
    return calls === 1
      ? jsonResponse({ error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "0" })
      : jsonResponse(completedPayload());
  }, async () => {
    const provider = createOpenAiResponsesProvider({
      retryOptions: { maxAttempts: 2, baseBackoffMs: 0 },
    });
    const result = await provider.judge({ rubric: "rubric", rubricVersion: "v1", input: "input" });
    assert.equal(result.ok, true);
  });
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("BenchJudge throws categorized failures instead of converting them to zero", async () => {
  await withMockFetch(async () => jsonResponse({ error: { code: "bad_request" } }, 400), async () => {
    const judge = createOpenAiResponsesBenchJudge({ retryOptions: { maxAttempts: 1 } });
    await assert.rejects(
      () => judge.score("question", "predicted", "expected"),
      (error: unknown) => error instanceof OpenAiResponsesJudgeError && error.code === "api_error",
    );
  });
});

test("caller aborts are non-retryable categorized failures", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createOpenAiResponsesProvider();
  const result = await provider.judge({
    rubric: "rubric",
    rubricVersion: "v1",
    input: "input",
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "aborted");
  assert.equal(result.error.retryable, false);
});

test("HTTP failures retain status for non-JSON 4xx and exhausted 5xx retries", async (t) => {
  for (const status of [401, 503]) {
    await t.test(String(status), async () => {
      await withMockFetch(async () => new Response("not-json", { status }), async () => {
        const provider = createOpenAiResponsesProvider({ retryOptions: { maxAttempts: 1 } });
        const result = await provider.judge({ rubric: "rubric", rubricVersion: "v1", input: "input" });
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error.code, "api_error");
        assert.equal(result.error.httpStatus, status);
        assert.equal(result.telemetry.httpStatus, status);
      });
    });
  }
});

test("sealed assistant judging uses strict Responses Structured Outputs", async () => {
  let body: Record<string, any> = {};
  const payload = {
    ...completedPayload(),
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      identity_accuracy: 5,
      stance_coherence: 4,
      novelty: 3,
      calibration: 5,
      notes: "ok",
    }) }] }],
  };
  await withMockFetch(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return jsonResponse(payload);
  }, async () => {
    const provider = createOpenAiResponsesProvider();
    const text = await provider.evaluateAssistantRubric({ system: "sealed", user: "task", rubricId: "assistant-v1" });
    assert.match(text, /identity_accuracy/);
  });
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.required, [
    "identity_accuracy", "stance_coherence", "novelty", "calibration", "notes",
  ]);
});
