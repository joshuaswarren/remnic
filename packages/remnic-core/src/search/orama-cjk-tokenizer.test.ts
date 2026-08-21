import assert from "node:assert/strict";
import test from "node:test";

import * as orama from "@orama/orama";

import {
  containsNonLegacyTokenizerChars,
  createCjkCapableTokenizer,
  isSpaceFreeScriptChar,
  ORAMA_CJK_TOKENIZER_LANGUAGE,
} from "./orama-cjk-tokenizer.js";

const stockTokenizer = orama.components.tokenizer.createTokenizer({ language: "english" });
const tokenizer = createCjkCapableTokenizer(orama);

test("CJK tokenizer matches the stock English tokenizer for legacy Latin input", () => {
  for (const input of [
    "The quick brown fox jumps over the lazy dog",
    "Nebula-472 deploy finished; it's live (prod)!",
    "snake_case camelCase 42.7%",
    "",
  ]) {
    assert.deepEqual(tokenizer.tokenize(input), stockTokenizer.tokenize(input), input);
  }
});

test("CJK tokenizer expands Japanese runs into n-grams", () => {
  const tokens = tokenizer.tokenize("東京都庁の所在地");

  assert.equal(tokens.includes("東京都庁"), true);
  assert.equal(tokens.includes("所在"), true);
  assert.equal(tokens.includes("地"), true);
  assert.equal(tokens.includes("東京都庁の所在地"), true);
});

test("CJK tokenizer reuses the recall segmentation n-gram sizes", () => {
  // A 5-char run yields chars + 2/3/4-grams + the whole run.
  const tokens = tokenizer.tokenize("用户喜欢深");
  const expected = new Set(["用", "户", "喜", "欢", "深"]);
  for (const size of [2, 3, 4]) {
    for (let i = 0; i <= 5 - size; i++) {
      expected.add("用户喜欢深".slice(i, i + size));
    }
  }
  expected.add("用户喜欢深");
  for (const token of expected) {
    assert.equal(tokens.includes(token), true, token);
  }
});

test("CJK tokenizer keeps Latin tokens intact inside mixed-script input", () => {
  const tokens = tokenizer.tokenize("Nebula-472 東京都庁");

  assert.equal(tokens.includes("nebula-472"), true);
  assert.equal(tokens.includes("東京都庁"), true);
});

test("CJK tokenizer n-grams Thai runs", () => {
  const tokens = tokenizer.tokenize("กรุงเทพมหานคร");

  assert.equal(tokens.includes("กรุง"), true);
  assert.equal(tokens.includes("งเทพ"), true);
  assert.equal(tokens.includes("กรุงเทพมหานคร"), true);
});

test("CJK tokenizer keeps Hangul and other alphabetic scripts as whole words", () => {
  const tokens = tokenizer.tokenize("사용자 설정 Привет мир");

  assert.equal(tokens.includes("사용자"), true);
  assert.equal(tokens.includes("설정"), true);
  assert.equal(tokens.includes("사"), false);
  assert.equal(tokens.includes("привет"), true);
  assert.equal(tokens.includes("мир"), true);
});

test("CJK tokenizer persists a versioned language marker", () => {
  assert.equal(tokenizer.language, ORAMA_CJK_TOKENIZER_LANGUAGE);
  assert.equal(typeof tokenizer.tokenize, "function");
  assert.ok(tokenizer.normalizationCache instanceof Map);
});

test("isSpaceFreeScriptChar covers CJK and Thai only", () => {
  assert.equal(isSpaceFreeScriptChar("東"), true);
  assert.equal(isSpaceFreeScriptChar("あ"), true);
  assert.equal(isSpaceFreeScriptChar("ア"), true);
  assert.equal(isSpaceFreeScriptChar("ก"), true);
  assert.equal(isSpaceFreeScriptChar("사"), false);
  assert.equal(isSpaceFreeScriptChar("a"), false);
});

test("CJK tokenizer returns no tokens for non-string input", () => {
  assert.deepEqual(tokenizer.tokenize(undefined as unknown as string), []);
  assert.deepEqual(tokenizer.tokenize(null as unknown as string), []);
  assert.deepEqual(tokenizer.tokenize(42 as unknown as string), []);
});

test("rebuild gate flags only tokenization-changing characters", () => {
  // Word material outside the stock keep-set changes tokens (whole words,
  // n-grams, attached marks) — the gate must flag it.
  assert.equal(containsNonLegacyTokenizerChars("naïve"), true);
  assert.equal(containsNonLegacyTokenizerChars("東京都庁"), true);
  assert.equal(containsNonLegacyTokenizerChars("사용자"), true);
  assert.equal(containsNonLegacyTokenizerChars("cafe\u0301"), true);
  // Separators in BOTH tokenizers — punctuation and symbols — leave the
  // stock token stream unchanged, so no re-index is warranted.
  assert.equal(containsNonLegacyTokenizerChars("plain — text „quoted” · done"), false);
  assert.equal(containsNonLegacyTokenizerChars("Nebula-472 deploy (prod)"), false);
});
