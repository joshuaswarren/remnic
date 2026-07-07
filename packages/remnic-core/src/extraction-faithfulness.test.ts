/**
 * Tests for extraction-faithfulness.ts (issue #1576 PR 1).
 *
 * All tests stub the LLM adapter — no network, no GPU. The stub signatures
 * match the production LocalLlmClient / FallbackLlmClient interfaces so
 * these tests exercise the real call→parse→tag path.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  checkFaithfulnessBatch,
  parseFaithfulnessResponse,
  serializeFaithfulnessFields,
  parseFaithfulnessField,
  runFaithfulnessGateBatch,
  applyFaithfulnessVerdict,
  createFaithfulnessCounters,
  locateFactQuote,
  FAITHFULNESS_PROMPT_HASH,
  extractContextWindow,
} from "./extraction-faithfulness.js";
import type { FaithfulnessResult } from "./extraction-faithfulness.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { MemoryFrontmatter } from "./types.js";
import { callOpenAiCompatibleChat } from "./local-model-endpoint.js";

// ---------------------------------------------------------------------------
// Helpers — stub LLM clients
// ---------------------------------------------------------------------------

/**
 * Create a stub FallbackLlmClient that returns the given content.
 * The stub's call signature matches the real client.
 */
function stubFallbackLlm(
  content: string | null,
  captured?: Array<{ messages: unknown; options: unknown }>,
  modelUsed = "stub-model",
): FallbackLlmClient {
  return {
    isAvailable: () => true,
    chatCompletion: async (
      messages: Array<{ role: string; content: string }>,
      options: Record<string, unknown>,
    ) => {
      if (captured) captured.push({ messages, options });
      if (content === null) return null;
      return { content, modelUsed, usage: undefined };
    },
  } as unknown as FallbackLlmClient;
}

/**
 * Create a stub FallbackLlmClient that throws on call (simulates network error).
 */
function throwingFallbackLlm(error: Error): FallbackLlmClient {
  return {
    isAvailable: () => true,
    chatCompletion: async () => {
      throw error;
    },
  } as unknown as FallbackLlmClient;
}

/**
 * Create a stub FallbackLlmClient that never resolves within the test timeout
 * (simulates a hung request). Respects the gate's AbortSignal: when the
 * signal fires, the stub throws — mirroring a real fetch that is aborted by
 * the gate timer. (The previous stub ignored the signal and returned "[]"
 * after the delay, which is unrealistic and masked the timeout-race fix.)
 */
function slowFallbackLlm(delayMs: number): FallbackLlmClient {
  return {
    isAvailable: () => true,
    chatCompletion: async (
      _messages: Array<{ role: string; content: string }>,
      options: Record<string, unknown> = {},
    ) => {
      const signal = options.signal as AbortSignal | undefined;
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, delayMs);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          throw new Error("aborted");
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }
      await promise;
      return { content: "[]", modelUsed: "slow", usage: undefined };
    },
  } as unknown as FallbackLlmClient;
}

/**
 * Create a stub FallbackLlmClient that IGNORES the abort signal and returns
 * valid content after a delay longer than the gate's timeout. This simulates
 * the race the cursor review flagged (#1576): the abort timer fires
 * (`timedOut = true`) but the response lands a moment later with genuine
 * verdicts. The race fix must honor that content instead of discarding it as
 * a timeout error.
 */
function racingFallbackLlm(delayMs: number, content: string): FallbackLlmClient {
  return {
    isAvailable: () => true,
    chatCompletion: async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delayMs);
      await promise;
      return { content, modelUsed: "racing", usage: undefined };
    },
  } as unknown as FallbackLlmClient;
}

function baseConfig(): ReturnType<typeof parseConfig> {
  return parseConfig({
    extractionFaithfulnessTimeoutMs: 200,
    extractionFaithfulnessContextChars: 400,
  });
}

// ---------------------------------------------------------------------------
// parseFaithfulnessResponse — pure, no LLM
// ---------------------------------------------------------------------------

test("parseFaithfulnessResponse: valid array with all three verdicts", () => {
  const raw = JSON.stringify([
    { index: 0, verdict: "entailed", rationale: "direct paraphrase" },
    { index: 1, verdict: "contradicted", rationale: "opposite meaning" },
    { index: 2, verdict: "unsupported", rationale: "not in quote" },
  ]);
  const map = parseFaithfulnessResponse(raw, 3);
  assert.ok(map);
  assert.equal(map.size, 3);
  assert.equal(map.get(0)?.verdict, "entailed");
  assert.equal(map.get(1)?.verdict, "contradicted");
  assert.equal(map.get(2)?.verdict, "unsupported");
});

test("parseFaithfulnessResponse: partial array (missing index → null map if none valid)", () => {
  const raw = JSON.stringify([
    { index: 0, verdict: "entailed" },
    { index: 2, verdict: "unsupported" },
  ]);
  const map = parseFaithfulnessResponse(raw, 3);
  assert.ok(map);
  assert.equal(map.size, 2);
  assert.equal(map.get(0)?.verdict, "entailed");
  assert.equal(map.get(2)?.verdict, "unsupported");
  assert.ok(!map.has(1));
});

test("parseFaithfulnessResponse: empty string → null", () => {
  assert.equal(parseFaithfulnessResponse("", 1), null);
  assert.equal(parseFaithfulnessResponse("   ", 1), null);
});

test("parseFaithfulnessResponse: malformed JSON → null", () => {
  assert.equal(parseFaithfulnessResponse("maybe?", 1), null);
  assert.equal(parseFaithfulnessResponse("{broken", 1), null);
  assert.equal(parseFaithfulnessResponse("I think it's entailed", 1), null);
});

test("parseFaithfulnessResponse: valid JSON but wrong shape → null", () => {
  assert.equal(parseFaithfulnessResponse('{"key": "value"}', 1), null);
  assert.equal(parseFaithfulnessResponse("[]", 1), null);
  assert.equal(parseFaithfulnessResponse('["not", "objects"]', 1), null);
});

test("parseFaithfulnessResponse: entries with invalid verdict strings are dropped", () => {
  const raw = JSON.stringify([
    { index: 0, verdict: "entailed" },
    { index: 1, verdict: "maybe" },
    { index: 2, verdict: "unsupported" },
  ]);
  const map = parseFaithfulnessResponse(raw, 3);
  assert.ok(map);
  assert.equal(map.size, 2);
  assert.ok(map.has(0));
  assert.ok(!map.has(1));
  assert.ok(map.has(2));
});

test("parseFaithfulnessResponse: index out of range is dropped", () => {
  const raw = JSON.stringify([
    { index: 0, verdict: "entailed" },
    { index: 99, verdict: "unsupported" },
  ]);
  const map = parseFaithfulnessResponse(raw, 2);
  assert.ok(map);
  assert.equal(map.size, 1);
  assert.ok(map.has(0));
  assert.ok(!map.has(99));
});

test("parseFaithfulnessResponse: rationale is capped at 500 chars", () => {
  const longRationale = "A".repeat(600);
  const raw = JSON.stringify([
    { index: 0, verdict: "entailed", rationale: longRationale },
  ]);
  const map = parseFaithfulnessResponse(raw, 1);
  assert.ok(map);
  assert.equal(map.get(0)?.rationale?.length, 500);
});

test("parseFaithfulnessResponse: JSON embedded in fenced code block", () => {
  const raw = "```json\n" +
    '  [{"index": 0, "verdict": "entailed", "rationale": "ok"}]\n' +
  "  ```";
  const map = parseFaithfulnessResponse(raw, 1);
  assert.ok(map);
  assert.equal(map.get(0)?.verdict, "entailed");
});

// ---------------------------------------------------------------------------
// checkFaithfulnessBatch — entailed / contradicted / unsupported fixtures
// ---------------------------------------------------------------------------

test("checkFaithfulnessBatch: entailed — paraphrase of duration", async () => {
  const inputs = [{
    factText: "The user has used Vim for approximately a decade.",
    quote: "I've been using Vim for about ten years now.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "entailed", rationale: "Paraphrase of the same duration." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "entailed");
    assert.ok(result.results[0].rationale);
  }
});

test("checkFaithfulnessBatch: contradicted — negation (stopped vs active)", async () => {
  const inputs = [{
    factText: "The user drinks coffee regularly.",
    quote: "I stopped drinking coffee last month.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "contradicted", rationale: "Quote negates the fact." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "contradicted");
  }
});

test("checkFaithfulnessBatch: unsupported — entity swap (Vim → Emacs)", async () => {
  const inputs = [{
    factText: "The user prefers Emacs.",
    quote: "I've been using Vim for about ten years now.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "unsupported", rationale: "Quote mentions Vim, not Emacs." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "unsupported");
  }
});

test("checkFaithfulnessBatch: contradicted — date shift", async () => {
  const inputs = [{
    factText: "The project started in January 2024.",
    quote: "We kicked off the project in March 2024.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "contradicted", rationale: "January vs March." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "contradicted");
  }
});

test("checkFaithfulnessBatch: contradicted — quantity change", async () => {
  const inputs = [{
    factText: "The team has 50 engineers.",
    quote: "We have a team of 12 engineers.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "contradicted", rationale: "50 vs 12." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "contradicted");
  }
});

test("checkFaithfulnessBatch: unsupported — unrelated quote", async () => {
  const inputs = [{
    factText: "The user lives in Tokyo.",
    quote: "I love playing chess on weekends.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "unsupported", rationale: "No location info in quote." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "unsupported");
  }
});

test("checkFaithfulnessBatch: entailed — pronoun resolution", async () => {
  const inputs = [{
    factText: "Alice is a senior engineer at Acme Corp.",
    quote: "Alice is a senior engineer at Acme Corp.",
    context: "We were discussing the team structure.",
  }];
  const llm = JSON.stringify([
    { index: 0, verdict: "entailed", rationale: "Exact match." },
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "entailed");
  }
});

test("checkFaithfulnessBatch: batch of 3 — all processed in one LLM call", async () => {
  const inputs = [
    { factText: "Fact A", quote: "Quote A" },
    { factText: "Fact B", quote: "Quote B" },
    { factText: "Fact C", quote: "Quote C" },
  ];
  const llm = JSON.stringify([
    { index: 0, verdict: "entailed" },
    { index: 1, verdict: "contradicted" },
    { index: 2, verdict: "unsupported" },
  ]);
  const captured: Array<{ messages: unknown; options: unknown }> = [];
  const result = await checkFaithfulnessBatch(
    inputs, baseConfig(), null, stubFallbackLlm(llm, captured),
  );
  assert.equal(captured.length, 1, "should make exactly one LLM call for the batch");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0]?.ok && result.results[0].verdict, "entailed");
  assert.equal(result.results[1]?.ok && result.results[1].verdict, "contradicted");
  assert.equal(result.results[2]?.ok && result.results[2].verdict, "unsupported");
});

// ---------------------------------------------------------------------------
// checkFaithfulnessBatch — error paths
// ---------------------------------------------------------------------------

test("checkFaithfulnessBatch: empty quote → no_span", async () => {
  const inputs = [{ factText: "Some fact", quote: "" }];
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm("[]"));
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "no_span");
  }
});

test("checkFaithfulnessBatch: missing quote property → no_span", async () => {
  const inputs = [{ factText: "Some fact", quote: "   " }];
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm("[]"));
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "no_span");
  }
});

test("checkFaithfulnessBatch: empty factText → no_span", async () => {
  const inputs = [{ factText: "", quote: "Some quote" }];
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm("[]"));
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "no_span");
  }
});

test("checkFaithfulnessBatch: backend returns null → backend_unavailable", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(null));
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "backend_unavailable");
  }
});

test("checkFaithfulnessBatch: backend throws → backend_unavailable", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const result = await checkFaithfulnessBatch(
    inputs, baseConfig(), null, throwingFallbackLlm(new Error("ECONNREFUSED")),
  );
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "backend_unavailable");
  }
});

test("checkFaithfulnessBatch: malformed LLM output → malformed_output", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const result = await checkFaithfulnessBatch(
    inputs, baseConfig(), null, stubFallbackLlm("maybe? I think so."),
  );
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "malformed_output");
  }
});

test("checkFaithfulnessBatch: timeout → tagged timeout, not a crash", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  // Use a very short timeout and a slow LLM to force the abort path.
  const config = parseConfig({ extractionFaithfulnessTimeoutMs: 50 });
  const result = await checkFaithfulnessBatch(
    inputs, config, null, slowFallbackLlm(5000),
  );
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "timeout");
  }
});

test("checkFaithfulnessBatch: content landing within the budget is used; content past the budget fails open as timeout", async () => {
  // The batch races the LLM call against extractionFaithfulnessTimeoutMs so a
  // wedged/slow backend cannot hold the extraction flush past the budget
  // (codex review PRRT_kwDORJXyws6ObgMJ). Content that lands WITHIN the budget
  // is used; content that lands AFTER the budget fails open as timeout.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({ extractionFaithfulnessTimeoutMs: 50 });
  const llm = JSON.stringify([{ index: 0, verdict: "entailed" }]);

  // Within budget (30ms < 50ms): the real verdict is used.
  const within = await checkFaithfulnessBatch(inputs, config, null, racingFallbackLlm(30, llm));
  assert.equal(within.results[0]?.ok, true, "content within the budget must be used");
  if (within.results[0]?.ok) {
    assert.equal(within.results[0].verdict, "entailed");
  }

  // Past budget (80ms > 50ms): fail open as timeout, do not block the flush.
  const past = await checkFaithfulnessBatch(inputs, config, null, racingFallbackLlm(80, llm));
  assert.equal(past.results[0]?.ok, false, "content past the budget fails open as timeout");
  if (!past.results[0]?.ok) {
    assert.equal(past.results[0].error.code, "timeout");
  }
});

test("checkFaithfulnessBatch: LLM returns partial results — missing index → malformed_output", async () => {
  const inputs = [
    { factText: "Fact A", quote: "Quote A" },
    { factText: "Fact B", quote: "Quote B" },
  ];
  // LLM only returns index 0, missing index 1
  const llm = JSON.stringify([{ index: 0, verdict: "entailed" }]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.ok && result.results[0].verdict, "entailed");
  assert.equal(result.results[1]?.ok, false);
  if (!result.results[1]?.ok) {
    assert.equal(result.results[1].error.code, "malformed_output");
  }
});

test("checkFaithfulnessBatch: no inputs with quotes → no LLM call, all no_span", async () => {
  const inputs = [
    { factText: "Fact A", quote: "" },
    { factText: "Fact B", quote: "" },
  ];
  const captured: Array<{ messages: unknown; options: unknown }> = [];
  const result = await checkFaithfulnessBatch(
    inputs, baseConfig(), null, stubFallbackLlm("[]", captured),
  );
  assert.equal(captured.length, 0, "no LLM call when all inputs lack quotes");
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.results[0]?.ok, false);
  assert.equal(result.results[1]?.ok, false);
});

test("checkFaithfulnessBatch: mixed — some with quotes, some without", async () => {
  const inputs = [
    { factText: "Fact A", quote: "Quote A" },
    { factText: "Fact B", quote: "" },
    { factText: "Fact C", quote: "Quote C" },
  ];
  const llm = JSON.stringify([
    { index: 0, verdict: "entailed" },
    { index: 1, verdict: "unsupported" }, // maps to checkable index 1 (Fact C)
  ]);
  const result = await checkFaithfulnessBatch(inputs, baseConfig(), null, stubFallbackLlm(llm));
  assert.equal(result.results.length, 3);
  // Index 0: entailed
  assert.equal(result.results[0]?.ok && result.results[0].verdict, "entailed");
  // Index 1: no_span (empty quote)
  assert.equal(result.results[1]?.ok, false);
  if (!result.results[1]?.ok) {
    assert.equal(result.results[1].error.code, "no_span");
  }
  // Index 2: unsupported (second checkable item)
  assert.equal(result.results[2]?.ok && result.results[2].verdict, "unsupported");
});

test("checkFaithfulnessBatch: elapsedMs is non-negative", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const result = await checkFaithfulnessBatch(
    inputs, baseConfig(), null, stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }])),
  );
  assert.ok(result.elapsedMs >= 0);
});

// ---------------------------------------------------------------------------
// Prompt hash — stable for caching
// ---------------------------------------------------------------------------

test("FAITHFULNESS_PROMPT_HASH is a 64-char hex string", () => {
  assert.equal(FAITHFULNESS_PROMPT_HASH.length, 64);
  assert.match(FAITHFULNESS_PROMPT_HASH, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Frontmatter serialization round-trip
// ---------------------------------------------------------------------------

test("serializeFaithfulnessFields: absent field → no line emitted (byte-identical)", () => {
  const lines: string[] = [];
  const fm: MemoryFrontmatter = {
    id: "test",
    category: "preference",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
  };
  serializeFaithfulnessFields(fm, lines);
  assert.equal(lines.length, 0);
});

test("serializeFaithfulnessFields: present field → single JSON line", () => {
  const lines: string[] = [];
  const fm: MemoryFrontmatter = {
    id: "test",
    category: "preference",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    faithfulness: { verdict: "entailed", model: "glm-4.7-flash", rationale: "ok" },
  };
  serializeFaithfulnessFields(fm, lines);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^faithfulness: /);
  const parsed = JSON.parse(lines[0]!.replace(/^faithfulness: /, ""));
  assert.equal(parsed.verdict, "entailed");
  assert.equal(parsed.model, "glm-4.7-flash");
});

test("parseFaithfulnessField: round-trip", () => {
  const fm: MemoryFrontmatter = {
    id: "test",
    category: "preference",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    faithfulness: { verdict: "contradicted", model: "m", rationale: "r", at: "2026-01-01T00:00:00Z" },
  };
  const lines: string[] = [];
  serializeFaithfulnessFields(fm, lines);
  const raw = lines[0]!.replace(/^faithfulness: /, "");
  const parsed = parseFaithfulnessField(raw);
  assert.deepEqual(parsed, { verdict: "contradicted", model: "m", rationale: "r", at: "2026-01-01T00:00:00Z" });
});

test("parseFaithfulnessField: undefined / blank / corrupt → undefined", () => {
  assert.equal(parseFaithfulnessField(undefined), undefined);
  assert.equal(parseFaithfulnessField(""), undefined);
  assert.equal(parseFaithfulnessField("   "), undefined);
  assert.equal(parseFaithfulnessField("{broken json"), undefined);
  assert.equal(parseFaithfulnessField('"a string"'), undefined);
  assert.equal(parseFaithfulnessField("[]"), undefined);
  assert.equal(parseFaithfulnessField('{}'), undefined);
  assert.equal(parseFaithfulnessField('{"verdict": "maybe"}'), undefined);
});

test("parseFaithfulnessField: accepts all valid verdict values", () => {
  for (const v of ["entailed", "contradicted", "unsupported", "unchecked", "skipped_no_span"]) {
    const parsed = parseFaithfulnessField(JSON.stringify({ verdict: v }));
    assert.equal(parsed?.verdict, v);
  }
});

test("serializeFaithfulnessFields: empty verdict omitted → no line", () => {
  const lines: string[] = [];
  const fm = {
    faithfulness: { verdict: "" as "entailed" },
  } as MemoryFrontmatter;
  serializeFaithfulnessFields(fm, lines);
  assert.equal(lines.length, 0);
});

// ---------------------------------------------------------------------------
// runFaithfulnessGateBatch / applyFaithfulnessVerdict — orchestration helpers
// (issue #1576). These are the orchestrator-facing API; the substantive
// algorithm is covered by the checkFaithfulnessBatch tests above.
// ---------------------------------------------------------------------------

test("createFaithfulnessCounters: returns zeroed counters", () => {
  assert.deepEqual(createFaithfulnessCounters(), {
    entailed: 0,
    contradicted: 0,
    unsupported: 0,
    unchecked: 0,
    skippedNoSpan: 0,
  });
});

test("runFaithfulnessGateBatch: facts with no span and no sourceText match skipped", async () => {
  const facts = [
    { content: "Fact with no sources" },
    { content: "Another", sources: [] },
  ];
  const captured: Array<{ messages: unknown; options: unknown }> = [];
  const counters = createFaithfulnessCounters();
  const result = await runFaithfulnessGateBatch(
    facts,
    "shadow",
    baseConfig(),
    null,
    stubFallbackLlm("[]", captured),
    counters,
    "", // no source text → no fallback quote
  );
  assert.equal(captured.length, 0, "no LLM call when no facts have a located quote");
  assert.ok(result instanceof Map, "returns an empty map");
  assert.equal(result.size, 0);
  assert.equal(counters.entailed, 0);
});

test("runFaithfulnessGateBatch: locateFactQuote fallback feeds the gate when no #1575 sources", async () => {
  // Fact has no `sources` but the source text contains a matching sentence →
  // locateFactQuote finds it so the gate actually runs (P1 fix).
  const facts = [{ content: "The user prefers Vim." }];
  const llm = JSON.stringify([{ index: 0, verdict: "entailed" }]);
  const counters = createFaithfulnessCounters();
  const result = await runFaithfulnessGateBatch(
    facts,
    "shadow",
    baseConfig(),
    null,
    stubFallbackLlm(llm),
    counters,
    "I have used Vim for ten years and I really prefer Vim over Emacs.",
  );
  assert.ok(result instanceof Map);
  assert.equal(result.size, 1);
  const r0 = result.get(0);
  assert.equal(r0?.ok, true);
  if (r0?.ok) assert.equal(r0.verdict, "entailed");
  // counters still 0 here — bumped at apply time.
  assert.equal(counters.entailed, 0);
});

test("runFaithfulnessGateBatch: builds index→result map + updates counters", async () => {
  // Fact 0 has a source, fact 1 does NOT, fact 2 has a source. The batch
  // skips fact 1, so the LLM sees 2 inputs and results map back to the
  // ORIGINAL fact indices (0 and 2), not batch positions.
  const facts = [
    { content: "Fact 0", sources: [{ quote: "Quote 0" }] },
    { content: "Fact 1 (no sources)" },
    { content: "Fact 2", sources: [{ quote: "Quote 2" }] },
  ];
  const llm = JSON.stringify([
    { index: 0, verdict: "entailed" },
    { index: 1, verdict: "contradicted" },
  ]);
  const counters = createFaithfulnessCounters();
  const result = await runFaithfulnessGateBatch(
    facts,
    "shadow",
    baseConfig(),
    null,
    stubFallbackLlm(llm),
    counters,
  );
  assert.ok(result instanceof Map, "batch returns a map on success");
  assert.equal(result.size, 2);
  assert.equal(result.has(1), false, "fact without a source is absent from the map");
  const r0 = result.get(0);
  assert.equal(r0?.ok, true);
  if (r0?.ok) assert.equal(r0.verdict, "entailed");
  const r2 = result.get(2);
  assert.equal(r2?.ok, true);
  if (r2?.ok) assert.equal(r2.verdict, "contradicted");
  // Counters are bumped at apply time (applyFaithfulnessVerdict), not here.
  assert.equal(counters.entailed, 0);
  assert.equal(counters.contradicted, 0);
});

test("runFaithfulnessGateBatch: backend throw → unchecked result, fail-open (checklist §4)", async () => {
  // checkFaithfulnessBatch is total: it catches an LLM throw and surfaces it
  // as an ok:false result rather than propagating. So the gate records the
  // failure as "unchecked" and proceeds — a backend outage never blocks writes.
  const facts = [{ content: "Fact", sources: [{ quote: "Quote" }] }];
  const counters = createFaithfulnessCounters();
  const result = await runFaithfulnessGateBatch(
    facts,
    "enforce",
    baseConfig(),
    null,
    throwingFallbackLlm(new Error("ECONNREFUSED")),
    counters,
  );
  assert.ok(result instanceof Map);
  const r0 = result.get(0);
  assert.equal(r0?.ok, false);
  if (!r0?.ok) assert.equal(r0.error.code, "backend_unavailable");
  // Counters bump at apply time (cursor review), so still 0 after the batch.
  assert.equal(counters.unchecked, 0);
  // Applying the verdict bumps unchecked.
  const applied = applyFaithfulnessVerdict(result, 0, "enforce", "Fact", counters);
  assert.equal(applied.faithfulness?.verdict, "unchecked");
  assert.equal(counters.unchecked, 1);
});

test("applyFaithfulnessVerdict: gate off (null map) → no frontmatter", () => {
  const counters = createFaithfulnessCounters();
  const r = applyFaithfulnessVerdict(null, 0, "off", "fact", counters);
  assert.equal(r.faithfulness, undefined);
  assert.equal(r.enforceStatus, undefined);
  assert.equal(counters.skippedNoSpan, 0);
});

test("applyFaithfulnessVerdict: fact absent from map → skipped_no_span, never gated", () => {
  const counters = createFaithfulnessCounters();
  const map = new Map();
  const r = applyFaithfulnessVerdict(map, 5, "enforce", "legacy fact", counters);
  assert.equal(r.faithfulness?.verdict, "skipped_no_span");
  assert.equal(r.enforceStatus, undefined);
  assert.equal(counters.skippedNoSpan, 1);
});

test("applyFaithfulnessVerdict: enforce + unsupported → pending_review (issue #1576 done-when)", () => {
  const counters = createFaithfulnessCounters();
  const map: Map<number, FaithfulnessResult> = new Map([[0, { ok: true, verdict: "unsupported" as const, model: "stub-model" }]]);
  const r = applyFaithfulnessVerdict(map, 0, "enforce", "hallucinated fact", counters);
  assert.equal(r.faithfulness?.verdict, "unsupported");
  assert.equal(r.faithfulness?.model, "stub-model");
  assert.equal(r.enforceStatus, "pending_review");
});

test("applyFaithfulnessVerdict: enforce + contradicted → pending_review", () => {
  const counters = createFaithfulnessCounters();
  const map: Map<number, FaithfulnessResult> = new Map([[0, { ok: true, verdict: "contradicted" as const, model: "stub" }]]);
  const r = applyFaithfulnessVerdict(map, 0, "enforce", "wrong fact", counters);
  assert.equal(r.enforceStatus, "pending_review");
});

test("applyFaithfulnessVerdict: shadow + unsupported → recorded but NOT gated", () => {
  const counters = createFaithfulnessCounters();
  const map: Map<number, FaithfulnessResult> = new Map([[0, { ok: true, verdict: "unsupported" as const, model: "stub" }]]);
  const r = applyFaithfulnessVerdict(map, 0, "shadow", "fact", counters);
  assert.equal(r.faithfulness?.verdict, "unsupported");
  assert.equal(r.enforceStatus, undefined);
});

test("applyFaithfulnessVerdict: entailed → proceeds, no enforce", () => {
  const counters = createFaithfulnessCounters();
  const map: Map<number, FaithfulnessResult> = new Map([[0, { ok: true, verdict: "entailed" as const, model: "stub" }]]);
  const r = applyFaithfulnessVerdict(map, 0, "enforce", "fact", counters);
  assert.equal(r.faithfulness?.verdict, "entailed");
  assert.equal(r.enforceStatus, undefined);
});

test("applyFaithfulnessVerdict: per-fact backend failure (ok:false) → unchecked, proceeds", () => {
  const counters = createFaithfulnessCounters();
  const map: Map<number, FaithfulnessResult> = new Map([[0, { ok: false, error: { code: "timeout" as const } }]]);
  const r = applyFaithfulnessVerdict(map, 0, "enforce", "fact", counters);
  assert.equal(r.faithfulness?.verdict, "unchecked");
  assert.equal(r.enforceStatus, undefined);
});

test("locateFactQuote: finds the best-overlap sentence (returns LocatedQuote, issue #1633)", () => {
  const src = "I drove to Berlin yesterday. My favorite editor is Vim.";
  const located = locateFactQuote("The user likes Vim.", src);
  assert.ok(located, "expected a located quote");
  assert.equal(located!.quote, "My favorite editor is Vim.");
  // offset must point at the matched candidate's actual position in sourceText.
  assert.equal(located!.offset, src.indexOf("My favorite editor is Vim."));
});

test("locateFactQuote: returns undefined below the overlap threshold", () => {
  const src = "The weather is sunny. Stocks rose 2 percent.";
  assert.equal(locateFactQuote("The user lives in Tokyo.", src), undefined);
});

test("locateFactQuote: empty inputs → undefined", () => {
  assert.equal(locateFactQuote("", "text"), undefined);
  assert.equal(locateFactQuote("fact", ""), undefined);
});

test("locateFactQuote: centers the bounded window on matched terms for >maxQuoteChars candidates (issue #1633, codex :747)", () => {
  // The supporting terms ("PostgreSQL", "migration") fall well past the
  // ~maxQuoteChars prefix. Returning the prefix would drop the evidence and
  // route an actually-entailed fact to pending_review in enforce mode.
  const filler = "Lorem ipsum dolor sit amet ".repeat(28); // ~728-char preamble
  const sourceText = filler + "The team completed the PostgreSQL migration last quarter.";
  const located = locateFactQuote(
    "The team finished the PostgreSQL migration.",
    sourceText,
    200,
  );
  assert.ok(located, "expected a located quote");
  assert.ok(
    located!.quote.length <= 200,
    `bounded quote must respect maxQuoteChars (got ${located!.quote.length})`,
  );
  // The matched evidence must survive truncation — the whole point of centering.
  assert.ok(located!.quote.includes("PostgreSQL"), "bounded quote keeps 'PostgreSQL'");
  assert.ok(located!.quote.includes("migration"), "bounded quote keeps 'migration'");
  // offset must locate the returned (possibly bounded) quote within sourceText.
  assert.equal(
    sourceText.slice(located!.offset, located!.offset + located!.quote.length),
    located!.quote,
    "offset must point at the returned quote within sourceText",
  );
});

test("locateFactQuote: tracks the matched occurrence offset for repeated anaphoric lines (issue #1633, codex :710, :710-thread-S)", () => {
  // Two entities with the EXACT SAME anaphoric sentence afterward — the
  // fact is about Zeta, which appears SECOND. Both "It launched in March."
  // candidates score identically on own-overlap, so the locator must use the
  // preceding-neighbor tiebreak to pick the occurrence whose neighbor ("Zeta")
  // names the fact's entity. The offset must then point at the Zeta clause.
  const sourceText =
    "We started the Acme project in January. It launched in March. " +
    "Then we began the Zeta initiative in February. It launched in March.";
  const located = locateFactQuote("The Zeta initiative launched in March.", sourceText);
  assert.ok(located, "expected a located quote");
  // The matched quote is the (identical) anaphoric line; offset must point at
  // the SECOND occurrence (the one after the Zeta clause), not the first.
  const firstOccurrence = sourceText.indexOf("It launched in March.");
  const secondOccurrence = sourceText.indexOf("It launched in March.", firstOccurrence + 1);
  assert.ok(secondOccurrence > firstOccurrence, "test fixture must contain two occurrences");
  assert.equal(
    located!.offset,
    secondOccurrence,
    "offset must point at the second (Zeta) occurrence, not the first (Acme)",
  );
  assert.equal(
    sourceText.slice(located!.offset, located!.offset + located!.quote.length),
    located!.quote,
    "offset must point at the start of the matched quote",
  );
});

test("locateFactQuote: bounded window keeps the densest evidence cluster when matches span wider than maxQuoteChars (codex :747-thread-O)", () => {
  // Fact tokens appear at BOTH ENDS of a long candidate with filler between.
  // A naive midpoint-centered window would land in the filler and contain no
  // evidence. The densest-cluster window must capture actual matched terms.
  const head = "PostgreSQL migration completed. "; // matches at the very start
  const filler = "and ".repeat(220); // ~880 chars of filler (no fact tokens)
  const tail = " for the user."; // matches at the very end
  const sourceText = head + filler + tail; // one long sentence, no period inside
  // Fact spans tokens from both ends: postgresql, migration (head) + user (tail).
  const located = locateFactQuote(
    "The user completed the PostgreSQL migration.",
    sourceText,
    120,
  );
  assert.ok(located, "expected a located quote");
  assert.ok(
    located!.quote.length <= 120,
    `bounded quote must respect maxQuoteChars (got ${located!.quote.length})`,
  );
  // The densest cluster is the head (2 matches: postgresql, migration); the
  // window must contain at least one of them. (user appears alone at the tail,
  // so a tail-anchored window would be sparser and is not chosen.)
  assert.ok(
    located!.quote.includes("PostgreSQL") || located!.quote.includes("migration"),
    "bounded window must include matched evidence, not pure filler",
  );
});

test("locateFactQuote: bounded window stays linear with many repeated matched tokens (codex PRRT_kwDORJXyws6Ocih3)", () => {
  // A long unpunctuated candidate with thousands of repeats of a fact token
  // (pasted logs / minified text). The densest-cluster selection must stay
  // O(n) via the two-pointer sliding window; the O(n^2) nested loop would
  // stall extraction on ~5k repeats. This test asserts both correctness (the
  // bounded window contains the densest cluster) and that the call returns
  // promptly — under O(n^2) this fixture (~5k repeats) would take seconds.
  const repeats = 5000;
  const token = "PostgreSQL "; // one fact token per repeat
  const filler = "x ".repeat(50); // leading filler so the cluster is mid-string
  const sourceText = filler + token.repeat(repeats) + "migration done";
  const start = Date.now();
  const located = locateFactQuote("PostgreSQL migration done.", sourceText, 200);
  const elapsed = Date.now() - start;
  assert.ok(located, "expected a located quote");
  assert.ok(
    located!.quote.length <= 200,
    `bounded quote must respect maxQuoteChars (got ${located!.quote.length})`,
  );
  // The densest cluster is the run of PostgreSQL repeats; the window must be
  // anchored inside it (not in the leading filler) and contain evidence.
  assert.ok(
    located!.quote.includes("PostgreSQL"),
    "bounded window must anchor inside the densest cluster",
  );
  assert.ok(
    elapsed < 1000,
    `bounded window must stay linear (took ${elapsed}ms for ${repeats} repeats)`,
  );
});

test("applyFaithfulnessVerdict: bumps verdict counters at apply time (cursor review)", () => {
  const counters = createFaithfulnessCounters();
  const map: Map<number, FaithfulnessResult> = new Map([
    [0, { ok: true, verdict: "entailed", model: "m" }],
    [1, { ok: true, verdict: "contradicted", model: "m" }],
    [2, { ok: true, verdict: "unsupported", model: "m" }],
    [3, { ok: false, error: { code: "timeout" } }],
  ]);
  applyFaithfulnessVerdict(map, 0, "enforce", "f0", counters);
  applyFaithfulnessVerdict(map, 1, "enforce", "f1", counters);
  applyFaithfulnessVerdict(map, 2, "enforce", "f2", counters);
  applyFaithfulnessVerdict(map, 3, "enforce", "f3", counters);
  assert.equal(counters.entailed, 1);
  assert.equal(counters.contradicted, 1);
  assert.equal(counters.unsupported, 1);
  assert.equal(counters.unchecked, 1);
});


// ---------------------------------------------------------------------------
// #1576: model-override routing — codex P2 (PRRT_kwDORJXyws6ObYQ8)
// ---------------------------------------------------------------------------

test("checkFaithfulnessBatch: extractionFaithfulnessModel override routes to gateway, skips local (codex P2)", async () => {
  // LocalLlmClient always sends config.localLlmModel and ignores options.model,
  // so a local success would silently run the wrong model and the override
  // would never reach the gateway. When an override is set the local backend
  // must be skipped and the gateway fallback must receive the override model.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "verifier-ft-v1",
  });
  const localCalls: Array<{ options: unknown }> = [];
  const localLlm = {
    chatCompletion: async (
      _messages: Array<{ role: string; content: string }>,
      options: Record<string, unknown> = {},
    ) => {
      localCalls.push({ options });
      return {
        content: JSON.stringify([{ index: 0, verdict: "unsupported" }]),
      };
    },
  };
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  const fallbackContent = JSON.stringify([{ index: 0, verdict: "entailed" }]);
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    localLlm as unknown as LocalLlmClient,
    stubFallbackLlm(fallbackContent, fallbackCalls),
  );
  assert.equal(localCalls.length, 0, "local LLM must be skipped when a model override is set");
  assert.equal(fallbackCalls.length, 1, "gateway fallback must run with the override");
  const opts = fallbackCalls[0]?.options as Record<string, unknown>;
  assert.equal(opts?.model, "verifier-ft-v1", "override model must reach the gateway");
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "entailed", "gateway verdict is used, not the local one");
  }
});

test("checkFaithfulnessBatch: no override keeps the local backend first (regression guard)", async () => {
  // Without an override, the local backend must still be tried first (the
  // override-skip is conditional, not unconditional).
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = baseConfig();
  const localCalls: number[] = [];
  const localLlm = {
    chatCompletion: async () => {
      localCalls.push(1);
      return { content: JSON.stringify([{ index: 0, verdict: "entailed" }]) };
    },
  };
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    localLlm as unknown as LocalLlmClient,
    stubFallbackLlm("[]", fallbackCalls),
  );
  assert.equal(localCalls.length, 1, "local backend is used when no override is set");
  assert.equal(fallbackCalls.length, 0, "fallback is not reached when local succeeds");
  assert.equal(result.results[0]?.ok, true);
});

test("checkFaithfulnessBatch: local call is bounded by timeoutMs, not the batch signal (kilo)", async () => {
  // LocalLlmClient.chatCompletion does not read options.signal — it uses its
  // own per-attempt AbortController keyed on timeoutMs. The gate must forward
  // timeoutMs (so each local attempt is bounded by the faithfulness budget)
  // and must NOT forward the batch signal (dead code the local client drops).
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = baseConfig();
  const captured: Array<{ options: Record<string, unknown> }> = [];
  const localLlm = {
    chatCompletion: async (
      _messages: Array<{ role: string; content: string }>,
      options: Record<string, unknown> = {},
    ) => {
      captured.push({ options });
      return { content: JSON.stringify([{ index: 0, verdict: "entailed" }]) };
    },
  };
  await checkFaithfulnessBatch(
    inputs,
    config,
    localLlm as unknown as LocalLlmClient,
    stubFallbackLlm("[]"),
  );
  assert.equal(captured.length, 1, "local backend runs once");
  const opts = captured[0]?.options;
  assert.equal(typeof opts?.timeoutMs, "number", "timeoutMs is forwarded to bound each local attempt");
  assert.equal(opts?.operation, "extraction-faithfulness");
  assert.equal("signal" in (opts ?? {}), false, "batch signal is not forwarded to the local client (it ignores it)");
  assert.equal("model" in (opts ?? {}), false, "model override is not forwarded to the local client (it ignores it)");
});

// ---------------------------------------------------------------------------
// #1576: multi-source verification — codex P2 (PRRT_kwDORJXyws6ObYQ_)
// ---------------------------------------------------------------------------

test("runFaithfulnessGateBatch: multi-source facts verify against ALL source spans (codex P2)", async () => {
  // A composite fact whose support is split across two adjacent source spans.
  // Previously only sources[0] reached the verifier; the second span (the
  // actual support for the date/status) was discarded, risking a false
  // unsupported verdict (and a spurious pending_review in enforce mode). The
  // verifier must now see the full evidence.
  const facts = [
    {
      content: "The Acme project launched in March 2024 at beta status.",
      sources: [
        { quote: "We started the Acme project earlier this year." },
        { quote: "It launched in March 2024 at beta status." },
      ],
    },
  ];
  const counters = createFaithfulnessCounters();
  const captured: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
  const llm = JSON.stringify([{ index: 0, verdict: "entailed" }]);
  const result = await runFaithfulnessGateBatch(
    facts,
    "shadow",
    baseConfig(),
    null,
    stubFallbackLlm(llm, captured),
    counters,
  );
  assert.ok(result instanceof Map);
  assert.equal(result.size, 1);
  const r0 = result.get(0);
  assert.equal(r0?.ok, true);
  if (r0?.ok) assert.equal(r0.verdict, "entailed");
  // The verifier prompt must include BOTH source spans, not just sources[0].
  const userMsg = captured[0]?.messages.find((m) => m.role === "user");
  assert.ok(
    userMsg?.content.includes("We started the Acme project"),
    "first source span must reach the verifier prompt",
  );
  assert.ok(
    userMsg?.content.includes("It launched in March 2024 at beta status."),
    "second source span must reach the verifier prompt (multi-source fix)",
  );
});

test("checkFaithfulnessBatch: a wedged local backend that ignores the signal still fails open at the budget (codex P2)", async () => {
  // LocalLlmClient ignores options.signal and aborts each attempt via its own
  // controller. A wedged local verifier that never resolves within the budget
  // must NOT hold the batch past extractionFaithfulnessTimeoutMs — the race
  // returns timeout promptly so the extraction flush is not blocked
  // (codex review PRRT_kwDORJXyws6ObgMJ).
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({ extractionFaithfulnessTimeoutMs: 50 });
  const hungLocal = {
    // Never resolves within the test window and ignores any signal.
    chatCompletion: async () => {
      const { promise } = Promise.withResolvers<never>();
      return promise;
    },
  };
  const startedAt = Date.now();
  const result = await checkFaithfulnessBatch(
    inputs, config, hungLocal as unknown as LocalLlmClient, null,
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "timeout");
  }
  // The batch returned near the budget, not after the hung promise.
  assert.ok(elapsed < 1000, `batch must fail open near the budget, not block (elapsed=${elapsed}ms)`);
});


// ---------------------------------------------------------------------------
// #1576: fallback-locator source context — codex P2 (PRRT_kwDORJXyws6OblI1)
// extractionFaithfulnessContextChars must actually reach the verifier in the
// fallback-locator path, otherwise composite facts whose support depends on
// surrounding source text get misrouted to pending_review in enforce mode.
// ---------------------------------------------------------------------------

test("extractContextWindow: returns a bounded window centered on the quote", () => {
  const sourceText =
    "We started the Acme project earlier this year. It launched in March 2024 at beta status. The team is small.";
  const quote = "It launched in March 2024 at beta status.";
  // contextChars=40 must bound the window; the quote itself is 42 chars so the
  // window is at least the quote plus a sliver of neighbors on each side.
  const ctx = extractContextWindow(sourceText, quote, 40);
  assert.ok(ctx, "expected a context window");
  assert.ok(ctx!.length <= 40, `window must be bounded by contextChars (got ${ctx!.length})`);
  assert.ok(ctx!.includes("launched"), "window must overlap the quote");
});

test("extractContextWindow: grows neighbors when budget exceeds quote length", () => {
  const sourceText =
    "Earlier the project was unnamed. We started the Acme project earlier this year. Later we renamed it.";
  const quote = "We started the Acme project earlier this year.";
  const ctx = extractContextWindow(sourceText, quote, 120);
  assert.ok(ctx, "expected a context window");
  assert.ok(ctx!.length <= 120, `window bounded (got ${ctx!.length})`);
  // Neighboring sentences must be pulled in now that the budget allows it.
  assert.ok(ctx!.includes("Earlier the project was unnamed"), "preceding context included");
  assert.ok(ctx!.includes("Later we renamed it"), "following context included");
});

test("extractContextWindow: returns undefined when quote is absent from sourceText", () => {
  assert.equal(extractContextWindow("some source", "not present", 400), undefined);
  assert.equal(extractContextWindow("", "x", 400), undefined);
  assert.equal(extractContextWindow("source", "s", 0), undefined);
});

test("extractContextWindow: matchedOffset selects the matched occurrence, not the first (issue #1633, codex :710)", () => {
  // The same anaphoric line appears twice — once about Acme, once about Zeta.
  // Without matchedOffset, indexOf centers context on Acme (the first hit).
  // With the locator's offset, the window must center on the matched (Zeta) hit.
  const sourceText =
    "Acme context before. It launched in March. Acme context after. " +
    "Zeta context before. It launched in March. Zeta context after.";
  const quote = "It launched in March.";
  const firstOccurrence = sourceText.indexOf(quote);
  const zetaOccurrence = sourceText.indexOf("Zeta context before");
  assert.ok(firstOccurrence >= 0 && zetaOccurrence > firstOccurrence);
  // Budget 50 captures the surrounding entity tag without spanning both
  // occurrences (which would make them indistinguishable).
  const ctxDefault = extractContextWindow(sourceText, quote, 50);
  const ctxMatched = extractContextWindow(sourceText, quote, 50, zetaOccurrence);
  const ctxFirst = extractContextWindow(sourceText, quote, 50, firstOccurrence);
  assert.ok(ctxDefault && ctxMatched && ctxFirst, "all windows must resolve");
  assert.ok(
    ctxDefault!.includes("Acme") && !ctxDefault!.includes("Zeta"),
    "default (no offset) centers on the first (Acme) occurrence, not Zeta",
  );
  assert.ok(
    ctxMatched!.includes("Zeta") && !ctxMatched!.includes("Acme"),
    "matchedOffset centers on the matched (Zeta) occurrence, not Acme",
  );
  assert.notEqual(ctxMatched, ctxDefault, "windows must differ when offset disambiguates");
  assert.equal(ctxFirst, ctxDefault, "explicit first-occurrence offset equals the default");
});

test("runFaithfulnessGateBatch: fallback locator injects CONTEXT into the verifier prompt (codex P2 PRRT_kwDORJXyws6OblI1)", async () => {
  // No #1575 sources → the fallback locator locates a quote from sourceText.
  // Previously the input never set `context`, so the surrounding turn text
  // (and thus extractionFaithfulnessContextChars) was ignored in production.
  // The verifier prompt must now include a CONTEXT line around the quote.
  const facts = [{ content: "The Acme project launched in March." }];
  const sourceText =
    "We started the Acme project earlier this year. It launched in March at beta status. The team is small.";
  const captured: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
  const llm = JSON.stringify([{ index: 0, verdict: "entailed" }]);
  const result = await runFaithfulnessGateBatch(
    facts,
    "shadow",
    baseConfig(),
    null,
    stubFallbackLlm(llm, captured),
    createFaithfulnessCounters(),
    sourceText,
  );
  assert.ok(result instanceof Map);
  assert.equal(result.size, 1);
  const userMsg = captured[0]?.messages.find((m) => m.role === "user");
  assert.ok(userMsg, "verifier was called");
  assert.match(userMsg!.content, /CONTEXT:/, "fallback-locator prompt must include a CONTEXT line");
  // The surrounding sentence must be present in the context window.
  assert.ok(
    userMsg!.content.includes("We started the Acme project"),
    "context window must include the neighboring source text",
  );
});

test("runFaithfulnessGateBatch: #1575 verified spans do NOT synthesize a context window (regression guard)", async () => {
  // When per-fact sources are present, the verified span already carries full
  // evidence — no fallback context window should be synthesized.
  const facts = [
    {
      content: "The Acme project launched in March 2024 at beta status.",
      sources: [{ quote: "It launched in March 2024 at beta status." }],
    },
  ];
  const captured: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
  const llm = JSON.stringify([{ index: 0, verdict: "entailed" }]);
  await runFaithfulnessGateBatch(
    facts,
    "shadow",
    baseConfig(),
    null,
    stubFallbackLlm(llm, captured),
    createFaithfulnessCounters(),
    "We started the Acme project earlier this year. It launched in March 2024 at beta status.",
  );
  const userMsg = captured[0]?.messages.find((m) => m.role === "user");
  assert.ok(userMsg);
  assert.doesNotMatch(userMsg!.content, /CONTEXT:/, "no context window for #1575 verified spans");
});

test("parseFaithfulnessResponse: object-wrapped arrays unwrap (results/verdicts/entries/facts) — gate-bypass fix #1576 Ob4RO", () => {
  // Before the fix these object-wrapped shapes were rejected as malformed, so in
  // enforce mode the batch went `unchecked` and unsupported facts wrote ACTIVE.
  for (const key of ["results", "verdicts", "entries", "facts"]) {
    const raw = JSON.stringify({ [key]: [{ index: 0, verdict: "unsupported", rationale: "x" }] });
    const map = parseFaithfulnessResponse(raw, 1);
    assert.ok(map, `${key}-wrapped array should parse, not be rejected as malformed`);
    assert.equal(map.get(0)?.verdict, "unsupported");
  }
  // A wrapper object with no recognized array key still returns null (no over-match).
  assert.equal(parseFaithfulnessResponse('{"data": {"nested": []}}', 1), null);
});

// ---------------------------------------------------------------------------
// Issue #1585 model-lab pointer: local fine-tuned endpoint path
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch that responds for a specific base URL with a canned
 * openai-compatible chat-completions body. Records the request body so tests
 * can assert the gate routed to the local model.
 */
function fakeFetchFor(
  baseUrl: string,
  responder: (body: Record<string, unknown>) => unknown,
): { fetch: typeof fetch; requests: Array<{ url: string; body: Record<string, unknown> }> } {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fake = ((url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    const body = JSON.parse(String(init.body));
    const payload = responder(body);
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetch: fake, requests };
}

test("checkFaithfulnessBatch: local model-lab endpoint is tried first when configured (#1585)", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  const { fetch: fakeFetch, requests } = fakeFetchFor("http://localhost:11434/v1", (body) => ({
    model: body.model,
    choices: [{ message: { content: JSON.stringify([{ index: 0, verdict: "contradicted" }]) } }],
  }));
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm("[]", fallbackCalls),
    fakeFetch,
  );
  assert.equal(requests.length, 1, "local model-lab endpoint must be called");
  assert.equal(requests[0]?.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(requests[0]?.body.model, "remnic-faithfulness-gate-v1");
  assert.equal(fallbackCalls.length, 0, "gateway fallback must NOT run when the local endpoint succeeds");
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "contradicted", "local model verdict is used");
    assert.equal(result.results[0].model, "remnic-faithfulness-gate-v1");
  }
});

test("checkFaithfulnessBatch: local endpoint failure falls back to the configured chain (#1585 graceful)", async () => {
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  // Local endpoint returns 500 → caller returns null → gate falls through to fallback.
  const failingFetch = (() =>
    Promise.resolve(new Response("err", { status: 500 }))) as unknown as typeof fetch;
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }]), fallbackCalls),
    failingFetch,
  );
  assert.equal(fallbackCalls.length, 1, "must fall back to the configured chain on local-endpoint failure");
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "entailed", "fallback chain verdict is used");
  }
});

test("checkFaithfulnessBatch: a wedged local endpoint falls back to the chain BEFORE the batch timeout (codex P2 — probe budget)", async () => {
  // The local probe must use a SMALLER budget than the outer batch timeout so a
  // hanging endpoint returns null and the configured chain runs before the batch
  // timer fires. extractionFaithfulnessTimeoutMs: 1000 → probe budget = 500ms.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 1000,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  // A fetch that hangs forever on its own but HONORS the probe's AbortSignal —
  // the probe's controller aborts it at 500ms (half the batch budget), the call
  // returns null, and the gate falls through to the configured chain.
  const wedgedFetch = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const sig = init.signal;
      if (!sig) return;
      if (sig.aborted) reject(new Error("aborted"));
      else sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }]), fallbackCalls),
    wedgedFetch,
  );
  assert.equal(
    fallbackCalls.length,
    1,
    "a wedged local probe must reach the configured chain before the batch budget elapses",
  );
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "entailed", "fallback chain verdict is used");
  }
});

test("checkFaithfulnessBatch: no local endpoint pointer → byte-identical routing (regression guard)", async () => {
  // Default config (no baseUrl) must never attempt a local-endpoint fetch.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = baseConfig();
  let fetchCalled = false;
  const spyFetch = (() => {
    fetchCalled = true;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }])),
    spyFetch,
  );
  assert.equal(fetchCalled, false, "no local-endpoint fetch when pointer is unset");
});


test("checkFaithfulnessBatch: local-endpoint failure does NOT leak the local model name into the fallback chain (codex P2 PRRT_kwDORJXyws6Otp-L)", async () => {
  // extractionFaithfulnessModel is the LOCAL served model's name. When the
  // local endpoint is configured but fails, that name must NOT be forwarded to
  // the gateway/fallback as options.model — otherwise the configured chain is
  // forced onto an unavailable local-only model and a local outage becomes
  // backend_unavailable instead of graceful fallback to the configured chain.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  // Local endpoint returns 500 -> caller returns null -> gate falls through.
  const failingFetch = (() =>
    Promise.resolve(new Response("err", { status: 500 }))) as unknown as typeof fetch;
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }]), fallbackCalls),
    failingFetch,
  );
  assert.equal(fallbackCalls.length, 1, "fallback chain must run on local-endpoint failure");
  const opts = fallbackCalls[0]?.options as Record<string, unknown>;
  assert.equal(
    opts?.model,
    undefined,
    "local-only model name must NOT leak into the fallback chain on endpoint failure",
  );
  assert.equal(result.results[0]?.ok, true);
});

// ---------------------------------------------------------------------------
// Issue #1700 nits #5 + #6: probe signal forwarding + local parse-fallback
// ---------------------------------------------------------------------------

test("callOpenAiCompatibleChat: a pre-aborted batch signal aborts the probe immediately, not after timeoutMs (#1700 nit #5)", async () => {
  // The batch signal is ALREADY aborted when the probe starts. With nit #5 the
  // probe forwards it and aborts instantly; without it the probe would wait for
  // its own timeoutMs (5000ms here). Assert the probe returns null fast.
  const endpoint = { baseUrl: "http://localhost:11434/v1", model: "remnic-faithfulness-gate-v1" };
  const batchController = new AbortController();
  batchController.abort();
  const spy = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const sig = init.signal;
      if (!sig) return reject(new Error("no signal"));
      if (sig.aborted) return reject(new Error("aborted"));
      sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
  const start = Date.now();
  const result = await callOpenAiCompatibleChat(
    endpoint,
    [{ role: "user", content: "hi" }],
    { timeoutMs: 5000, signal: batchController.signal },
    spy,
  );
  const elapsed = Date.now() - start;
  assert.equal(result, null, "a pre-aborted signal must fail the probe closed (null)");
  assert.ok(
    elapsed < 1000,
    `probe must abort immediately on a pre-aborted signal (${elapsed}ms), not wait timeoutMs`,
  );
});

test("checkFaithfulnessBatch: default surfaces malformed_output for a 200-with-garbage local response (#1700 nit #6)", async () => {
  // extractionFaithfulnessLocalParseFallback unset (default false): a local
  // endpoint returning 200 with non-verdict JSON surfaces malformed_output so a
  // misconfigured endpoint is visible. The configured chain must NOT run.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  const { fetch: garbageFetch } = fakeFetchFor("http://localhost:11434/v1", () => ({
    model: "remnic-faithfulness-gate-v1",
    choices: [{ message: { content: "this is not a verdict array" } }],
  }));
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }]), fallbackCalls),
    garbageFetch,
  );
  assert.equal(fallbackCalls.length, 0, "chain must NOT run when flag is off — garbage surfaces loudly");
  assert.equal(result.results[0]?.ok, false);
  if (!result.results[0]?.ok) {
    assert.equal(result.results[0].error.code, "malformed_output");
  }
});

test("checkFaithfulnessBatch: extractionFaithfulnessLocalParseFallback falls back to the chain on local parse failure (#1700 nit #6)", async () => {
  // Flag ON: the same 200-with-garbage local response now falls through to the
  // configured chain instead of surfacing malformed_output (resilient fallback).
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
    extractionFaithfulnessLocalParseFallback: true,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  const { fetch: garbageFetch } = fakeFetchFor("http://localhost:11434/v1", () => ({
    model: "remnic-faithfulness-gate-v1",
    choices: [{ message: { content: "this is not a verdict array" } }],
  }));
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }]), fallbackCalls),
    garbageFetch,
  );
  assert.equal(
    fallbackCalls.length,
    1,
    "chain MUST run when flag is on and the local response is unparseable",
  );
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "entailed", "fallback chain verdict is used");
  }
});

test("checkFaithfulnessBatch: extractionFaithfulnessLocalParseFallback does NOT fall back when the local response is valid (#1700 nit #6 regression)", async () => {
  // Flag ON but the local response IS a valid verdict array → use it, do not
  // call the chain. Guards against the flag over-triggering on good responses.
  const inputs = [{ factText: "Fact", quote: "Quote" }];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
    extractionFaithfulnessLocalParseFallback: true,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  const { fetch: goodFetch } = fakeFetchFor("http://localhost:11434/v1", () => ({
    model: "remnic-faithfulness-gate-v1",
    choices: [{ message: { content: JSON.stringify([{ index: 0, verdict: "contradicted" }]) } }],
  }));
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(JSON.stringify([{ index: 0, verdict: "entailed" }]), fallbackCalls),
    goodFetch,
  );
  assert.equal(fallbackCalls.length, 0, "chain must NOT run when the local response is valid, even with the flag on");
  assert.equal(result.results[0]?.ok, true);
  if (result.results[0]?.ok) {
    assert.equal(result.results[0].verdict, "contradicted", "valid local verdict is used");
  }
});

test("checkFaithfulnessBatch: extractionFaithfulnessLocalParseFallback falls back when the local response is a PARTIAL verdict array (codex P2 PRRT_kwDORJXyws6O6zwZ)", async () => {
  // Flag ON: a local endpoint that returns a valid-but-INCOMPLETE verdict
  // array (1 of N entries) must fall through to the configured chain, NOT be
  // accepted as-is. parseFaithfulnessResponse is truthy as soon as ONE entry
  // is valid, so the previous guard accepted the partial response and the
  // missing indexes surfaced as malformed_output downstream -- defeating the
  // resilient fallback. Accept the local response only when it covers every
  // expected index.
  const inputs = [
    { factText: "Fact A", quote: "Quote A" },
    { factText: "Fact B", quote: "Quote B" },
  ];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
    extractionFaithfulnessLocalParseFallback: true,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  // Local endpoint returns only index 0 -- index 1 is missing (partial).
  const { fetch: partialFetch } = fakeFetchFor("http://localhost:11434/v1", () => ({
    model: "remnic-faithfulness-gate-v1",
    choices: [{ message: { content: JSON.stringify([{ index: 0, verdict: "contradicted" }]) } }],
  }));
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(
      JSON.stringify([
        { index: 0, verdict: "entailed" },
        { index: 1, verdict: "unsupported" },
      ]),
      fallbackCalls,
    ),
    partialFetch,
  );
  assert.equal(
    fallbackCalls.length,
    1,
    "a partial local verdict array must fall through to the configured chain",
  );
  // The chain's complete verdict array is used for both indexes.
  assert.equal(result.results[0]?.ok && result.results[0].verdict, "entailed");
  assert.equal(result.results[1]?.ok && result.results[1].verdict, "unsupported");
});

test("checkFaithfulnessBatch: extractionFaithfulnessLocalParseFallback falls back when local indexes are fractional/non-contiguous (codex P2 PRRT_kwDORJXyws6O7PfY)", async () => {
  // Flag ON: a malformed local response with expectedCount distinct but
  // NON-INTEGER indexes (e.g. 0 and 0.5 for a two-item batch) must NOT be
  // accepted. parseFaithfulnessResponse used to admit any numeric index, so a
  // size-only check passed while index 1 stayed missing -> malformed_output.
  // parseEntries now rejects non-integer indexes, and the gate requires every
  // integer key 0..N-1 before accepting the local response.
  const inputs = [
    { factText: "Fact A", quote: "Quote A" },
    { factText: "Fact B", quote: "Quote B" },
  ];
  const config = parseConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
    extractionFaithfulnessTimeoutMs: 5000,
    extractionFaithfulnessLocalParseFallback: true,
  });
  const fallbackCalls: Array<{ messages: unknown; options: unknown }> = [];
  // Local endpoint returns indexes 0 and 0.5 -- two distinct keys, but index 1
  // is missing (fractional index is invalid).
  const { fetch: fracFetch } = fakeFetchFor("http://localhost:11434/v1", () => ({
    model: "remnic-faithfulness-gate-v1",
    choices: [{ message: { content: JSON.stringify([
      { index: 0, verdict: "contradicted" },
      { index: 0.5, verdict: "entailed" },
    ]) } }],
  }));
  const result = await checkFaithfulnessBatch(
    inputs,
    config,
    null,
    stubFallbackLlm(
      JSON.stringify([
        { index: 0, verdict: "entailed" },
        { index: 1, verdict: "unsupported" },
      ]),
      fallbackCalls,
    ),
    fracFetch,
  );
  assert.equal(
    fallbackCalls.length,
    1,
    "a fractional/non-contiguous local response must fall through to the chain",
  );
  assert.equal(result.results[0]?.ok && result.results[0].verdict, "entailed");
  assert.equal(result.results[1]?.ok && result.results[1].verdict, "unsupported");
});

test('parseConfig: extractionFaithfulnessLocalParseFallback coerces CLI string "true" (#1700 review — coerceBool parity)', () => {
  // A CLI override reaches the parser as the string "true"; === true would
  // silently leave the flag disabled. coerceBool must turn it on (gotcha 36).
  const onByString = parseConfig({
    extractionFaithfulnessLocalParseFallback: "true",
  });
  assert.equal(onByString.extractionFaithfulnessLocalParseFallback, true);
  const onByBool = parseConfig({
    extractionFaithfulnessLocalParseFallback: true,
  });
  assert.equal(onByBool.extractionFaithfulnessLocalParseFallback, true);
  const offDefault = parseConfig({});
  assert.equal(offDefault.extractionFaithfulnessLocalParseFallback, false);
  const offByString = parseConfig({
    extractionFaithfulnessLocalParseFallback: "false",
  });
  assert.equal(offByString.extractionFaithfulnessLocalParseFallback, false);
});
