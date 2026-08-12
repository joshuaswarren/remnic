import assert from "node:assert/strict";
import test from "node:test";

import { createSupportPassportModelAdapter, parseConfig } from "@remnic/core";
import { FallbackLlmClient } from "@remnic/core/fallback-llm";

import { createOpenClawSupportPassportModelRoute } from "./support-passport-model-route.js";

test("OpenClaw gateway models draft support cards without a direct OpenAI key", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  const authorizationHeaders: Array<string | null> = [];
  globalThis.fetch = (async (_url, init) => {
    assert.ok(init?.body, "The gateway request must include a body.");
    const body = JSON.parse(String(init.body)) as { model: string };
    models.push(body.model);
    authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
    const content =
      body.model === "primary"
        ? JSON.stringify({ cards: [{ sourceMemoryIds: ["not-selected"] }] })
        : JSON.stringify({
            cards: [
              {
                title: "Plan changes",
                statement: "Tell me before plans change.",
                category: "transitions",
                sourceMemoryIds: ["memory-1"],
              },
            ],
          });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const config = parseConfig({
      modelSource: "gateway",
      openaiApiKey: false,
      taskModelChain: {
        primary: "gateway/primary",
        fallbacks: ["gateway/fallback"],
      },
      gatewayConfig: {
        agents: { defaults: { model: { primary: "gateway/default" } } },
        models: {
          providers: {
            gateway: {
              baseUrl: "http://127.0.0.1:11434/v1",
              api: "openai-completions",
              models: [
                { id: "primary", name: "primary" },
                { id: "fallback", name: "fallback" },
              ],
            },
          },
        },
      },
    });
    const client = new FallbackLlmClient(config.gatewayConfig);
    const gatewayRoute = createOpenClawSupportPassportModelRoute(config, client);
    const adapter = createSupportPassportModelAdapter(config, { gatewayRoute });

    const result = await adapter.draftCards({
      consent: true,
      memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
    });

    assert.deepEqual(models, ["primary", "fallback"]);
    assert.deepEqual(authorizationHeaders, [null, null]);
    assert.equal(result.route, "gateway");
    assert.equal(result.modelUsed, "gateway/fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenClaw support passport routes preserve private structured model options", async () => {
  let optionsSeen: Record<string, unknown> | undefined;
  const config = parseConfig({
    modelSource: "gateway",
    openaiApiKey: false,
    taskModelChain: { primary: "gateway/private-model" },
  });
  const client = {
    chatCompletion: async (_messages: unknown, options: Record<string, unknown>) => {
      optionsSeen = options;
      return {
        content: JSON.stringify({
          cards: [
            {
              title: "Plan changes",
              statement: "Tell me before plans change.",
              category: "transitions",
              sourceMemoryIds: ["memory-1"],
            },
          ],
        }),
        modelUsed: "gateway/private-model",
      };
    },
  };
  const gatewayRoute = createOpenClawSupportPassportModelRoute(config, client);
  const adapter = createSupportPassportModelAdapter(config, { gatewayRoute });

  await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
  });

  assert.equal(optionsSeen?.store, false);
  assert.equal(optionsSeen?.redactProviderErrors, true);
  assert.deepEqual(optionsSeen?.modelChain, { primary: "gateway/private-model" });
  assert.equal((optionsSeen?.responsesJsonSchema as { name?: string } | undefined)?.name, "support_passport_drafts");
});
