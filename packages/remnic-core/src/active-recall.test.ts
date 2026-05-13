import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildActiveRecallPrompt,
  buildActiveRecallQueryBundle,
  createActiveRecallEngine,
  normalizeActiveRecallSummary,
  type ActiveRecallConfig,
  type ActiveRecallInput,
} from "./active-recall.js";

function baseConfig(overrides: Partial<ActiveRecallConfig> = {}): ActiveRecallConfig {
  return {
    enabled: true,
    agents: null,
    allowedChatTypes: ["direct", "group", "channel"],
    queryMode: "recent",
    promptStyle: "balanced",
    customInstruction: null,
    promptAppend: null,
    maxSummaryChars: 64,
    recentUserTurns: 2,
    recentAssistantTurns: 1,
    recentUserChars: 40,
    recentAssistantChars: 40,
    thinking: "low",
    timeoutMs: 5000,
    cacheTtlMs: 10000,
    persistTranscripts: false,
    transcriptDir: path.join(os.tmpdir(), "active-recall"),
    entityGraphDepth: 1,
    includeCausalTrajectories: false,
    includeDaySummary: false,
    attachRecallExplain: false,
    modelOverride: null,
    modelFallbackPolicy: "default-remote",
    ...overrides,
  };
}

function baseInput(overrides: Partial<ActiveRecallInput> = {}): ActiveRecallInput {
  return {
    sessionKey: "session-a",
    agentId: "main",
    chatType: "direct",
    recentTurns: [
      { role: "user", content: "We fixed the CI worker drain yesterday." },
      { role: "assistant", content: "I noted the flaky Redis worker." },
      { role: "user", content: "Please remember the root cause." },
    ],
    currentMessage: "What happened with CI?",
    ...overrides,
  };
}

test("buildActiveRecallQueryBundle respects message/recent/full modes", () => {
  const input = baseInput();
  assert.equal(
    buildActiveRecallQueryBundle(input, baseConfig({ queryMode: "message" })),
    "What happened with CI?",
  );
  assert.equal(
    buildActiveRecallQueryBundle(input, baseConfig({ queryMode: "recent" })),
    [
      "current: What happened with CI?",
      "user: We fixed the CI worker drain yesterday.",
      "assistant: I noted the flaky Redis worker.",
      "user: Please remember the root cause.",
    ].join("\n"),
  );
  assert.equal(
    buildActiveRecallQueryBundle(input, baseConfig({ queryMode: "full" })),
    [
      "user: We fixed the CI worker drain yesterday.",
      "assistant: I noted the flaky Redis worker.",
      "user: Please remember the root cause.",
      "current: What happened with CI?",
    ].join("\n"),
  );
});

test("buildActiveRecallQueryBundle preserves chronological order with per-role caps", () => {
  const input = baseInput({
    recentTurns: [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ],
    currentMessage: "What is next?",
  });

  const query = buildActiveRecallQueryBundle(
    input,
    baseConfig({
      queryMode: "recent",
      recentUserTurns: 2,
      recentAssistantTurns: 1,
      recentUserChars: 20,
      recentAssistantChars: 20,
    }),
  );

  assert.equal(query, [
    "current: What is next?",
    "user: u1",
    "user: u2",
    "assistant: a2",
  ].join("\n"));
});

test("buildActiveRecallPrompt varies by prompt style and optional sections", () => {
  const prompt = buildActiveRecallPrompt({
    config: baseConfig({ promptStyle: "precision-heavy", promptAppend: "Prefer hard evidence." }),
    queryBundle: "current: What happened with CI?",
    recallContext: "CI failed after the worker pool exhausted sockets.",
    graphContext: ["entity edge"],
    causalContext: ["causal link"],
    daySummary: "Debugged worker drain all morning.",
    recallExplain: "graph_mode",
  });
  assert.match(prompt, /Bias toward precision/);
  assert.match(prompt, /Entity graph/);
  assert.match(prompt, /Prefer hard evidence/);
});

test("normalizeActiveRecallSummary collapses NONE variants and truncates codepoint-safe", () => {
  assert.equal(normalizeActiveRecallSummary("NONE", 20), null);
  assert.equal(normalizeActiveRecallSummary("  no relevant memory  ", 20), null);
  const truncated = normalizeActiveRecallSummary("emoji 😀😀😀 trail", 8);
  assert.equal(truncated, "emoji 😀😀");
});

test("active recall engine caches results and short-circuits repeated calls", async () => {
  let generateCalls = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "CI worker drain after Redis reconnect storm.";
      },
      getLastRecallSnapshot() {
        return { memoryIds: ["mem-1"] };
      },
      async generateSummary() {
        generateCalls++;
        return { text: "Redis reconnect storm caused the worker drain." };
      },
      now: (() => {
        let tick = 10_000;
        return () => tick++;
      })(),
    },
    baseConfig({ cacheTtlMs: 5000 }),
  );

  const first = await engine.run(baseInput());
  const second = await engine.run(baseInput());
  assert.equal(generateCalls, 1);
  assert.equal(first.summary, "Redis reconnect storm caused the worker drain.");
  assert.equal(second.summary, first.summary);
});

test("active recall cache hits report cache-hit latency instead of reusing generation latency", async () => {
  let generateCalls = 0;
  const nowValues = [100, 145, 150, 300, 301];
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "CI worker drain after Redis reconnect storm.";
      },
      async generateSummary() {
        generateCalls++;
        return { text: "Redis reconnect storm caused the worker drain." };
      },
      now() {
        const value = nowValues.shift();
        if (value === undefined) {
          throw new Error("test clock exhausted");
        }
        return value;
      },
    },
    baseConfig({ cacheTtlMs: 5000 }),
  );

  const first = await engine.run(baseInput());
  const second = await engine.run(baseInput());

  assert.equal(generateCalls, 1);
  assert.equal(first.latencyMs, 45);
  assert.equal(second.cacheHit, true);
  assert.equal(second.latencyMs, 1);
});

test("active recall cache stores an isolated snapshot instead of a mutable caller reference", async () => {
  let generateCalls = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "CI worker drain after Redis reconnect storm.";
      },
      async generateSummary() {
        generateCalls++;
        return { text: "Redis reconnect storm caused the worker drain." };
      },
      now: (() => {
        let tick = 20_000;
        return () => tick++;
      })(),
    },
    baseConfig({ cacheTtlMs: 5000 }),
  );

  const first = await engine.run(baseInput());
  first.citations.push({ memoryId: "mutated", relevance: 1 });

  const second = await engine.run(baseInput());

  assert.equal(generateCalls, 1);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.citations, []);
});

test("active recall cache key includes output-shaping config so config changes do not reuse stale summaries", async () => {
  let generateCalls = 0;
  const deps = {
    async recall() {
      return "CI worker drain after Redis reconnect storm.";
    },
    async generateSummary() {
      generateCalls += 1;
      return {
        text:
          generateCalls === 1
            ? "This summary is intentionally long enough to show truncation drift."
            : "Short summary",
      };
    },
    now: (() => {
      let tick = 30_000;
      return () => tick++;
    })(),
  };

  const longEngine = createActiveRecallEngine(
    deps,
    baseConfig({ cacheTtlMs: 5000, maxSummaryChars: 12 }),
  );
  const shortEngine = createActiveRecallEngine(
    deps,
    baseConfig({ cacheTtlMs: 5000, maxSummaryChars: 80 }),
  );

  const first = await longEngine.run(baseInput());
  const second = await shortEngine.run(baseInput());

  assert.equal(generateCalls, 2);
  assert.equal(first.summary, "This summary");
  assert.equal(second.summary, "Short summary");
  assert.equal(second.cacheHit, false);
});

test("active recall engine evicts expired cache entries before reusing them", async () => {
  let nowValue = 10_000;
  let generateCalls = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "CI worker drain after Redis reconnect storm.";
      },
      async generateSummary() {
        generateCalls++;
        return { text: `summary ${generateCalls}` };
      },
      now: () => nowValue,
    },
    baseConfig({ cacheTtlMs: 50 }),
  );

  const first = await engine.run(baseInput({ currentMessage: "first query" }));
  assert.equal(first.summary, "summary 1");
  assert.equal(generateCalls, 1);

  nowValue += 100;
  const second = await engine.run(baseInput({ currentMessage: "first query" }));
  assert.equal(second.summary, "summary 2");
  assert.equal(generateCalls, 2);
});

test("active recall engine bounds cache growth by evicting oldest entries", async () => {
  let generateCalls = 0;
  const engine = createActiveRecallEngine(
    {
      async recall(query) {
        return `recall ${query}`;
      },
      async generateSummary({ prompt }) {
        generateCalls++;
        return { text: prompt.slice(0, 24) };
      },
      now: (() => {
        let tick = 1_000;
        return () => tick++;
      })(),
    },
    baseConfig({ cacheTtlMs: 10_000 }),
  );

  for (let index = 0; index < 270; index += 1) {
    await engine.run(baseInput({ currentMessage: `query ${index}` }));
  }
  assert.equal(generateCalls, 270);

  await engine.run(baseInput({ currentMessage: "query 0" }));
  assert.equal(generateCalls, 271);
});

test("active recall cache evicts stale entries and rebuilds", async () => {
  let now = 0;
  let generateCalls = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "recalled";
      },
      async generateSummary() {
        generateCalls += 1;
        return {
          text: generateCalls === 1 ? "first summary" : "second summary",
        };
      },
      now: () => {
        return now++;
      },
    },
    baseConfig({ cacheTtlMs: 1 }),
  );

  const first = await engine.run(baseInput());
  now = 3;
  const second = await engine.run(baseInput());

  assert.equal(generateCalls, 2);
  assert.equal(first.summary, "first summary");
  assert.equal(second.summary, "second summary");
});

test("active recall engine walks graph/day-summary/explain hooks when enabled", async () => {
  let graphDepth = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "Primary recall";
      },
      async walkEntityGraph(params) {
        graphDepth = params.depth;
        return ["graph hit"];
      },
      async loadCausalTrajectories() {
        return ["causal hit"];
      },
      async loadDaySummary() {
        return "day summary";
      },
      async explainLastRecall() {
        return "explain";
      },
      async generateSummary({ prompt }) {
        assert.match(prompt, /graph hit/);
        assert.match(prompt, /causal hit/);
        assert.match(prompt, /day summary/);
        assert.match(prompt, /Recall explain/);
        return { text: "Combined summary" };
      },
    },
    baseConfig({
      includeCausalTrajectories: true,
      includeDaySummary: true,
      attachRecallExplain: true,
      entityGraphDepth: 2,
    }),
  );

  const result = await engine.run(baseInput());
  assert.equal(graphDepth, 2);
  assert.equal(result.summary, "Combined summary");
});

test("active recall engine normalizes timeout to NONE and persists transcripts when enabled", async () => {
  const transcriptDir = await mkdtemp(path.join(os.tmpdir(), "active-recall-transcript-"));
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "Primary recall";
      },
      async generateSummary() {
        return { text: "timeout", modelUsed: "gpt-5.2-mini" };
      },
    },
    baseConfig({
      persistTranscripts: true,
      transcriptDir,
    }),
  );

  const result = await engine.run(baseInput());
  assert.equal(result.summary, null);
  assert.ok(result.transcriptPath, "expected transcript file path");
  const raw = await readFile(result.transcriptPath ?? "", "utf8");
  assert.match(raw, /"queryMode":"recent"/);
  assert.match(raw, /"summary":null/);
});

test("active recall transcript persistence sanitizes agent and session path segments", async () => {
  const transcriptDir = await mkdtemp(path.join(os.tmpdir(), "active-recall-transcript-"));
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "Primary recall";
      },
      async generateSummary() {
        return { text: "useful summary", modelUsed: "gpt-5.2-mini" };
      },
    },
    baseConfig({
      persistTranscripts: true,
      transcriptDir,
    }),
  );

  const result = await engine.run(
    baseInput({
      agentId: "../../etc",
      sessionKey: "session/../../escape",
    }),
  );

  assert.ok(result.transcriptPath, "expected transcript file path");
  const relativePath = path.relative(transcriptDir, result.transcriptPath ?? "");
  assert.equal(relativePath.startsWith(".."), false);
  assert.match(relativePath, /^agents\/%2E%2E%2F%2E%2E%2Fetc\//);
  assert.match(relativePath, /session%2F%2E%2E%2F%2E%2E%2Fescape\.jsonl$/);

  const raw = await readFile(result.transcriptPath ?? "", "utf8");
  assert.match(raw, /"agentId":"\.\.\/\.\.\/etc"/);
  assert.match(raw, /"sessionKey":"session\/\.\.\/\.\.\/escape"/);
});

test("active recall transcript persistence encodes bare dot path segments", async () => {
  const transcriptDir = await mkdtemp(path.join(os.tmpdir(), "active-recall-transcript-"));
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "Primary recall";
      },
      async generateSummary() {
        return { text: "useful summary", modelUsed: "gpt-5.2-mini" };
      },
    },
    baseConfig({
      persistTranscripts: true,
      transcriptDir,
    }),
  );

  const result = await engine.run(
    baseInput({
      agentId: "..",
      sessionKey: ".",
    }),
  );

  assert.ok(result.transcriptPath, "expected transcript file path");
  const relativePath = path.relative(transcriptDir, result.transcriptPath ?? "");
  assert.equal(relativePath.startsWith(".."), false);
  assert.match(relativePath, /^agents\/%2E%2E\//);
  assert.match(relativePath, /\/%2E\.jsonl$/);
});
