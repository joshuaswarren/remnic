import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { SupportPassportError } from "./errors.js";
import {
  SupportPassportModelAdapter,
  type SupportPassportModelRoute,
  buildSupportPassportDirectGatewayConfig,
  resolveSupportPassportModelRoutePlan,
} from "./model-adapter.js";

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

test("malformed model output is an error and never becomes an empty success", async () => {
  const adapter = new SupportPassportModelAdapter({
    routes: [{ kind: "local", invoke: async () => ({ content: "not-json", modelUsed: "local/test" }) }],
  });

  await assert.rejects(
    adapter.draftCards({ consent: true, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) => error instanceof SupportPassportError && error.code === "model_output_invalid"
  );
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
  const gatewayConfig = { agents: { defaults: { model: { primary: "openai/gpt-test" } } } };
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan({
      modelSource: "gateway",
      localLlmEnabled: true,
      localLlmFallback: true,
      openaiApiKey: "direct-key",
      gatewayConfig,
    }),
    ["gateway"]
  );
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan({
      modelSource: "plugin",
      localLlmEnabled: true,
      localLlmFallback: true,
      openaiApiKey: "direct-key",
      gatewayConfig,
    }),
    ["local", "direct", "gateway"]
  );
  assert.deepEqual(
    resolveSupportPassportModelRoutePlan({
      modelSource: "plugin",
      localLlmEnabled: true,
      localLlmFallback: false,
      openaiApiKey: "direct-key",
      gatewayConfig,
    }),
    ["local"]
  );
});

test("direct configured API models use the existing fallback client configuration", () => {
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

test("missing model routes return provider_unavailable", async () => {
  const adapter = new SupportPassportModelAdapter({ routes: [] });
  await assert.rejects(
    adapter.draftCards({ consent: true, memories: [{ memoryId: "memory-1", content: "Source" }] }),
    (error: unknown) =>
      error instanceof SupportPassportError && error.code === "provider_unavailable" && error.status === 503
  );
});

test("the support passport model adapter has no custom OpenAI transport", async () => {
  const source = await readFile(new URL("./model-adapter.ts", import.meta.url), "utf8");
  assert.equal(source.includes('from "openai"'), false);
  assert.equal(source.includes("fetch("), false);
});
