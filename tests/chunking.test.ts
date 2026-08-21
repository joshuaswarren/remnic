import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkContent,
  joinSentences,
  reassembleChunks,
  splitSentences,
} from "../packages/remnic-core/src/chunking.js";

test("splitSentences handles CJK terminators without ASCII spaces", () => {
  const text = "第一文です。第二文です！第三文です？";

  assert.deepEqual(splitSentences(text), [
    "第一文です。",
    "第二文です！",
    "第三文です？",
  ]);
});

test("splitSentences handles Arabic and Indic terminators", () => {
  const text = "مرحبا بالعالم؟كيف حالك؟यह पहला वाक्य है।यह दूसरा वाक्य है।";

  assert.deepEqual(splitSentences(text), [
    "مرحبا بالعالم؟",
    "كيف حالك؟",
    "यह पहला वाक्य है।",
    "यह दूसरा वाक्य है।",
  ]);
});

test("splitSentences handles ellipses and mixed ASCII content", () => {
  assert.deepEqual(splitSentences("甲…乙…"), ["甲…", "乙…"]);
  assert.deepEqual(splitSentences("word0_0. word1_0. 日本語。"), [
    "word0_0.",
    "word1_0.",
    "日本語。",
  ]);
});

test("chunkContent does not add spaces between CJK sentences", () => {
  const content = "第一文です。第二文です！第三文です？";
  const result = chunkContent(content, {
    targetTokens: 1,
    minTokens: 1,
    overlapSentences: 0,
  });

  assert.equal(reassembleChunks(result.chunks.map((chunk) => chunk.content)), content);
  assert.ok(result.chunks.every((chunk) => !chunk.content.includes("。 ")));
});

test("splitSentences preserves Arabic spaces and quoted CJK boundaries", () => {
  assert.deepEqual(splitSentences("مرحبا؟ كيف حالك؟"), ["مرحبا؟", "كيف حالك؟"]);
  assert.deepEqual(splitSentences("「第一文です。」第二文です。"), [
    "「第一文です。」",
    "第二文です。",
  ]);
  assert.deepEqual(splitSentences("値は３．１４です。次です。"), [
    "値は３．１４です。",
    "次です。",
  ]);
});

test("splitSentences handles additional Unicode sentence marks", () => {
  assert.deepEqual(splitSentences("第一文｡第二文｡"), ["第一文｡", "第二文｡"]);
  assert.deepEqual(splitSentences("पहला वाक्य॥दूसरा वाक्य॥"), [
    "पहला वाक्य॥",
    "दूसरा वाक्य॥",
  ]);
  assert.deepEqual(splitSentences("Wait… Next sentence."), [
    "Wait…",
    "Next sentence.",
  ]);
  assert.deepEqual(splitSentences("(第一文です。)第二文です。"), [
    "(第一文です。)",
    "第二文です。",
  ]);
});

test("joinSentences preserves Unicode boundary spacing", () => {
  assert.equal(
    joinSentences(splitSentences("第一文です．第二文です．")),
    "第一文です．第二文です．",
  );
  assert.equal(
    joinSentences(splitSentences("مرحبا؟كيف حالك؟")),
    "مرحبا؟كيف حالك؟",
  );
  assert.equal(
    joinSentences(splitSentences("مرحبا؟ كيف حالك؟")),
    "مرحبا؟ كيف حالك؟",
  );
  assert.equal(
    joinSentences(splitSentences("Wait… Next sentence.")),
    "Wait… Next sentence.",
  );
});

test("chunkContent splits long Japanese and Arabic documents", () => {
  const japanese = Array.from({ length: 12 }, () => "これは日本語の文です。").join("");
  const arabic = Array.from({ length: 12 }, () => "هذه جملة عربية طويلة؟").join("");
  const config = { targetTokens: 8, minTokens: 1, overlapSentences: 0 };

  assert.ok(chunkContent(japanese, config).chunks.length > 1);
  assert.ok(chunkContent(arabic, config).chunks.length > 1);
});

test("splitSentences preserves English punctuation behavior", () => {
  assert.deepEqual(splitSentences("Version v1.2.3 stays intact. Next sentence!"), [
    "Version v1.2.3 stays intact.",
    "Next sentence!",
  ]);
});
