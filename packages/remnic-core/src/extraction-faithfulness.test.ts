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

test("locateFactQuote: finds the best-overlap sentence", () => {
  const src = "I drove to Berlin yesterday. My favorite editor is Vim.";
  assert.equal(
    locateFactQuote("The user likes Vim.", src),
    "My favorite editor is Vim.",
  );
});

test("locateFactQuote: returns undefined below the overlap threshold", () => {
  const src = "The weather is sunny. Stocks rose 2 percent.";
  assert.equal(locateFactQuote("The user lives in Tokyo.", src), undefined);
});

test("locateFactQuote: empty inputs → undefined", () => {
  assert.equal(locateFactQuote("", "text"), undefined);
  assert.equal(locateFactQuote("fact", ""), undefined);
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
