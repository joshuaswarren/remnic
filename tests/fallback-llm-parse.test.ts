import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { FallbackLlmClient } from "@remnic/core/fallback-llm";

test("FallbackLlmClient.parseWithSchema extracts the correct JSON when multiple JSON blocks exist", async () => {
  const Schema = z.object({ ok: z.literal(true) });

  // Configure a real provider and stub the transport (same seam as
  // fallback-llm-parse-failure.test.ts): since #2969 parseWithSchema routes
  // through the private completeChat() for typed failure outcomes, so an
  // instance-level chatCompletion override no longer intercepts it.
  const client = new FallbackLlmClient({
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
  const content =
    "Here is an example:\n" +
    "```json\n" +
    '{ "ok": false }\n' +
    "```\n\n" +
    "And here is the real answer:\n" +
    '{ "ok": true }';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const out = await client.parseWithSchema(
      [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "Do the thing." },
      ],
      { parse: (d: unknown) => Schema.parse(d) },
    );

    assert.deepEqual(out, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
