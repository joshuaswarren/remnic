import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../packages/remnic-core/src/config.js";
import { ExtractionEngine } from "../packages/remnic-core/src/extraction.js";
import { extractionResponseShape } from "../packages/remnic-core/src/extraction-prompt.js";
import { filterExtractionResultBySource } from "../packages/remnic-core/src/extraction-source-grounding.js";

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

test("on/shadow advertise span in the response shape; off does not", () => {
  assert.equal(extractionResponseShape("off"), extractionResponseShape());
  assert.doesNotMatch(extractionResponseShape("off"), /"span":/);
  assert.match(extractionResponseShape("on"), /"span":/);
  assert.match(extractionResponseShape("shadow"), /"span":/);
  assert.equal(extractionResponseShape("on"), extractionResponseShape("shadow"));
});

test("spanMode on: advertised prompt shape includes span; off does not", async () => {
  const seen: string[] = [];
  const onEngine = new ExtractionEngine(config("on"), undefined, {
    async chatCompletion(messages: Array<{ content: string }>) {
      seen.push(messages.map((message) => message.content).join("\n"));
      return spanResponse();
    },
  } as never);
  await onEngine.extract(turns());
  assert.match(seen.join("\n"), /"span":/);

  seen.length = 0;
  const offEngine = new ExtractionEngine(config("off"), undefined, {
    async chatCompletion(messages: Array<{ content: string }>) {
      seen.push(messages.map((message) => message.content).join("\n"));
      return spanResponse();
    },
  } as never);
  await offEngine.extract(turns());
  assert.doesNotMatch(seen.join("\n"), /"span": \{/);
});

test("embedded-quote grounding fallback is off-mode zero-diff", () => {
  const source = "moved to Seattle last spring";
  const result = {
    facts: [
      {
        category: "fact" as const,
        content: "Maya's relocation: moved to Seattle last spring",
        confidence: 0.9,
        tags: [],
        quote: "moved to Seattle last spring",
      },
      {
        category: "fact" as const,
        content: "Maya moved to Seattle last spring",
        confidence: 0.9,
        tags: [],
        quote: "moved to Seattle last spring",
      },
    ],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
  const off = filterExtractionResultBySource(result, source, source, undefined, undefined, "off");
  assert.equal(off.facts.length, 0, "off mode must not rescue quote-bearing facts");
  const on = filterExtractionResultBySource(result, source, source, undefined, undefined, "on");
  assert.deepEqual(
    on.facts.map((fact) => fact.content),
    ["Maya's relocation: moved to Seattle last spring"],
  );
});

test("spanMode on: local truncation cannot materialize an unseen suffix", async () => {
  const visible = "I moved to Seattle last spring";
  const unseen = " for a new role. UNSEEN_SUFFIX";
  const content = `${visible}${unseen}`;
  const conversation = `[user] ${content}`;
  const cut = conversation.indexOf(unseen);
  const leakStart = content.indexOf("UNSEEN_SUFFIX");
  const engine = new ExtractionEngine(
    config("on"),
    undefined,
    {
      async chatCompletion() {
        return {
          content: JSON.stringify({
            facts: [
              {
                category: "fact",
                content: visible,
                confidence: 0.9,
                tags: [],
                span: {
                  sourceMessageIndex: 0,
                  charStart: leakStart,
                  charEnd: content.length,
                  frame: "User's relocation",
                },
              },
            ],
            entities: [],
            questions: [],
            profileUpdates: [],
          }),
        };
      },
    } as never,
    undefined,
    {
      calculateContextSizes: () => ({
        maxInputChars: cut,
        maxOutputTokens: 64,
        description: "truncation-cut fixture",
      }),
    } as never,
  );
  const result = await engine.extract([
    { role: "user", content, timestamp: "2026-05-21T00:00:00.000Z" },
  ]);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.content, visible);
  assert.doesNotMatch(result.facts[0]?.content ?? "", /UNSEEN_SUFFIX/);
  assert.equal(result.facts[0]?.span, undefined);
});

test("spanMode on: local truncation materializes the visible prefix only", async () => {
  const visible = "I moved to Seattle last spring";
  const unseen = " for a new role. UNSEEN_SUFFIX";
  const content = `${visible}${unseen}`;
  const conversation = `[user] ${content}`;
  const cut = conversation.indexOf(unseen);
  const engine = new ExtractionEngine(
    config("on"),
    undefined,
    {
      async chatCompletion() {
        return {
          content: JSON.stringify({
            facts: [
              {
                category: "fact",
                content: "kept-frame",
                confidence: 0.9,
                tags: [],
                span: {
                  sourceMessageIndex: 0,
                  charStart: 0,
                  charEnd: visible.length,
                  frame: "User's relocation",
                },
              },
            ],
            entities: [],
            questions: [],
            profileUpdates: [],
          }),
        };
      },
    } as never,
    undefined,
    {
      calculateContextSizes: () => ({
        maxInputChars: cut,
        maxOutputTokens: 64,
        description: "truncation-cut fixture",
      }),
    } as never,
  );
  const result = await engine.extract([
    { role: "user", content, timestamp: "2026-05-21T00:00:00.000Z" },
  ]);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.content, `User's relocation: ${visible}`);
  assert.doesNotMatch(result.facts[0]?.content ?? "", /UNSEEN_SUFFIX/);
});
