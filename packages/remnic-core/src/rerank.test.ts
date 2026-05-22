import assert from "node:assert/strict";
import test from "node:test";

import { RerankCache, rerankLocalOrNoop } from "./rerank.js";

test("rerankLocalOrNoop tags rerank requests as recall-critical", async () => {
  const calls: Array<{
    messages: Array<{ role: string; content: string }>;
    options?: {
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      operation?: string;
      priority?: "recall-critical" | "background";
    };
  }> = [];

  const rankedIds = await rerankLocalOrNoop({
    query: "API rate limit issue",
    candidates: [
      { id: "a", snippet: "API rate limit is 1000 requests per minute." },
      { id: "b", snippet: "Deployment note." },
    ],
    local: {
      async chatCompletion(messages, options) {
        calls.push({ messages, options });
        return {
          content: JSON.stringify({
            scores: [
              { id: "a", score: 90 },
              { id: "b", score: 10 },
            ],
          }),
        };
      },
    },
    enabled: true,
    timeoutMs: 1_500,
    maxCandidates: 5,
    cacheEnabled: false,
    cacheTtlMs: 60_000,
  });

  assert.deepEqual(rankedIds, ["a", "b"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.operation, "rerank");
  assert.equal(calls[0]?.options?.priority, "recall-critical");
});

test("rerankLocalOrNoop cache is isolated from caller mutations", async () => {
  let calls = 0;
  const cache = new RerankCache();
  const options = {
    query: "API rate limit issue",
    candidates: [
      { id: "a", snippet: "API rate limit is 1000 requests per minute." },
      { id: "b", snippet: "Deployment note." },
    ],
    local: {
      async chatCompletion() {
        calls += 1;
        return {
          content: JSON.stringify({
            scores: [
              { id: "a", score: 90 },
              { id: "b", score: 10 },
            ],
          }),
        };
      },
    },
    enabled: true,
    timeoutMs: 1_500,
    maxCandidates: 5,
    cache,
    cacheEnabled: true,
    cacheTtlMs: 60_000,
  };

  const first = await rerankLocalOrNoop(options);
  assert.deepEqual(first, ["a", "b"]);
  first?.reverse();
  first?.push("unknown");

  const second = await rerankLocalOrNoop(options);
  assert.deepEqual(second, ["a", "b"]);
  assert.equal(calls, 1);
});
