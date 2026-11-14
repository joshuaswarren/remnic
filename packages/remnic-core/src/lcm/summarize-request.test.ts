import test from "node:test";
import assert from "node:assert/strict";

import { estimateTokenCount } from "../token-estimate.js";
import { LCM_SUMMARIZE_INPUT_MAX_CHARS, buildLcmSummarizeRequest } from "./summarize-request.js";

/** The target `LcmSummarizer` derives from a whole batch. */
function batchTarget(text: string): number {
  return Math.max(64, Math.ceil(estimateTokenCount(text) * 0.25));
}

/** Roughly 220k characters of synthetic transcript: far more than one call sends. */
const LONG_BATCH = "[user] the deploy failed at step three; retry it with the cached artifact.\n\n".repeat(3_000);

test("a batch that fits is sent whole with the caller's target", () => {
  const text = "[user] short segment\n\n[assistant] short reply";
  const request = buildLcmSummarizeRequest(text, 64, false);
  assert.equal(request.messages[1].content, text);
  assert.equal(request.targetTokens, 64);
  assert.equal(request.maxTokens, 128);
  assert.match(request.messages[0].content, /maximum 64 tokens\.$/);
});

test("a long batch is sized by the text actually sent, not by the whole batch", () => {
  const target = batchTarget(LONG_BATCH);
  assert.ok(target * 2 > 16_384, "fixture must reproduce an over-cap budget under batch sizing");

  const request = buildLcmSummarizeRequest(LONG_BATCH, target, false);
  const sent = request.messages[1].content;
  assert.equal(sent.length, LCM_SUMMARIZE_INPUT_MAX_CHARS);
  assert.ok(
    request.targetTokens <= Math.ceil(estimateTokenCount(sent) * 0.25) + 1,
    `target ${request.targetTokens} must track the ${estimateTokenCount(sent)} tokens sent`,
  );
  assert.equal(request.maxTokens, request.targetTokens * 2);
  assert.ok(request.maxTokens <= 16_384);
  assert.ok(request.messages[0].content.includes(`maximum ${request.targetTokens} tokens`));
});

test("the aggressive retry keeps half the normal target for a long batch", () => {
  const target = batchTarget(LONG_BATCH);
  const normal = buildLcmSummarizeRequest(LONG_BATCH, target, false);
  // Same derivation summarizeContextPure uses for its aggressive attempt.
  const aggressive = buildLcmSummarizeRequest(LONG_BATCH, Math.max(32, Math.ceil(target * 0.5)), true);
  assert.ok(Math.abs(aggressive.targetTokens * 2 - normal.targetTokens) <= 2);
  assert.ok(aggressive.messages[0].content.includes(`Maximum ${aggressive.targetTokens} tokens total`));
});

test("the target never exceeds the caller's, including wide-script text", () => {
  const wide = "部署失败后使用缓存的构件重试。".repeat(2_000);
  for (const text of [wide, LONG_BATCH, "x"]) {
    const target = batchTarget(text);
    const request = buildLcmSummarizeRequest(text, target, false);
    assert.ok(request.targetTokens >= 1 && request.targetTokens <= target);
    assert.ok(request.maxTokens <= 16_384);
  }
});
