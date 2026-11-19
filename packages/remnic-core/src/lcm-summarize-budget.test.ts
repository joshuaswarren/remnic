import assert from "node:assert/strict";
import test from "node:test";

import { LCM_SUMMARIZE_PROMPT_MAX_CHARS, scaleLcmSummarizeBudget } from "./lcm-summarize-budget.js";
import { estimateTokenCount } from "./token-estimate.js";

test("#3407 truncates summarize max_tokens when prompt text is sliced", () => {
  const filler = "word ".repeat(4000);
  const fullText = filler + "x".repeat(LCM_SUMMARIZE_PROMPT_MAX_CHARS + 50_000);
  const batchTokens = estimateTokenCount(fullText);
  const targetTokens = Math.max(64, Math.ceil(batchTokens * 0.25));
  const budget = scaleLcmSummarizeBudget(fullText, targetTokens);
  assert.equal(budget.promptText.length, LCM_SUMMARIZE_PROMPT_MAX_CHARS);
  assert.ok(
    budget.effectiveTargetTokens < targetTokens,
    `expected scaled target (${budget.effectiveTargetTokens}) < batch target (${targetTokens})`,
  );
  assert.ok(
    budget.maxCompletionTokens <= targetTokens,
    `max completion tokens ${budget.maxCompletionTokens} should not exceed unscaled target*2 ${targetTokens * 2}`,
  );
});

test("#3407 leaves short batches unchanged", () => {
  const text = "short lcm batch";
  const targetTokens = 128;
  const budget = scaleLcmSummarizeBudget(text, targetTokens);
  assert.equal(budget.promptText, text);
  assert.equal(budget.effectiveTargetTokens, targetTokens);
  assert.equal(budget.maxCompletionTokens, targetTokens * 2);
});

test("#3407 aggressive retry keeps halved target (32 stays 32)", () => {
  const text = "short lcm batch";
  const normal = scaleLcmSummarizeBudget(text, 64);
  assert.equal(normal.effectiveTargetTokens, 64);
  const aggressiveInput = Math.max(32, Math.ceil(normal.effectiveTargetTokens * 0.5));
  assert.equal(aggressiveInput, 32);
  const aggressive = scaleLcmSummarizeBudget(text, aggressiveInput);
  assert.equal(aggressive.effectiveTargetTokens, 32);
  assert.ok(aggressive.effectiveTargetTokens < normal.effectiveTargetTokens);
});

test("#3407 unscaled 32-token target passes through on short batch", () => {
  const budget = scaleLcmSummarizeBudget("short lcm batch", 32);
  assert.equal(budget.effectiveTargetTokens, 32);
  assert.equal(budget.maxCompletionTokens, 64);
});

test("#3407 truncated 12k-char batch scales below batch target", () => {
  const filler = "word ".repeat(4000);
  const fullText = filler + "z".repeat(80_000);
  const batchTokens = estimateTokenCount(fullText);
  const targetTokens = Math.max(64, Math.ceil(batchTokens * 0.25));
  const budget = scaleLcmSummarizeBudget(fullText, targetTokens);
  assert.equal(budget.promptText.length, LCM_SUMMARIZE_PROMPT_MAX_CHARS);
  assert.ok(budget.effectiveTargetTokens < targetTokens);
});
