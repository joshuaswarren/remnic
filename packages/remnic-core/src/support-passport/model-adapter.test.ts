import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { parseConfig } from "../config.js";
import { SupportPassportError } from "./errors.js";
import {
  SupportPassportModelAdapter,
  acceptsSupportPassportModelResponse,
  type SupportPassportModelClients,
  type SupportPassportModelRoute,
  buildSupportPassportDirectGatewayConfig,
  createSupportPassportModelAdapter,
  resolveSupportPassportModelRoutePlan,
} from "./model-adapter.js";
import { SUPPORT_PASSPORT_NOT_IN_GUIDE_ANSWER } from "./model-contracts.js";

function route(
  kind: SupportPassportModelRoute["kind"],
  content: string | null,
  calls: string[]
): SupportPassportModelRoute {
  return {
    kind,
    invoke: async () => {
      calls.push(kind);
      return content === null ? null : { content, modelUsed: `${kind}/test-model` };
    },
  };
}

test("the cross-process response check rejects invented draft and answer citations", () => {
  const draftMessages = [
    { role: "system" as const, content: "Return JSON." },
    {
      role: "user" as const,
      content: JSON.stringify({ sourceNotes: [{ memoryId: "memory-1", content: "Source" }] }),
    },
  ];
  assert.equal(
    acceptsSupportPassportModelResponse(
      "support-passport-draft",
      draftMessages,
      JSON.stringify({
        cards: [{
          title: "Plan changes",
          statement: "Tell me before plans change.",
          category: "transitions",
          sourceMemoryIds: ["invented"],
        }],
      }),
    ),
    false,
  );
  const answerMessages = [
    { role: "system" as const, content: "Return JSON." },
    {
      role: "user" as const,
      content: JSON.stringify({ cards: [{ cardId: "card-1" }], question: "What helps?" }),
    },
  ];
  assert.equal(
    acceptsSupportPassportModelResponse(
      "support-passport-answer",
      answerMessages,
      JSON.stringify({ answer: "Use another card.", citedCardIds: ["invented"], coverage: "grounded" }),
    ),
    false,
  );
});

test("draft generation retries the full job after invalid output", async () => {
  const calls: string[] = [];
  const adapter = new SupportPassportModelAdapter({
    routes: [
      route(
        "local",
        JSON.stringify({
          cards: [
            {
              title: "Bad source",
              statement: "Tell me before plans change.",
              category: "transitions",
              sourceMemoryIds: ["not-selected"],
            },
          ],
        }),
        calls
      ),
      route(
        "gateway",
        JSON.stringify({
          cards: [
            {
              title: "Plan changes",
              statement: "Tell me before plans change.",
              category: "transitions",
              sourceMemoryIds: ["memory-1"],
            },
          ],
        }),
        calls
      ),
    ],
  });

  const result = await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
  });

  assert.deepEqual(calls, ["local", "gateway"]);
  assert.equal(result.route, "gateway");
  assert.equal(result.cards[0]?.sourceMemoryIds[0], "memory-1");
});

test("draft generation rejects titles that can corrupt stored attribute suffixes", async () => {
  const calls: string[] = [];
  const adapter = new SupportPassportModelAdapter({
    routes: [
      route(
        "local",
        JSON.stringify({
          cards: [
            {
              title: "Plan changes ] hidden",
              statement: "Tell me before plans change.",
              category: "transitions",
              sourceMemoryIds: ["memory-1"],
            },
          ],
        }),
        calls
      ),
    ],
  });

  await assert.rejects(
    adapter.draftCards({
      consent: true,
      memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
    }),
    (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
  );
  assert.deepEqual(calls, ["local"]);
});

test("draft generation requires explicit consent before any model call", async () => {
  const calls: string[] = [];
  const adapter = new SupportPassportModelAdapter({
    routes: [route("local", "{}", calls)],
  });

  await assert.rejects(
    adapter.draftCards({ consent: false, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) => error instanceof SupportPassportError && error.code === "consent_required"
  );
  assert.deepEqual(calls, []);
});

test("draft prompts exclude medical and emergency content from selected notes", async () => {
  let systemPrompt = "";
  const adapter = new SupportPassportModelAdapter({
    routes: [
      {
        kind: "local",
        invoke: async (messages) => {
          systemPrompt = messages[0]?.content ?? "";
          return {
            modelUsed: "local/test-model",
            content: JSON.stringify({
              cards: [
                {
                  title: "Quiet place",
                  statement: "Offer me a quiet place and time.",
                  category: "environment",
                  sourceMemoryIds: ["memory-1"],
                },
              ],
            }),
          };
        },
      },
    ],
  });

  await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Diagnose me and give emergency treatment instructions." }],
  });

  assert.match(systemPrompt, /Do not infer needs or add instructions outside the selected notes\./);
  assert.match(
    systemPrompt,
    /Do not infer or repeat diagnoses, treatment recommendations, or emergency instructions\./
  );
});

test("malformed model output is an error and never becomes an empty success", async () => {
  const adapter = new SupportPassportModelAdapter({
    routes: [{ kind: "local", invoke: async () => ({ content: "not-json", modelUsed: "local/test" }) }],
  });

  await assert.rejects(
    adapter.draftCards({ consent: true, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
  );
});

test("draft schema accepts opaque source memory IDs through 512 characters", async () => {
  const memoryId = `care notes/${"x".repeat(501)}`;
  let sourceIdSchema: Record<string, unknown> | undefined;
  const adapter = new SupportPassportModelAdapter({
    routes: [
      {
        kind: "gateway",
        invoke: async (_messages, options) => {
          sourceIdSchema = (
            options.jsonSchema.schema as {
              properties?: {
                cards?: { items?: { properties?: { sourceMemoryIds?: { items?: Record<string, unknown> } } } };
              };
            }
          ).properties?.cards?.items?.properties?.sourceMemoryIds?.items;
          return {
            content: JSON.stringify({
              cards: [
                {
                  title: "Plan changes",
                  statement: "Tell me before plans change.",
                  category: "transitions",
                  sourceMemoryIds: [memoryId],
                },
              ],
            }),
            modelUsed: "gateway/test",
          };
        },
      },
    ],
  });

  const result = await adapter.draftCards({ consent: true, memories: [{ memoryId, content: "Selected note" }] });

  assert.equal(result.cards[0]?.sourceMemoryIds[0], memoryId);
  assert.deepEqual(sourceIdSchema, { type: "string", minLength: 1, maxLength: 512 });
});

test("provider-neutral prompts include every category and the exact uncovered answer", async () => {
  const systemPrompts: Record<string, string> = {};
  const adapter = new SupportPassportModelAdapter({
    routes: [
      {
        kind: "local",
        invoke: async (messages, options) => {
          systemPrompts[options.operation] = messages.find((message) => message.role === "system")?.content ?? "";
          return {
            content:
              options.operation === "support-passport-draft"
                ? JSON.stringify({
                    cards: [
                      {
                        title: "Plan changes",
                        statement: "Tell me before plans change.",
                        category: "transitions",
                        sourceMemoryIds: ["memory-1"],
                      },
                    ],
                  })
                : JSON.stringify({
                    answer: SUPPORT_PASSPORT_NOT_IN_GUIDE_ANSWER,
                    citedCardIds: [],
                    coverage: "not_in_guide",
                  }),
            modelUsed: "local/test",
          };
        },
      },
    ],
  });

  await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
  });
  await adapter.answerQuestion({
    guide: {
      schemaVersion: 1,
      grantId: "00000000-0000-4000-8000-000000000001",
      expiresAt: "2026-08-11T13:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
      cards: [
        {
          cardId: "card-1",
          title: "Quiet space",
          statement: "Offer me a quiet place and time.",
          category: "environment",
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
      ],
    },
    question: "What food helps?",
  });

  assert.match(
    systemPrompts["support-passport-draft"] ?? "",
    /communication, environment, transitions, sensory, regulation, interests, or other/
  );
  assert.ok(systemPrompts["support-passport-answer"]?.includes(SUPPORT_PASSPORT_NOT_IN_GUIDE_ANSWER));
});

test("helper answers cite only shared cards and use the exact uncovered fallback", async () => {
  const guide = {
    schemaVersion: 1 as const,
    grantId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-11T13:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    cards: [
      {
        cardId: "card-1",
        title: "Quiet space",
        statement: "Offer me a quiet place and time.",
        category: "environment" as const,
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
    ],
  };
  const adapter = new SupportPassportModelAdapter({
    routes: [
      {
        kind: "gateway",
        invoke: async () => ({
          content: JSON.stringify({ answer: "Offer a quiet place.", citedCardIds: ["card-1"], coverage: "grounded" }),
          modelUsed: "gateway/test",
        }),
      },
    ],
  });
  const grounded = await adapter.answerQuestion({ guide, question: "What can help?" });
  assert.deepEqual(grounded.answer, "Offer a quiet place.");
  assert.deepEqual(grounded.citedCardIds, ["card-1"]);

  const uncovered = new SupportPassportModelAdapter({
    routes: [
      {
        kind: "local",
        invoke: async () => ({
          content: JSON.stringify({
            answer: "That is not covered in this person's support guide.",
            citedCardIds: [],
            coverage: "not_in_guide",
          }),
          modelUsed: "local/test",
        }),
      },
    ],
  });
  assert.equal((await uncovered.answerQuestion({ guide, question: "What food helps?" })).coverage, "not_in_guide");
});

test("helper model calls send only shared cards and the question", async () => {
  const guide = {
    schemaVersion: 1 as const,
    grantId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-11T13:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    cards: [
      {
        cardId: "card-1",
        title: "Quiet space",
        statement: "Offer me a quiet place and time.",
        category: "environment" as const,
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
    ],
  };
  let payload: unknown;
  const adapter = new SupportPassportModelAdapter({
    routes: [
      {
        kind: "gateway",
        invoke: async (messages) => {
          payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "null");
          return {
            content: JSON.stringify({
              answer: "Offer a quiet place.",
              citedCardIds: ["card-1"],
              coverage: "grounded",
            }),
            modelUsed: "gateway/test",
          };
        },
      },
    ],
  });

  await adapter.answerQuestion({ guide, question: "What can help?" });

  assert.deepEqual(payload, { cards: guide.cards, question: "What can help?" });
});

test("helper answer output rejects foreign citations and invented uncovered answers", async () => {
  const guide = {
    schemaVersion: 1 as const,
    grantId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-11T13:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    cards: [
      {
        cardId: "card-1",
        title: "Quiet space",
        statement: "Offer me a quiet place and time.",
        category: "environment" as const,
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
    ],
  };
  for (const output of [
    { answer: "Use another card.", citedCardIds: ["card-2"], coverage: "grounded" },
    { answer: "I do not know.", citedCardIds: [], coverage: "not_in_guide" },
  ]) {
    const adapter = new SupportPassportModelAdapter({
      routes: [
        { kind: "gateway", invoke: async () => ({ content: JSON.stringify(output), modelUsed: "gateway/test" }) },
      ],
    });
    await assert.rejects(
      adapter.answerQuestion({ guide, question: "What helps?" }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
    );
  }
});

test("route planning preserves Remnic model-source and local fallback rules", () => {
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan(
      {
        modelSource: "gateway",
        localLlmEnabled: true,
        localLlmFallback: true,
        openaiApiKey: "direct-key",
      },
      { gateway: true }
    ),
    ["gateway"]
  );
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan(
      {
        modelSource: "plugin",
        localLlmEnabled: true,
        localLlmFallback: true,
        openaiApiKey: "direct-key",
      },
      { gateway: true }
    ),
    ["local", "direct", "gateway"]
  );
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan(
      {
        modelSource: "plugin",
        localLlmEnabled: true,
        localLlmFallback: false,
        openaiApiKey: "direct-key",
      },
      { gateway: true }
    ),
    ["local"]
  );
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan(
      {
        modelSource: "gateway",
        localLlmEnabled: false,
        localLlmFallback: false,
        openaiApiKey: undefined,
      },
      { gateway: false }
    ),
    []
  );
});

test("local support models work with direct OpenAI disabled", async () => {
  let optionsSeen: Record<string, unknown> | undefined;
  const localLlm = {
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
      };
    },
  } as unknown as NonNullable<SupportPassportModelClients["localLlm"]>;
  const adapter = createSupportPassportModelAdapter(
    parseConfig({
      openaiApiKey: false,
      localLlmEnabled: true,
      localLlmFallback: false,
      localLlmModel: "local-test-model",
      localLlmTimeoutMs: 180_000,
    }),
    { localLlm }
  );

  const result = await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
  });

  assert.equal(result.route, "local");
  assert.equal(result.modelUsed, "local/local-test-model");
  assert.deepEqual(optionsSeen?.responseFormat, { type: "json_object" });
  assert.equal(optionsSeen?.timeoutMs, 180_000);
  assert.equal(optionsSeen?.redactProviderErrors, true);
});

test("gateway support models work with direct OpenAI disabled", async () => {
  let optionsSeen: Record<string, unknown> | undefined;
  const gatewayRoute: NonNullable<SupportPassportModelClients["gatewayRoute"]> = {
    kind: "gateway",
    invoke: async (_messages, options) => {
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
        modelUsed: "gateway/test-model",
      };
    },
  };
  const adapter = createSupportPassportModelAdapter(
    parseConfig({
      modelSource: "gateway",
      openaiApiKey: false,
      gatewayConfig: {
        agents: { defaults: { model: { primary: "gateway/test-model" } } },
        models: {
          providers: {
            gateway: {
              baseUrl: "https://models.example.test/v1",
              api: "openai-completions",
              models: [{ id: "test-model", name: "test-model" }],
            },
          },
        },
      },
    }),
    { gatewayRoute }
  );

  const result = await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
  });

  assert.equal(result.route, "gateway");
  assert.equal(result.modelUsed, "gateway/test-model");
  assert.equal(optionsSeen?.timeoutMs, 30_000);
  assert.equal((optionsSeen?.jsonSchema as { name?: string } | undefined)?.name, "support_passport_drafts");
});

test("gateway model chains preserve invalid output when a later fallback times out", async () => {
  const adapter = new SupportPassportModelAdapter({
    timeoutMs: 20,
    routes: [
      {
        kind: "gateway",
        invoke: async (_messages, options) => {
          const rejected = {
            content: JSON.stringify({ cards: [] }),
            modelUsed: "gateway/primary",
            usage: { totalTokens: 12 },
          };
          assert.equal(options.acceptResponse?.(rejected), false);
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      },
    ],
  });

  await assert.rejects(
    adapter.draftCards({ consent: true, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) =>
      error instanceof SupportPassportError &&
      error.code === "model_output_invalid" &&
      "metadata" in error &&
      (error.metadata as { modelUsed?: string; usage?: { totalTokens?: number } }).modelUsed === "gateway/primary" &&
      (error.metadata as { usage?: { totalTokens?: number } }).usage?.totalTokens === 12
  );
});

test("direct OpenAI models use the existing Responses API transport", () => {
  const config = buildSupportPassportDirectGatewayConfig({
    openaiApiKey: "test-key",
    openaiBaseUrl: undefined,
    model: "test-model",
  });
  assert.deepEqual(config?.models?.providers?.["remnic-direct"], {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    api: "openai-responses",
    models: [{ id: "test-model", name: "test-model" }],
  });
});

test("direct model routing rejects whitespace-only API keys", () => {
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan({
      modelSource: "plugin",
      localLlmEnabled: false,
      localLlmFallback: false,
      openaiApiKey: "   ",
    }),
    []
  );
  assert.equal(
    buildSupportPassportDirectGatewayConfig({
      openaiApiKey: "   ",
      openaiBaseUrl: undefined,
      model: "test-model",
    }),
    undefined
  );
});

test("direct OpenAI route detection ignores repeated trailing slashes", () => {
  const config = buildSupportPassportDirectGatewayConfig({
    openaiApiKey: "test-key",
    openaiBaseUrl: "https://api.openai.com/v1////",
    model: "test-model",
  });
  assert.equal(config?.models?.providers?.["remnic-direct"]?.api, "openai-responses");
  assert.equal(config?.models?.providers?.["remnic-direct"]?.baseUrl, "https://api.openai.com/v1");
});

test("direct compatible APIs keep their configured fallback transport", () => {
  const config = buildSupportPassportDirectGatewayConfig({
    openaiApiKey: "test-key",
    openaiBaseUrl: "https://models.example.test/v1",
    model: "test-model",
  });
  assert.equal(config?.agents?.defaults?.model?.primary, "remnic-direct/test-model");
  assert.deepEqual(config?.models?.providers?.["remnic-direct"], {
    baseUrl: "https://models.example.test/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [{ id: "test-model", name: "test-model" }],
  });
});

test("direct compatible APIs reject base URLs with credentials, queries, or fragments", () => {
  for (const openaiBaseUrl of [
    "https://user:password@models.example.test/v1",
    "https://models.example.test/v1?token=secret",
    "https://models.example.test/v1#endpoint",
  ]) {
    assert.equal(
      buildSupportPassportDirectGatewayConfig({
        openaiApiKey: "test-key",
        openaiBaseUrl,
        model: "test-model",
      }),
      undefined
    );
  }
});

test(
  "direct OpenAI requests use the shared Responses transport without storage or tools",
  { concurrency: false },
  async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            cards: [
              {
                title: "Plan changes",
                statement: "Tell me before plans change.",
                category: "transitions",
                sourceMemoryIds: ["memory-1"],
              },
            ],
          }),
          usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const adapter = createSupportPassportModelAdapter(
        parseConfig({
          modelSource: "plugin",
          openaiApiKey: "test-key",
          openaiBaseUrl: "https://api.openai.com/v1",
          model: "gpt-test",
        })
      );
      await adapter.draftCards({
        consent: true,
        memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
      });
      assert.equal(requestUrl, "https://api.openai.com/v1/responses");
      assert.equal(requestBody.store, false);
      assert.equal(Object.hasOwn(requestBody, "tools"), false);
      assert.equal(Object.hasOwn(requestBody, "parallel_tool_calls"), false);
      const textFormat = (requestBody.text as { format?: Record<string, unknown> } | undefined)?.format;
      assert.equal(textFormat?.type, "json_schema");
      assert.equal(textFormat?.strict, true);
      assert.equal((textFormat?.schema as Record<string, unknown>)?.additionalProperties, false);
      const cards = (textFormat?.schema as { properties?: { cards?: { items?: Record<string, unknown> } } })?.properties
        ?.cards;
      assert.equal(cards?.items?.additionalProperties, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

test("missing model routes return provider_unavailable", async () => {
  const adapter = new SupportPassportModelAdapter({ routes: [] });
  await assert.rejects(
    adapter.draftCards({ consent: true, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) =>
      error instanceof SupportPassportError && error.code === "provider_unavailable" && error.status === 503
  );
});

test("the model deadline aborts provider work", async () => {
  const aborted = Promise.withResolvers<boolean>();
  const adapter = new SupportPassportModelAdapter({
    timeoutMs: 20,
    routes: [
      {
        kind: "gateway",
        invoke: async (_messages, options) =>
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                aborted.resolve(true);
                reject(options.signal?.reason);
              },
              { once: true }
            );
          }),
      },
    ],
  });

  await assert.rejects(
    adapter.draftCards({ consent: true, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) => error instanceof SupportPassportError && error.code === "provider_unavailable"
  );
  assert.equal(await aborted.promise, true);
});

test("a timed-out route does not consume the fallback route timeout", async () => {
  const calls: string[] = [];
  const firstRouteAborted = Promise.withResolvers<boolean>();
  const adapter = new SupportPassportModelAdapter({
    timeoutMs: 20,
    routes: [
      {
        kind: "local",
        invoke: async (_messages, options) => {
          calls.push("local");
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                firstRouteAborted.resolve(true);
                reject(options.signal?.reason);
              },
              { once: true }
            );
          });
        },
      },
      {
        kind: "gateway",
        invoke: async () => {
          calls.push("gateway");
          return {
            modelUsed: "gateway/test-model",
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
          };
        },
      },
    ],
  });

  const result = await adapter.draftCards({
    consent: true,
    memories: [{ memoryId: "memory-1", content: "Tell me before plans change." }],
  });

  assert.equal(await firstRouteAborted.promise, true);
  assert.deepEqual(calls, ["local", "gateway"]);
  assert.equal(result.route, "gateway");
});

test("the support passport model adapter has no custom OpenAI transport", async () => {
  const source = await readFile(new URL("./model-adapter.ts", import.meta.url), "utf8");
  assert.equal(source.includes('from "openai"'), false);
  assert.equal(source.includes("fetch("), false);
});
