import assert from "node:assert/strict";
import { test } from "node:test";

import { hammingDistance, simhash, simhashFromHex, simhashToHex } from "./simhash.js";

const BASE = "the quick brown fox jumps over the lazy dog near the river bank this morning while reading email";
const ONE_WORD = "the quick brown cat jumps over the lazy dog near the river bank this morning while reading email";
const UNRELATED = "database index scans dominate the query planner cost model when statistics are stale and skewed heavily";

test("identical text has SimHash distance 0", () => {
  assert.equal(hammingDistance(simhash(BASE), simhash(BASE)), 0);
});

test("empty/whitespace text has an all-zero fingerprint", () => {
  assert.equal(simhash(""), 0n);
  assert.equal(simhash("   \n\t"), 0n);
});

test("a one-word change is a small distance; unrelated text is large", () => {
  const base = simhash(BASE);
  const oneWord = hammingDistance(base, simhash(ONE_WORD));
  const unrelated = hammingDistance(base, simhash(UNRELATED));
  assert.ok(oneWord > 0, "a real edit must move the fingerprint");
  assert.ok(oneWord < 15, `one-word edit should be small, got ${oneWord}`);
  assert.ok(unrelated > 20, `unrelated text should be large, got ${unrelated}`);
  assert.ok(oneWord < unrelated, "one-word edit must be closer than unrelated text");
});

test("hex rendering is fixed 16-char and round-trips", () => {
  const h = simhash(BASE);
  const hex = simhashToHex(h);
  assert.equal(hex.length, 16);
  assert.match(hex, /^[0-9a-f]{16}$/);
  assert.equal(simhashFromHex(hex), h);
  assert.equal(simhashToHex(0n), "0000000000000000");
});

test("non-ASCII text tokenizes so distinct CJK/Cyrillic captures are not false-deduped", () => {
  const a = simhash("日本語 の テキスト ウィンドウ 会議 メモ 予定");
  const b = simhash("完全 に 異なる 内容 プログラム 出力 結果");
  const cyr = simhash("привет мир это окно с текстом сегодня утром");
  assert.notEqual(a, 0n, "non-ASCII text must not collapse to an empty fingerprint");
  assert.notEqual(b, 0n);
  assert.notEqual(cyr, 0n);
  assert.ok(hammingDistance(a, b) > 0, "different CJK text must differ");
  assert.ok(hammingDistance(a, cyr) > 0);
});
