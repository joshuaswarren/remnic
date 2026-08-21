import assert from "node:assert/strict";
import test from "node:test";

import { countRecallTokenOverlap, normalizeRecallTokens } from "../src/recall-tokenization.js";

test("normalizeRecallTokens preserves non-Latin word tokens", () => {
  const tokens = normalizeRecallTokens("Привет, мир! Καλημέρα κόσμε. שלום לצוות. مرحبا بالعالم.");

  assert.equal(tokens.includes("привет"), true);
  assert.equal(tokens.includes("καλημέρα"), true);
  assert.equal(tokens.includes("שלום"), true);
  assert.equal(tokens.includes("مرحبا"), true);
});

test("normalizeRecallTokens preserves combining-mark words", () => {
  const tokens = normalizeRecallTokens("हिंदी สวัสดี தமிழ் සිංහල");

  assert.equal(tokens.includes("हिंदी"), true);
  assert.equal(tokens.includes("สวัสดี"), true);
  assert.equal(tokens.includes("தமிழ்"), true);
  assert.equal(tokens.includes("සිංහල"), true);
});

test("normalizeRecallTokens keeps Hangul words intact", () => {
  const tokens = normalizeRecallTokens("사용자 설정");

  assert.equal(tokens.includes("사용자"), true);
  assert.equal(tokens.includes("설정"), true);
  assert.equal(tokens.includes("사"), false);
  assert.equal(tokens.includes("설"), false);
});

test("normalizeRecallTokens keeps CJK no-whitespace phrases searchable", () => {
  const tokens = normalizeRecallTokens("用户喜欢深色模式");

  assert.equal(tokens.includes("用"), true);
  assert.equal(tokens.includes("户"), true);
  assert.equal(tokens.includes("用户"), true);
  assert.equal(tokens.includes("喜欢深"), true);
  assert.equal(tokens.includes("深"), true);
  assert.equal(tokens.includes("色"), true);
  assert.equal(tokens.includes("用户喜欢深色模式"), true);
});

test("normalizeRecallTokens keeps Japanese long-vowel marks in Katakana runs", () => {
  const tokens = normalizeRecallTokens("メールサーバー");

  assert.equal(tokens.includes("メール"), true);
  assert.equal(tokens.includes("サーバー"), true);
  assert.equal(tokens.includes("メールサーバー"), true);
});

test("normalizeRecallTokens preserves decomposed Kana combining marks", () => {
  const decomposed = "パス";
  const composed = "パス";
  const tokens = normalizeRecallTokens(decomposed);

  assert.equal(tokens.includes(composed), true);
  assert.ok(countRecallTokenOverlap(new Set(normalizeRecallTokens(composed)), decomposed) >= 2);
});

test("normalizeRecallTokens preserves non-CJK segments inside mixed CJK tokens", () => {
  const tokens = normalizeRecallTokens("用户api喜欢oauth登录");

  assert.equal(tokens.includes("api"), true);
  assert.equal(tokens.includes("oauth"), true);
  assert.equal(tokens.includes("a"), false);
  assert.equal(tokens.includes("o"), false);
  assert.equal(tokens.includes("用"), true);
  assert.equal(tokens.includes("户"), true);
});

test("countRecallTokenOverlap matches multilingual recall text", () => {
  const queryTokens = new Set(normalizeRecallTokens("привет καλημέρα שלום مرحبا 用户喜欢深色模式"));

  assert.ok(countRecallTokenOverlap(queryTokens, "Привет мир") > 0);
  assert.ok(countRecallTokenOverlap(queryTokens, "μια Καλημέρα για την ομάδα") > 0);
  assert.ok(countRecallTokenOverlap(queryTokens, "שלום לצוות") > 0);
  assert.ok(countRecallTokenOverlap(queryTokens, "مرحبا بالفريق") > 0);
  assert.ok(countRecallTokenOverlap(queryTokens, "用户偏好深色模式") >= 4);
});
