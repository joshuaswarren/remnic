/**
 * Distinct structured-parse failure classes (issue #2968).
 *
 * HTTP 200 empty, invalid JSON, schema-invalid JSON, HTTP errors, and the
 * abort/timeout race must not collapse into one reason. Fingerprints stay
 * retryable because these map to provider_retryable / parse_empty, which the
 * extraction-run coordinator never marks processed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { classifyFallbackParseFailure } from "./extraction-error-classification.js";
import { FallbackLlmClient } from "./fallback-llm.js";
import { clearModelsJsonCache } from "./models-json.js";
import { clearSecretCache } from "./resolve-provider-secret.js";

const Schema = z.object({ ok: z.literal(true) });

function makeClient(): FallbackLlmClient {
  return new FallbackLlmClient({
    agents: { defaults: { model: { primary: "openai/test-model" } } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://openai.example/v1",
          api: "openai-completions",
          apiKey: "key",
          models: [],
        },
      },
    },
  });
}

async function parse(
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = makeClient();
  try {
    return await client.parseWithSchemaDetailed(
      [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "Do the thing." },
      ],
      { parse: (data: unknown) => Schema.parse(data) },
      { temperature: 0, maxTokens: 16, ...options },
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("parseWithSchemaDetailed: HTTP 200 empty content is empty, not http_error", { concurrency: false }, async () => {
  const detailed = await parse(async () =>
    jsonResponse({ choices: [{ message: { content: "" } }] }),
  );
  assert.equal(detailed.result, null);
  if (detailed.result !== null) throw new Error("expected failure");
  assert.equal(detailed.failureReason, "empty");
  assert.equal(detailed.errorClass, "empty");
  assert.equal(classifyFallbackParseFailure(detailed.failureReason), "parse_empty");
});

test("parseWithSchemaDetailed: invalid JSON is empty, not schema_rejection", { concurrency: false }, async () => {
  const detailed = await parse(async () =>
    jsonResponse({ choices: [{ message: { content: "not-json {{{" } }] }),
  );
  assert.equal(detailed.result, null);
  if (detailed.result !== null) throw new Error("expected failure");
  assert.equal(detailed.failureReason, "empty");
  assert.equal(detailed.errorClass, "empty");
  assert.notEqual(detailed.failureReason, "schema_rejection");
  assert.notEqual(detailed.failureReason, "http_error");
  assert.equal(classifyFallbackParseFailure(detailed.failureReason), "parse_empty");
});

test("parseWithSchemaDetailed: schema-invalid JSON is schema_rejection", { concurrency: false }, async () => {
  const detailed = await parse(async () =>
    jsonResponse({ choices: [{ message: { content: '{"ok":false}' } }] }),
  );
  assert.equal(detailed.result, null);
  if (detailed.result !== null) throw new Error("expected failure");
  assert.equal(detailed.failureReason, "schema_rejection");
  assert.equal(detailed.errorClass, "schema_rejection");
  assert.equal(detailed.attemptedModel, "openai/test-model");
  assert.equal(classifyFallbackParseFailure(detailed.failureReason), "parse_empty");
});

test("parseWithSchemaDetailed: HTTP error is http_error with redacted status class", { concurrency: false }, async () => {
  const detailed = await parse(
    async () =>
      new Response("upstream error: auth rejected by upstream (401 Unauthorized)", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
  );
  assert.equal(detailed.result, null);
  if (detailed.result !== null) throw new Error("expected failure");
  assert.equal(detailed.failureReason, "http_error");
  assert.equal(detailed.httpStatus, 502);
  assert.equal(detailed.errorClass, "http_5xx");
  assert.equal(detailed.attemptedModel, "openai/test-model");
  assert.equal(classifyFallbackParseFailure(detailed.failureReason), "provider_retryable");
  const serialized = JSON.stringify(detailed);
  assert.equal(serialized.includes("auth rejected"), false);
  assert.equal(serialized.includes("Unauthorized"), false);
});

test("parseWithSchemaDetailed: abort/timeout race is timeout, not http_error", { concurrency: false }, async () => {
  const detailed = await parse(
    async (_url, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    { timeoutMs: 25 },
  );
  assert.equal(detailed.result, null);
  if (detailed.result !== null) throw new Error("expected failure");
  assert.equal(detailed.failureReason, "timeout");
  assert.equal(detailed.errorClass, "timeout");
  assert.notEqual(detailed.failureReason, "http_error");
  assert.equal(classifyFallbackParseFailure(detailed.failureReason), "provider_retryable");
});

test("parseWithSchemaDetailed: success shape still uses modelUsed as discriminant", { concurrency: false }, async () => {
  const detailed = await parse(async () =>
    jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }),
  );
  assert.equal("modelUsed" in detailed, true);
  assert.notEqual(detailed.result, null);
  if (detailed.result === null) throw new Error("expected success");
  assert.deepEqual(detailed.result, { ok: true });
  assert.equal(detailed.modelUsed, "openai/test-model");
});
