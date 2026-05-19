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

test("contradiction judge ignores unmatched pairKey verdicts", async () => {
  const localLlm = {
    async chatCompletion() {
      return {
        content: JSON.stringify([
          {
            pairKey: "x:y",
            verdict: "contradicts",
            rationale: "This pair is not in the request.",
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
        textB: "Joshua uses npm",
      },
      {
        memoryIdA: "c",
        memoryIdB: "d",
        textA: "Remnic stores memories locally",
        textB: "Remnic stores memories locally",
      },
    ],
    {} as PluginConfig,
    localLlm,
    null,
    new Map(),
  );

  assert.equal(result.judged, 2);
  assert.equal(result.results.get("a:b")?.verdict, "needs-user");
  assert.equal(result.results.get("a:b")?.confidence, 0);
  assert.equal(result.results.get("c:d")?.verdict, "needs-user");
  assert.equal(result.results.get("c:d")?.confidence, 0);
  assert.equal(result.results.has("x:y"), false);
});

test("contradiction judge does not positional-fallback after unmatched pairKey verdicts", async () => {
  const localLlm = {
    async chatCompletion() {
      return {
        content: JSON.stringify([
          {
            pairKey: "x:y",
            verdict: "contradicts",
            rationale: "This pair is not in the request.",
            confidence: 0.9,
          },
          {
            verdict: "duplicates",
            rationale: "This unkeyed verdict should not shift onto a requested pair.",
            confidence: 0.8,
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
        textB: "Joshua uses npm",
      },
      {
        memoryIdA: "c",
        memoryIdB: "d",
        textA: "Remnic stores memories locally",
        textB: "Remnic stores memories locally",
      },
    ],
    {} as PluginConfig,
    localLlm,
    null,
    new Map(),
  );

  assert.equal(result.judged, 2);
  assert.equal(result.results.get("a:b")?.verdict, "needs-user");
  assert.equal(result.results.get("a:b")?.confidence, 0);
  assert.equal(result.results.get("c:d")?.verdict, "needs-user");
  assert.equal(result.results.get("c:d")?.confidence, 0);
});

test("contradiction judge fallback ignores skipped response items without shifting verdicts", async () => {
  const localLlm = {
    async chatCompletion() {
      return {
        content: JSON.stringify([
          null,
          {
            verdict: "duplicates",
            rationale: "The first requested pair is equivalent.",
            confidence: 0.8,
          },
          {
            verdict: "independent",
            rationale: "The second requested pair is unrelated.",
            confidence: 0.7,
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
        textA: "Remnic stores memories locally",
        textB: "Remnic stores memories locally",
      },
      {
        memoryIdA: "c",
        memoryIdB: "d",
        textA: "Joshua uses pnpm",
        textB: "Joshua uses npm",
      },
    ],
    {} as PluginConfig,
    localLlm,
    null,
    new Map(),
  );

  assert.equal(result.judged, 2);
  assert.equal(result.results.get("a:b")?.verdict, "duplicates");
  assert.equal(result.results.get("c:d")?.verdict, "independent");
});
