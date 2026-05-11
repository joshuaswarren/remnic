import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import type { BufferTurn } from "./types.js";

test("gateway extraction fallback honors configured timeout and output budget", async () => {
  const config = parseConfig({
    modelSource: "gateway",
    localLlmTimeoutMs: 600_000,
    extractionMaxOutputTokens: 32_768,
    gatewayConfig: {
      agents: {
        defaults: { model: { primary: "bench-internal/gpt-5.5" } },
        list: [],
      },
      models: {
        providers: {
          "bench-internal": {
            api: "codex-cli",
            baseUrl: "codex-cli://local",
            models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
          },
        },
      },
    },
  });
  const engine = new ExtractionEngine(config);
  let capturedOptions: { timeoutMs?: number; maxTokens?: number } | undefined;

  (engine as unknown as {
    fallbackLlm: {
      parseWithSchemaDetailed(
        messages: unknown,
        schema: unknown,
        options: { timeoutMs?: number; maxTokens?: number },
      ): Promise<unknown>;
    };
  }).fallbackLlm = {
    async parseWithSchemaDetailed(_messages, _schema, options) {
      capturedOptions = options;
      return {
        modelUsed: "bench-internal/gpt-5.5",
        result: {
          facts: [],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
      };
    },
  };

  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "Remember that the analytics database is PostgreSQL.",
      timestamp: "2026-05-08T00:00:00.000Z",
    },
  ];

  await engine.extract(turns);

  assert.equal(capturedOptions?.timeoutMs, 600_000);
  assert.equal(capturedOptions?.maxTokens, 32_768);
});

test("gateway extraction labels context-only replay turns", async () => {
  const config = parseConfig({
    modelSource: "gateway",
    gatewayConfig: {
      agents: {
        defaults: { model: { primary: "bench-internal/gpt-5.5" } },
        list: [],
      },
      models: {
        providers: {
          "bench-internal": {
            api: "codex-cli",
            baseUrl: "codex-cli://local",
            models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
          },
        },
      },
    },
  });
  const engine = new ExtractionEngine(config);
  let capturedMessages:
    | Array<{ role: string; content: string }>
    | undefined;

  (engine as unknown as {
    fallbackLlm: {
      parseWithSchemaDetailed(
        messages: Array<{ role: string; content: string }>,
      ): Promise<unknown>;
    };
  }).fallbackLlm = {
    async parseWithSchemaDetailed(messages) {
      capturedMessages = messages;
      return {
        modelUsed: "bench-internal/gpt-5.5",
        result: {
          facts: [],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
      };
    },
  };

  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "What does the fixture call the depot?",
      timestamp: "2026-05-08T00:00:00.000Z",
      extractionContextOnly: true,
    },
    {
      role: "assistant",
      content: "It calls the depot cedar hall.",
      timestamp: "2026-05-08T00:00:01.000Z",
    },
  ];

  await engine.extract(turns);

  assert.ok(capturedMessages);
  const systemPrompt = capturedMessages[0]?.content ?? "";
  const conversationPrompt = capturedMessages[1]?.content ?? "";
  assert.match(systemPrompt, /reference context only/);
  assert.match(
    conversationPrompt,
    /\[context user\] What does the fixture call the depot\?/,
  );
  assert.match(
    conversationPrompt,
    /\[assistant\] It calls the depot cedar hall\./,
  );
});

test("extraction skips mechanical action telemetry without durable memory cues", async () => {
  const config = parseConfig({
    modelSource: "gateway",
    gatewayConfig: {
      agents: {
        defaults: { model: { primary: "bench-internal/gpt-5.5" } },
        list: [],
      },
      models: {
        providers: {
          "bench-internal": {
            api: "codex-cli",
            baseUrl: "codex-cli://local",
            models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
          },
        },
      },
    },
  });
  const engine = new ExtractionEngine(config);
  let fallbackCalls = 0;

  (engine as unknown as {
    fallbackLlm: {
      parseWithSchemaDetailed(): Promise<unknown>;
    };
  }).fallbackLlm = {
    async parseWithSchemaDetailed() {
      fallbackCalls += 1;
      return {
        modelUsed: "bench-internal/gpt-5.5",
        result: {
          facts: [],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
      };
    },
  };

  const turns: BufferTurn[] = [
    { role: "user", content: "[Action 0]: left", timestamp: "2026-05-08T00:00:00.000Z" },
    {
      role: "assistant",
      content: "[Observation 0]: Active rules:\nbaba is you\n\nObjects on the map:\nrule `is` 3 step to the left and 3 step up\nball 2 step up",
      timestamp: "2026-05-08T00:00:01.000Z",
    },
    { role: "user", content: "[Action 1]: up", timestamp: "2026-05-08T00:00:02.000Z" },
    {
      role: "assistant",
      content: "[Observation 1]: Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step to the left and 2 step up\nball 1 step to the right",
      timestamp: "2026-05-08T00:00:03.000Z",
    },
  ];

  const result = await engine.extract(turns);

  assert.equal(fallbackCalls, 0);
  assert.deepEqual(result, { facts: [], profileUpdates: [], entities: [], questions: [] });
});

test("extraction keeps action transcripts with durable memory cues", async () => {
  const config = parseConfig({
    modelSource: "gateway",
    gatewayConfig: {
      agents: {
        defaults: { model: { primary: "bench-internal/gpt-5.5" } },
        list: [],
      },
      models: {
        providers: {
          "bench-internal": {
            api: "codex-cli",
            baseUrl: "codex-cli://local",
            models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
          },
        },
      },
    },
  });
  const engine = new ExtractionEngine(config);
  let fallbackCalls = 0;

  (engine as unknown as {
    fallbackLlm: {
      parseWithSchemaDetailed(): Promise<unknown>;
    };
  }).fallbackLlm = {
    async parseWithSchemaDetailed() {
      fallbackCalls += 1;
      return {
        modelUsed: "bench-internal/gpt-5.5",
        result: {
          facts: [],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
      };
    },
  };

  const turns: BufferTurn[] = [
    { role: "user", content: "[Action 0]: left", timestamp: "2026-05-08T00:00:00.000Z" },
    {
      role: "assistant",
      content: "[Observation 0]: Active rules:\nbaba is you\n\nObjects on the map:\nrule `is` 3 step to the left and 3 step up\nball 2 step up",
      timestamp: "2026-05-08T00:00:01.000Z",
    },
    { role: "user", content: "Remember that this puzzle needs ball is win.", timestamp: "2026-05-08T00:00:02.000Z" },
    {
      role: "assistant",
      content: "[Observation 1]: Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step to the left and 2 step up\nball 1 step to the right",
      timestamp: "2026-05-08T00:00:03.000Z",
    },
  ];

  await engine.extract(turns);

  assert.equal(fallbackCalls, 1);
});
