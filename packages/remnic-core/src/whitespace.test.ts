import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseWhitespace,
  displayWidth,
  graphemeUnits,
  padEndDisplay,
  truncateCodePointSafe,
  truncateGraphemeSafe,
} from "./whitespace.js";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

function isGraphemePrefix(prefix: string, value: string): boolean {
  let accumulated = "";
  for (const unit of graphemeUnits(value)) {
    if (accumulated === prefix) return true;
    accumulated += unit;
  }
  return accumulated === prefix;
}

// Deterministic pseudo-random source so failures replay exactly.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// Every entry is one or more whole grapheme clusters covering the cases named
// in issue #2195: astral emoji, ZWJ sequences, skin-tone modifiers,
// regional-indicator flags, Hangul (precomposed and jamo), combining marks,
// and astral kanji.
const GRAPHEME_PIECES = [
  "a",
  "b",
  " ",
  "7",
  "😀",
  "👨‍👩‍👧‍👦",
  "👍🏽",
  "🇯🇵",
  "🇺🇸",
  "🇰🇷",
  "한",
  "한",
  "e\u0301",
  "k\u0331\u0301",
  "क़",
  "𠮷",
  "日",
  "本",
  "語",
] as const;

test("truncateGraphemeSafe: property - valid Unicode, grapheme-aligned, within budget", () => {
  const random = lcg(20260816);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    let input = "";
    const pieceCount = 1 + Math.floor(random() * 12);
    for (let piece = 0; piece < pieceCount; piece += 1) {
      input += GRAPHEME_PIECES[Math.floor(random() * GRAPHEME_PIECES.length)]!;
    }
    const maxChars = Math.floor(random() * (input.length + 2));
    const output = truncateGraphemeSafe(input, maxChars);
    assert.ok(
      output.length <= maxChars,
      `budget exceeded for ${JSON.stringify(input)} @ ${maxChars}: ${JSON.stringify(output)}`,
    );
    assert.ok(
      !hasLoneSurrogate(output),
      `lone surrogate for ${JSON.stringify(input)} @ ${maxChars}: ${JSON.stringify(output)}`,
    );
    assert.ok(
      isGraphemePrefix(output, input),
      `split grapheme for ${JSON.stringify(input)} @ ${maxChars}: ${JSON.stringify(output)}`,
    );
    if (input.length <= maxChars) {
      assert.equal(output, input, `fits must pass through @ ${maxChars}`);
    }
  }
});

test("truncateGraphemeSafe: emoji, ZWJ, flags, jamo, and combining marks stay whole", () => {
  assert.equal(truncateGraphemeSafe("hello world", 5), "hello");
  assert.equal(truncateGraphemeSafe("hello", 50), "hello");
  assert.equal(truncateGraphemeSafe("hello", 0), "");
  assert.equal(truncateGraphemeSafe("👍👍", 2), "👍");
  assert.equal(truncateGraphemeSafe("👍", 1), "", "a split emoji is dropped, never half-cut");
  assert.equal(truncateGraphemeSafe("a👍b", 2), "a");
  assert.equal(truncateGraphemeSafe("🇯🇵🇺🇸", 4), "🇯🇵");
  assert.equal(truncateGraphemeSafe("🇯🇵🇺🇸", 3), "", "a split flag is dropped, never half-cut");
  const family = "👨‍👩‍👧‍👦";
  assert.equal(truncateGraphemeSafe(`${family}!`, family.length + 1), `${family}!`);
  assert.equal(truncateGraphemeSafe(`${family}!`, family.length), family);
  assert.equal(truncateGraphemeSafe(family, family.length - 1), "", "ZWJ sequence is atomic");
  assert.equal(truncateGraphemeSafe("한글", 3), "한", "jamo run is one cluster");
  assert.equal(truncateGraphemeSafe("e\u0301x", 2), "e\u0301", "base plus mark is one cluster");
  assert.equal(truncateGraphemeSafe("e\u0301x", 1), "");
});

test("truncateCodePointSafe and collapseWhitespace keep prior behavior", () => {
  assert.equal(collapseWhitespace(" a \n b "), "a b");
  assert.equal(truncateCodePointSafe("abcd", 2), "ab");
  assert.equal(truncateCodePointSafe("ab", 9), "ab");
  assert.equal(truncateCodePointSafe("abc", 0), "");
});

test("displayWidth: CJK wide, fullwidth, halfwidth, marks, and emoji", () => {
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("ハングル"), 8);
  assert.equal(displayWidth("한국어"), 6);
  assert.equal(displayWidth("ｱ"), 1, "halfwidth katakana is narrow");
  assert.equal(displayWidth("ｆｕｌｌ"), 8, "fullwidth ASCII is wide");
  assert.equal(displayWidth("e\u0301"), 1, "combining mark is zero width");
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("中日 memo"), 9, "2+2+1+4");
});

test("displayWidth: emoji sequences measure as one two-cell grapheme", () => {
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2, "ZWJ family emoji is one cluster");
  assert.equal(displayWidth("🇯🇵"), 2, "regional-indicator flag is one cluster");
  assert.equal(displayWidth("👍🏽"), 2, "skin-tone modifier joins the cluster");
  assert.equal(displayWidth("❤️"), 2, "VS16 requests emoji presentation");
  assert.equal(displayWidth("1️⃣"), 2, "keycap sequence is one cluster");
  assert.equal(displayWidth("👨‍👩‍👧‍👦 文"), 5, "clusters compose: 2 + 1 + 2");
  assert.equal(
    padEndDisplay("👨‍👩‍👧‍👦", 6),
    "👨‍👩‍👧‍👦" + " ".repeat(4),
    "emoji rows pad by display width, not code units",
  );
});

test("padEndDisplay: CJK rows align to one computed width", () => {
  assert.equal(padEndDisplay("abc", 6), "abc   ");
  assert.equal(padEndDisplay("abc", 2), "abc", "narrow target never truncates");
  assert.equal(padEndDisplay("日本", 10), "日本" + " ".repeat(6));
  const rows = ["機械学習", "nlp", "한국어", "x"];
  const padded = rows.map((row) => padEndDisplay(row, 12));
  for (const row of padded) {
    assert.equal(displayWidth(row), 12);
  }
  assert.deepEqual(padded, [
    "機械学習    ",
    "nlp         ",
    "한국어      ",
    "x           ",
  ]);
  // Snapshot-style: the CLI topics table shape keeps its score column aligned
  // for CJK rows, which plain padEnd misaligns.
  const table = rows.slice(0, 3).map((term) => `  ${padEndDisplay(term, 12)} 0.123`);
  assert.deepEqual(table, [
    "  機械学習     0.123",
    "  nlp          0.123",
    "  한국어       0.123",
  ]);
  const tableWidth = displayWidth(table[0]!);
  assert.ok(table.every((line) => displayWidth(line) === tableWidth));
});
