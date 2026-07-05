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
  FAITHFULNESS_PROMPT_HASH,
} from "./extraction-faithfulness.js";
import type { FaithfulnessResult } from "./extraction-faithfulness.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
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
 * (simulates a hung request). We resolve after a long delay; the gate's own
 * AbortController will fire first.
 */
function slowFallbackLlm(delayMs: number): FallbackLlmClient {
  return {
    isAvailable: () => true,
    chatCompletion: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: "[]", modelUsed: "slow", usage: undefined };
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

test("runFaithfulnessGateBatch: facts without sources skipped (no LLM call)", async () => {
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
  );
  assert.equal(captured.length, 0, "no LLM call when no facts have sources");
  assert.ok(result instanceof Map, "no-sources batch returns an empty map");
  assert.equal(result.size, 0);
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
  assert.equal(counters.entailed, 1);
  assert.equal(counters.contradicted, 1);
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
