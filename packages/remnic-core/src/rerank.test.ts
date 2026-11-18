import assert from "node:assert/strict";
import test from "node:test";

import {
  rerankOutputTokenBudget,
  RERANK_LLM_SNIPPET_CHARS,
  RerankCache,
  parseRerankResponse,
  rerankLocalOrNoop,
} from "./rerank.js";

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
          content: JSON.stringify({ order: ["a", "b"] }),
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
  assert.equal(calls[0]?.options?.maxTokens, rerankOutputTokenBudget(2));
  assert.equal(calls[0]?.options?.timeoutMs, 1_500);
  const user = JSON.parse(calls[0]?.messages[1]?.content ?? "{}");
  assert.ok(Array.isArray(user.c));
  assert.ok(user.c[0][1].length <= RERANK_LLM_SNIPPET_CHARS);
});

test("rerankOutputTokenBudget grows with candidate count", () => {
  assert.equal(rerankOutputTokenBudget(2), 44);
  assert.equal(rerankOutputTokenBudget(8), 104);
  assert.ok(rerankOutputTokenBudget(30) <= 256);
});

test("parseRerankResponse accepts compact order array", () => {
  const candidates = [
    { id: "a", originalIndex: 0 },
    { id: "b", originalIndex: 1 },
    { id: "c", originalIndex: 2 },
  ];
  const ranked = parseRerankResponse(
    JSON.stringify({ order: ["b", "a"] }),
    candidates
  );
  assert.deepEqual(
    ranked.map((x) => x.id),
    ["b", "a", "c"]
  );
});

test("rerankLocalOrNoop caps timeout at 2500ms for fail-open", async () => {
  const calls: Array<{ options?: { timeoutMs?: number } }> = [];
  await rerankLocalOrNoop({
    query: "q",
    candidates: [
      { id: "a", snippet: "x" },
      { id: "b", snippet: "y" },
    ],
    local: {
      async chatCompletion(_messages, options) {
        calls.push({ options });
        return { content: JSON.stringify({ order: ["a", "b"] }) };
      },
    },
    enabled: true,
    timeoutMs: 60_000,
    maxCandidates: 5,
    cacheEnabled: false,
    cacheTtlMs: 1,
  });
  assert.equal(calls[0]?.options?.timeoutMs, 2500);
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
          content: JSON.stringify({ order: ["a", "b"] }),
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

test("rerankLocalOrNoop cache keys distinguish candidate IDs containing commas", async () => {
  let calls = 0;
  const cache = new RerankCache();
  const commonOptions = {
    query: "API rate limit issue",
    local: {
      async chatCompletion() {
        calls += 1;
        return {
          content:
            calls === 1
              ? JSON.stringify({ order: ["c", "a,b"] })
              : JSON.stringify({ order: ["b,c", "a"] }),
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

  const first = await rerankLocalOrNoop({
    ...commonOptions,
    candidates: [
      { id: "a,b", snippet: "API rate limit is 1000 requests per minute." },
      { id: "c", snippet: "Deployment note." },
    ],
  });
  assert.deepEqual(first, ["c", "a,b"]);

  const second = await rerankLocalOrNoop({
    ...commonOptions,
    candidates: [
      { id: "a", snippet: "API rate limit is 1000 requests per minute." },
      { id: "b,c", snippet: "Deployment note." },
    ],
  });
  assert.deepEqual(second, ["b,c", "a"]);
  assert.equal(calls, 2);
});
