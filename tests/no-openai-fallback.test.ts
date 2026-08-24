import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "@remnic/core/config";
import { ExtractionEngine } from "@remnic/core/extraction";

function buildEngine() {
  const config = {
    ...parseConfig({
      memoryDir: ".tmp/memory",
      workspaceDir: ".tmp/workspace",
      openaiApiKey: undefined,
      localLlmEnabled: false,
      localLlmFallback: true,
    }),
    openaiApiKey: undefined,
  };
  return new ExtractionEngine(config);
}

function buildLocalOnlyEngine() {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    localLlmEnabled: true,
    localLlmFallback: false,
  });
  return new ExtractionEngine(config);
}

function buildGatewayModeEngine() {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    modelSource: "gateway",
    gatewayAgentId: "engram-llm",
    localLlmEnabled: true,
    localLlmFallback: true,
  });
  return new ExtractionEngine(config);
}

test("verifyContradiction falls back to gateway AI when no OpenAI key is configured", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          isContradiction: true,
          confidence: 0.9,
          explanation: "these cannot both be true",
          winner: "new",
        }),
      };
    },
  };

  const result = await engine.verifyContradiction(
    { category: "preference", content: "User prefers dark mode" },
    {
      id: "memory-1",
      category: "preference",
      content: "User prefers light mode",
      created: "2026-03-01T00:00:00.000Z",
    },
  );

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, {
    isContradiction: true,
    confidence: 0.9,
    reasoning: "these cannot both be true",
    whichIsNewer: "second",
  });
});

test("suggestLinks falls back to gateway AI when no OpenAI key is configured", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          links: [
            {
              targetId: "memory-2",
              type: "supports",
              strength: 0.81,
              reason: "same project, stronger evidence",
            },
          ],
        }),
      };
    },
  };

  const result = await engine.suggestLinks(
    { category: "fact", content: "Shipment delay came from carrier outage" },
    [{ id: "memory-2", category: "fact", content: "Carrier outage affected delivery windows" }],
  );

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, {
    links: [
      {
        targetId: "memory-2",
        linkType: "supports",
        strength: 0.81,
        reason: "same project, stronger evidence",
      },
    ],
  });
});

test("suggestLinks preserves a valid empty fallback result when no links are suggested", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          links: [],
        }),
      };
    },
  };

  const result = await engine.suggestLinks(
    { category: "fact", content: "Standalone note with no clear relation" },
    [{ id: "memory-9", category: "fact", content: "Unrelated prior fact" }],
  );

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, { links: [] });
});

test("suggestLinks returns null when fallback output cannot be parsed", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: "definitely not json",
      };
    },
  };

  const result = await engine.suggestLinks(
    { category: "fact", content: "Standalone note with malformed fallback output" },
    [{ id: "memory-10", category: "fact", content: "Potentially related prior fact" }],
  );

  assert.equal(fallbackCalled, true);
  assert.equal(result, null);
});

test("summarizeMemories falls back to gateway AI when no OpenAI key is configured", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          summary: "Two shipping incidents point to carrier reliability issues.",
          keyFacts: ["Carrier outage delayed shipments", "Customers were notified about delays"],
          entities: ["carrier", "customers"],
        }),
      };
    },
  };

  const result = await engine.summarizeMemories([
    {
      id: "memory-1",
      category: "fact",
      content: "Carrier outage delayed shipments.",
      created: "2026-03-01T00:00:00.000Z",
    },
    {
      id: "memory-2",
      category: "fact",
      content: "Customers were notified about delays.",
      created: "2026-03-02T00:00:00.000Z",
    },
  ]);

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, {
    summaryText: "Two shipping incidents point to carrier reliability issues.",
    keyFacts: ["Carrier outage delayed shipments", "Customers were notified about delays"],
    keyEntities: ["carrier", "customers"],
  });
});

test("verifyContradiction honors localLlmEnabled before cloud routing", async () => {
  const engine = buildLocalOnlyEngine();
  let localCalled = false;
  let cloudCalled = false;
  (engine as any).localLlm = {
    chatCompletion: async () => {
      localCalled = true;
      return {
        content: JSON.stringify({
          isContradiction: false,
          confidence: 0.72,
          reasoning: "both memories can coexist",
          whichIsNewer: "unknown",
        }),
      };
    },
  };
  (engine as any).client = {
    chat: {
      completions: {
        create: async () => {
          cloudCalled = true;
          throw new Error("cloud path should not run when localLlmFallback=false");
        },
      },
    },
  };

  const result = await engine.verifyContradiction(
    { category: "fact", content: "User uses TypeScript" },
    {
      id: "memory-1",
      category: "fact",
      content: "User also uses JavaScript",
      created: "2026-03-01T00:00:00.000Z",
    },
  );

  assert.equal(localCalled, true);
  assert.equal(cloudCalled, false);
  assert.deepEqual(result, {
    isContradiction: false,
    confidence: 0.72,
    reasoning: "both memories can coexist",
    whichIsNewer: "unclear",
  });
});

test("suggestLinks honors localLlmEnabled before cloud routing", async () => {
  const engine = buildLocalOnlyEngine();
  let localCalled = false;
  let cloudCalled = false;
  (engine as any).localLlm = {
    chatCompletion: async () => {
      localCalled = true;
      return {
        content: JSON.stringify({
          links: [
            {
              targetId: "memory-2",
              linkType: "supports",
              strength: 0.67,
              reason: "same outage timeline",
            },
          ],
        }),
      };
    },
  };
  (engine as any).client = {
    chat: {
      completions: {
        create: async () => {
          cloudCalled = true;
          throw new Error("cloud path should not run when localLlmFallback=false");
        },
      },
    },
  };

  const result = await engine.suggestLinks(
    { category: "fact", content: "Carrier outage delayed shipments" },
    [{ id: "memory-2", category: "fact", content: "Carrier outage affected delivery windows" }],
  );

  assert.equal(localCalled, true);
  assert.equal(cloudCalled, false);
  assert.deepEqual(result, {
    links: [
      {
        targetId: "memory-2",
        linkType: "supports",
        strength: 0.67,
        reason: "same outage timeline",
      },
    ],
  });
});

test("summarizeMemories honors localLlmEnabled before cloud routing", async () => {
  const engine = buildLocalOnlyEngine();
  let localCalled = false;
  let cloudCalled = false;
  (engine as any).localLlm = {
    chatCompletion: async () => {
      localCalled = true;
      return {
        content: JSON.stringify({
          summaryText: "Shipping incidents share the same carrier outage root cause.",
          keyFacts: ["Carrier outage delayed shipments", "Customers were notified about delays"],
          keyEntities: ["carrier", "customers"],
        }),
      };
    },
  };
  (engine as any).client = {
    chat: {
      completions: {
        create: async () => {
          cloudCalled = true;
          throw new Error("cloud path should not run when localLlmFallback=false");
        },
      },
    },
  };

  const result = await engine.summarizeMemories([
    {
      id: "memory-1",
      category: "fact",
      content: "Carrier outage delayed shipments.",
      created: "2026-03-01T00:00:00.000Z",
    },
    {
      id: "memory-2",
      category: "fact",
      content: "Customers were notified about delays.",
      created: "2026-03-02T00:00:00.000Z",
    },
  ]);

  assert.equal(localCalled, true);
  assert.equal(cloudCalled, false);
  assert.deepEqual(result, {
    summaryText: "Shipping incidents share the same carrier outage root cause.",
    keyFacts: ["Carrier outage delayed shipments", "Customers were notified about delays"],
    keyEntities: ["carrier", "customers"],
  });
});

test("extract routes directly to the gateway chain when modelSource is gateway", async () => {
  const engine = buildGatewayModeEngine();
  let localCalled = false;
  let fallbackCalled = false;
  let fallbackOptions: Record<string, unknown> | undefined;

  (engine as any).localLlm = {
    chatCompletion: async () => {
      localCalled = true;
      return {
        content: "{\"facts\":[],\"profileUpdates\":[],\"entities\":[],\"questions\":[]}",
      };
    },
  };
  (engine as any).fallbackLlm = {
    parseWithSchemaDetailed: async (_messages: unknown, _schema: unknown, options: Record<string, unknown>) => {
      fallbackCalled = true;
      fallbackOptions = options;
      return {
        result: {
          facts: [
            {
              category: "fact",
              content: "Gateway mode should start on the configured chain.",
              confidence: 0.95,
              tags: ["gateway"],
            },
          ],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
        modelUsed: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      };
    },
  };

  const result = await engine.extract([
    {
      role: "user",
      content: "Remember that gateway mode should start on the configured chain.",
      timestamp: new Date().toISOString(),
    },
  ]);

  assert.equal(localCalled, false);
  assert.equal(fallbackCalled, true);
  assert.equal(fallbackOptions?.agentId, "engram-llm");
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.content, "Gateway mode should start on the configured chain.");
});
