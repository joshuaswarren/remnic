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
