/**
 * Tests for the local model-lab endpoint resolver + openai-compatible caller
 * (issue #1585). Pure unit tests — the fetch caller takes an injected
 * `fetchImpl`, so no network, no GPU, no live server.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveFaithfulnessGateEndpoint,
  resolveCorrectionIntentEndpoint,
  callOpenAiCompatibleChat,
  type EndpointChatMessage,
} from "./local-model-endpoint.js";

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

test("resolveFaithfulnessGateEndpoint: null when either key empty (default = no pointer)", () => {
  assert.equal(resolveFaithfulnessGateEndpoint({ extractionFaithfulnessModel: "", extractionFaithfulnessBaseUrl: "" }), null);
  assert.equal(resolveFaithfulnessGateEndpoint({ extractionFaithfulnessModel: "m", extractionFaithfulnessBaseUrl: "" }), null);
  assert.equal(resolveFaithfulnessGateEndpoint({ extractionFaithfulnessModel: "", extractionFaithfulnessBaseUrl: "http://x/v1" }), null);
  // whitespace-only counts as empty.
  assert.equal(resolveFaithfulnessGateEndpoint({ extractionFaithfulnessModel: "  ", extractionFaithfulnessBaseUrl: "http://x/v1" }), null);
});

test("resolveFaithfulnessGateEndpoint: returns trimmed endpoint when both keys set", () => {
  const ep = resolveFaithfulnessGateEndpoint({
    extractionFaithfulnessModel: "  remnic-faithfulness-gate-v1  ",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
  });
  assert.deepEqual(ep, { baseUrl: "http://localhost:11434/v1", model: "remnic-faithfulness-gate-v1" });
});

test("resolveCorrectionIntentEndpoint: same contract as the gate resolver", () => {
  assert.equal(resolveCorrectionIntentEndpoint({ correctionIntentModel: "", correctionIntentBaseUrl: "" }), null);
  assert.equal(resolveCorrectionIntentEndpoint({ correctionIntentModel: "m", correctionIntentBaseUrl: "" }), null);
  assert.deepEqual(
    resolveCorrectionIntentEndpoint({ correctionIntentModel: "ci-v1", correctionIntentBaseUrl: "http://localhost:8000/v1" }),
    { baseUrl: "http://localhost:8000/v1", model: "ci-v1" },
  );
});

// ---------------------------------------------------------------------------
// callOpenAiCompatibleChat — injected fetch, no network
// ---------------------------------------------------------------------------

/** Build a minimal Response-shaped object the caller reads (ok, json, .json). */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MESSAGES: EndpointChatMessage[] = [
  { role: "system", content: "verifier" },
  { role: "user", content: "fact vs quote" },
];

test("callOpenAiCompatibleChat: happy path — first choice content + reported model", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> | undefined;
  const fakeFetch = (url: string, init: RequestInit): Promise<Response> => {
    calledUrl = url;
    calledBody = JSON.parse(String(init.body));
    return Promise.resolve(
      jsonResponse(200, {
        model: "remnic-faithfulness-gate-v1",
        choices: [{ message: { content: '[{"index":0,"verdict":"entailed"}]' } }],
      }),
    );
  };
  const result = await callOpenAiCompatibleChat(
    { baseUrl: "http://localhost:11434/v1", model: "remnic-faithfulness-gate-v1" },
    MESSAGES,
    { timeoutMs: 5000, temperature: 0.1, maxTokens: 2048, responseFormatJson: true },
    fakeFetch as typeof fetch,
  );
  assert.equal(result?.content, '[{"index":0,"verdict":"entailed"}]');
  assert.equal(result?.modelUsed, "remnic-faithfulness-gate-v1");
  // URL joined correctly (no double slash), body carries model + json_object format.
  assert.equal(calledUrl, "http://localhost:11434/v1/chat/completions");
  assert.equal(calledBody?.model, "remnic-faithfulness-gate-v1");
  assert.deepEqual(calledBody?.response_format, { type: "json_object" });
  assert.equal(calledBody?.max_tokens, 2048);
});

test("callOpenAiCompatibleChat: trailing slash on baseUrl is tolerated", async () => {
  const seen = (await callOpenAiCompatibleChat(
    { baseUrl: "http://localhost:11434/v1/", model: "m" },
    MESSAGES,
    { timeoutMs: 1000 },
    ((url: string) => {
      assert.equal(url, "http://localhost:11434/v1/chat/completions");
      return Promise.resolve(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    }) as typeof fetch,
  ))!;
  assert.equal(seen.content, "ok");
  assert.equal(seen.modelUsed, "m"); // server reported no model → falls back to requested name
});

test("callOpenAiCompatibleChat: returns null on non-2xx (fail closed)", async () => {
  const result = await callOpenAiCompatibleChat(
    { baseUrl: "http://x/v1", model: "m" },
    MESSAGES,
    { timeoutMs: 1000 },
    (() => Promise.resolve(jsonResponse(500, { error: "boom" }))) as typeof fetch,
  );
  assert.equal(result, null);
});

test("callOpenAiCompatibleChat: returns null on network error (fail closed)", async () => {
  const result = await callOpenAiCompatibleChat(
    { baseUrl: "http://x/v1", model: "m" },
    MESSAGES,
    { timeoutMs: 1000 },
    (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
  );
  assert.equal(result, null);
});

test("callOpenAiCompatibleChat: returns null on malformed body (no fabricated shape)", async () => {
  for (const body of [
    null,
    {},
    { choices: [] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: 42 } }] }, // non-string content
    { choices: "not-an-array" },
  ]) {
    const result = await callOpenAiCompatibleChat(
      { baseUrl: "http://x/v1", model: "m" },
      MESSAGES,
      { timeoutMs: 1000 },
      (() => Promise.resolve(jsonResponse(200, body))) as typeof fetch,
    );
    assert.equal(result, null, `body ${JSON.stringify(body)} should yield null`);
  }
});

test("callOpenAiCompatibleChat: returns null on .json() throw", async () => {
  const result = await callOpenAiCompatibleChat(
    { baseUrl: "http://x/v1", model: "m" },
    MESSAGES,
    { timeoutMs: 1000 },
    (() =>
      Promise.resolve(
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      )) as typeof fetch,
  );
  assert.equal(result, null);
});
