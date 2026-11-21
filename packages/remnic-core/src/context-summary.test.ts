/**
 * Tests for the shared context summary seam (issue #2347).
 *
 * Covers: deterministic truncation, llm mode (success + no-silent-fallback
 * failure), auto escalation ladder, telemetry prefilter, output tolerance,
 * and callers receiving text the way the callers (LCM summarizer,
 * active-context transforms) consume it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextSummaryUnavailableError,
  deterministicTruncate,
  summarizeContextPure,
  type SummarizeFn,
} from "./context-summary.js";
import { estimateTokenCount } from "./token-estimate.js";

/** Stub LLM seam echoing the target tokens so tests can assert on it. */
const okLlm: SummarizeFn = async (text, targetTokens, aggressive) =>
  `summary(${targetTokens}${aggressive ? ",agg" : ""}): ${text.slice(0, 8)}`;

// ─── deterministic mode ───────────────────────────────────────────────────

test("deterministic: never calls the llm, never throws", async () => {
  let called = false;
  const spy: SummarizeFn = async () => {
    called = true;
    return "should not be used";
  };
  const result = await summarizeContextPure("a b c", 100, "deterministic", { llm: spy });
  assert.equal(called, false);
  assert.equal(result.method, "deterministic");
  assert.equal(result.fallback, false);
  assert.equal(result.escalation, undefined);
  assert.equal(result.text, "a b c");
});

test("deterministic: under-budget text passes through unchanged", async () => {
  const result = await summarizeContextPure("one two three", 100, "deterministic");
  assert.equal(result.text, "one two three");
});

test("deterministic: over-budget text is capped to min(target, max)", async () => {
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const result = await summarizeContextPure(text, 20, "deterministic");
  assert.ok(estimateTokenCount(result.text) <= 20);
});

test("deterministic: deterministicMaxTokens clamps a large target", async () => {
  const text = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
  const result = await summarizeContextPure(text, 10_000, "deterministic", {
    deterministicMaxTokens: 16,
  });
  assert.ok(estimateTokenCount(result.text) <= 16);
});

test("deterministic: deterministicMaxTokens floor of 1 is enforced", async () => {
  const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
  const result = await summarizeContextPure(text, 5, "deterministic", {
    deterministicMaxTokens: 0,
  });
  assert.ok(estimateTokenCount(result.text) >= 1);
});

// ─── llm mode ─────────────────────────────────────────────────────────────

test("llm: success returns llm text with method llm and no fallback", async () => {
  const result = await summarizeContextPure("some text", 50, "llm", { llm: okLlm, modelUsed: "gpt-test" });
  assert.equal(result.method, "llm");
  assert.equal(result.fallback, false);
  assert.equal(result.escalation, undefined);
  assert.equal(result.modelUsed, "gpt-test");
  assert.ok(result.text.includes("summary(50"));
});

test("llm: exactly one call, non-aggressive", async () => {
  const calls: Array<[string, number, boolean]> = [];
  const spy: SummarizeFn = async (text, targetTokens, aggressive) => {
    calls.push([text, targetTokens, aggressive]);
    return "fine";
  };
  const result = await summarizeContextPure("text", 50, "llm", { llm: spy });
  assert.equal(result.text, "fine");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], false);
  assert.equal(calls[0][1], 50);
});

test("llm: missing seam throws, no silent fallback", async () => {
  await assert.rejects(
    summarizeContextPure("text", 50, "llm"),
    ContextSummaryUnavailableError,
  );
});

test("llm: seam error throws ContextSummaryUnavailableError", async () => {
  const boom: SummarizeFn = async () => {
    throw new Error("llm exploded");
  };
  await assert.rejects(
    summarizeContextPure("text", 50, "llm", { llm: boom }),
    (err: unknown) =>
      err instanceof ContextSummaryUnavailableError && err.message.includes("llm path failed"),
  );
});

test("llm: empty output throws", async () => {
  const empty: SummarizeFn = async () => "   ";
  await assert.rejects(summarizeContextPure("text", 50, "llm", { llm: empty }), ContextSummaryUnavailableError);
});

test("llm: output over the 1.5x tolerance is rejected", async () => {
  const long: SummarizeFn = async (_text, targetTokens) =>
    Array.from({ length: Math.ceil(targetTokens * 2) }, () => "word").join(" ");
  await assert.rejects(summarizeContextPure("text", 50, "llm", { llm: long }), ContextSummaryUnavailableError);
});

test("llm: output within tolerance is accepted", async () => {
  const nearLimit: SummarizeFn = async (_text, targetTokens) =>
    Array.from({ length: Math.ceil(targetTokens * 1.2) }, () => "word").join(" ");
  const result = await summarizeContextPure("text", 50, "llm", { llm: nearLimit });
  assert.equal(result.method, "llm");
});

// ─── auto mode ────────────────────────────────────────────────────────────

test("auto: llm success at level 0", async () => {
  const result = await summarizeContextPure("text", 50, "auto", { llm: okLlm });
  assert.equal(result.method, "llm");
  assert.equal(result.fallback, false);
  assert.equal(result.escalation, 0);
});

test("auto: escalates to aggressive at level 1 on normal-path failure", async () => {
  const calls: Array<[number, boolean]> = [];
  const flaky: SummarizeFn = async (_t, targetTokens, aggressive) => {
    calls.push([targetTokens, aggressive]);
    if (!aggressive) {
      return Array.from({ length: 1000 }, () => "word").join(" "); // over tolerance
    }
    return "compact summary";
  };
  const result = await summarizeContextPure("text", 60, "auto", { llm: flaky });
  assert.equal(result.text, "compact summary");
  assert.equal(result.fallback, true);
  assert.equal(result.escalation, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], false);
  assert.equal(calls[1][1], true);
  assert.equal(calls[1][0], Math.max(32, Math.ceil(60 * 0.5)));
});

test("auto: aggressive target floor of 32 tokens for tiny targets", async () => {
  const calls: Array<number> = [];
  const spy: SummarizeFn = async (_t, targetTokens, aggressive) => {
    if (!aggressive) return "x".repeat(10_000); // always rejected
    calls.push(targetTokens);
    return "ok";
  };
  await summarizeContextPure("text", 10, "auto", { llm: spy });
  assert.equal(calls[0], 32);
});

test("auto: falls back to deterministic at level 2 when no seam", async () => {
  const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const result = await summarizeContextPure(text, 50, "auto");
  assert.equal(result.method, "deterministic");
  assert.equal(result.fallback, true);
  assert.equal(result.escalation, 2);
  assert.ok(estimateTokenCount(result.text) <= 256);
});

test("auto: telemetry prefilter routes mechanical transcripts to level 2", async () => {
  let called = false;
  const spy: SummarizeFn = async () => {
    called = true;
    return "should not run";
  };
  const telemetry =
    Array.from({ length: 10 }, (_, i) => `[action ${i}]: right`).join("\n");
  const result = await summarizeContextPure(telemetry, 50, "auto", {
    llm: spy,
    telemetryPrefilterEnabled: true,
  });
  assert.equal(called, false);
  assert.equal(result.method, "deterministic");
  assert.equal(result.fallback, true);
  assert.equal(result.escalation, 2);
});

test("auto: telemetry prefilter disabled lets llm run on telemetry text", async () => {
  const spy: SummarizeFn = async () => "summarized telemetry";
  const telemetry =
    Array.from({ length: 10 }, (_, i) => `[action ${i}]: right`).join("\n");
  const result = await summarizeContextPure(telemetry, 50, "auto", {
    llm: spy,
    telemetryPrefilterEnabled: false,
  });
  assert.equal(result.method, "llm");
  assert.equal(result.text, "summarized telemetry");
});

// ─── deterministicTruncate ────────────────────────────────────────────────

test("deterministicTruncate: short text unchanged", () => {
  assert.equal(deterministicTruncate("hello world", 100), "hello world");
});

test("deterministicTruncate: keeps first and last sentence with [...] marker", () => {
  const text = "First sentence here. Second sentence follows. Third sentence exists. Last sentence ends.";
  const out = deterministicTruncate(text, 14);
  assert.ok(out.startsWith("First sentence here."));
  assert.ok(out.endsWith("Last sentence ends."));
  assert.ok(out.includes("[...]"));
});

test("deterministicTruncate: fills middle sentences while under budget", () => {
  const text = [
    "One.",
    "Two words here.",
    "Three words now.",
    "Four words in this one.",
    "Nine.",
  ].join(" ");
  const out = deterministicTruncate(text, 20);
  assert.ok(out.startsWith("One."));
  assert.ok(out.endsWith("Nine."));
  // Middle retained greedily only while the render fits the budget.
  assert.ok(estimateTokenCount(out) <= 20);
  assert.ok(out.includes("Two words here."));
});

test("deterministicTruncate: two-sentence text falls back to clamping", () => {
  const text = "Only first sentence. Only second sentence with many many extra words following it here.";
  const out = deterministicTruncate(text, 8);
  assert.ok(estimateTokenCount(out) <= 8);
  assert.ok(out.length < text.length);
});

test("deterministicTruncate: clamp respects wide-script code points", () => {
  const text = "你好".repeat(50);
  const out = deterministicTruncate(text, 20);
  assert.ok(estimateTokenCount(out) <= 20);
  assert.ok(text.startsWith(out));
});

test("deterministicTruncate: maxTokens 0 clamps to empty", () => {
  assert.equal(deterministicTruncate("some text", 0), "");
});

test("deterministicTruncate: byte-safe truncation is UTF-8 clean", () => {
  const out = deterministicTruncate("café naïve résumé. More text follows here. End sentence.", 4);
  assert.ok(estimateTokenCount(out) <= 4);
  assert.equal(Buffer.from(out, "utf8").toString("utf8"), out); // no lone surrogates / mojibake
});
