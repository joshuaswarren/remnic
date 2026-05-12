import assert from "node:assert/strict";
import test from "node:test";

import { judgeContradictionPairs } from "./contradiction-judge.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { PluginConfig } from "../types.js";

test("contradiction judge tags local LLM calls for thinking suppression", async () => {
  const optionsSeen: Array<Record<string, unknown>> = [];
  const localLlm = {
    async chatCompletion(
      _messages: Array<{ role: string; content: string }>,
      options: Record<string, unknown>,
    ) {
      optionsSeen.push(options);
      return {
        content: JSON.stringify([
          {
            pairKey: "a:b",
            verdict: "independent",
            rationale: "The memories cover different details.",
            confidence: 0.9,
          },
        ]),
      };
    },
  } as unknown as LocalLlmClient;

  const result = await judgeContradictionPairs(
    [
      {
        memoryIdA: "a",
        memoryIdB: "b",
        textA: "Joshua uses pnpm",
        textB: "Joshua works on Remnic",
      },
    ],
    {} as PluginConfig,
    localLlm,
    null,
    new Map(),
  );

  assert.equal(optionsSeen[0]?.operation, "contradiction-judge");
  assert.equal(result.judged, 1);
  assert.equal(result.results.get("a:b")?.verdict, "independent");
});
