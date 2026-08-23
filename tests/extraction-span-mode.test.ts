import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../packages/remnic-core/src/config.js";
import { ExtractionEngine } from "../packages/remnic-core/src/extraction.js";

const TURN = "I moved to Seattle last spring for a new role.";

function config(spanMode: "off" | "shadow" | "on") {
  return parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    localLlmEnabled: true,
    localLlmFallback: false,
    proactiveExtractionEnabled: false,
    extraction: { spanMode },
  });
}

function turns() {
  return [
    {
      role: "user" as const,
      content: TURN,
      timestamp: "2026-05-21T00:00:00.000Z",
    },
  ];
}

function spanResponse(overrides?: { charStart?: number; charEnd?: number; content?: string }) {
  const start = TURN.indexOf("moved to Seattle last spring");
  return {
    content: JSON.stringify({
      facts: [
        {
          category: "fact",
          content: overrides?.content ?? "User moved to Seattle last spring for a new role.",
          confidence: 0.9,
          tags: ["relocation"],
          span: {
            sourceMessageIndex: 0,
            charStart: overrides?.charStart ?? start,
            charEnd: overrides?.charEnd ?? start + "moved to Seattle last spring".length,
            frame: "User's relocation",
          },
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    }),
  };
}

test("spanMode on: extraction materializes frame+span content before sanitize/grounding", async () => {
  const engine = new ExtractionEngine(config("on"), undefined, {
    async chatCompletion() {
      return spanResponse();
    },
  } as never);
  const result = await engine.extract(turns());
  assert.equal(result.facts.length, 1);
  assert.equal(
    result.facts[0]?.content,
    "User's relocation: moved to Seattle last spring",
  );
  assert.equal(result.facts[0]?.span, undefined, "offsets die at materialization");
});

test("spanMode shadow: persisted facts are byte-identical to spanMode off", async () => {
  const shadowResult = await new ExtractionEngine(config("shadow"), undefined, {
    async chatCompletion() {
      return spanResponse();
    },
  } as never).extract(turns());
  const offResult = await new ExtractionEngine(config("off"), undefined, {
    async chatCompletion() {
      return spanResponse();
    },
  } as never).extract(turns());

  assert.equal(shadowResult.facts.length, 1);
  assert.equal(offResult.facts.length, 1);
  // Zero-diff: shadow persists the generated content exactly as off does
  // (off strips the stray span untrusted; shadow materializes only to
  // compare). Everything downstream sees the same single content form.
  assert.deepEqual(shadowResult.facts, offResult.facts);
  assert.equal(
    shadowResult.facts[0]?.content,
    "User moved to Seattle last spring for a new role.",
  );
  assert.equal(shadowResult.facts[0]?.span, undefined);
});

test("spanMode on: invalid span falls open per fact to generated content", async () => {
  const engine = new ExtractionEngine(config("on"), undefined, {
    async chatCompletion() {
      return spanResponse({ charEnd: TURN.length + 10 });
    },
  } as never);
  const result = await engine.extract(turns());
  assert.equal(result.facts.length, 1);
  assert.equal(
    result.facts[0]?.content,
    "User moved to Seattle last spring for a new role.",
  );
  assert.equal(result.facts[0]?.span, undefined);
});

test("spanMode off with stray span: stripped, extraction otherwise unchanged", async () => {
  const engine = new ExtractionEngine(config("off"), undefined, {
    async chatCompletion() {
      return spanResponse({ charStart: 0, charEnd: 5 });
    },
  } as never);
  const result = await engine.extract(turns());
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.content, "User moved to Seattle last spring for a new role.");
  assert.equal(result.facts[0]?.span, undefined);
});
