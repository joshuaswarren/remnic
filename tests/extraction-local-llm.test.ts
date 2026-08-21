import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../packages/remnic-core/src/config.js";
import { ExtractionEngine } from "../packages/remnic-core/src/extraction.js";

test("local LLM extraction salvages complete facts from truncated JSON", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    localLlmEnabled: true,
    localLlmFallback: false,
    proactiveExtractionEnabled: false,
  });
  const localLlm = {
    async chatCompletion() {
      return {
        content:
          '{"facts":[{"category":"fact","content":"User prefers dark mode","confidence":0.9},',
      };
    },
  };
  const engine = new ExtractionEngine(config, undefined, localLlm as any);

  const result = await engine.extract([
    {
      role: "user",
      content: "User prefers dark mode.",
      timestamp: "2026-05-21T00:00:00.000Z",
    },
  ]);

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.category, "fact");
  assert.equal(result.facts[0]?.content, "User prefers dark mode");
  assert.equal(result.facts[0]?.confidence, 0.9);
});
