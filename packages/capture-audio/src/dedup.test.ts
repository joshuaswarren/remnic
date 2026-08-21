import assert from "node:assert/strict";
import test from "node:test";

import { dedupeCrossChannel, wordJaccard } from "./dedup.js";

test("wordJaccard scores word overlap ignoring case and punctuation", () => {
  assert.equal(wordJaccard("Hello there, world!", "hello there world"), 1);
  assert.equal(wordJaccard("a b c d", "a b c e"), 3 / 5);
  assert.equal(wordJaccard("totally different", "nothing shared"), 0);
  assert.equal(wordJaccard("", ""), 1);
  assert.equal(wordJaccard("words", ""), 0);
});

test("dedupeCrossChannel drops the mic copy of an overlapping near-identical system segment", () => {
  const segments = [
    { channel: "mic", text: "let us schedule the review for friday", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:04.000Z" },
    { channel: "system", text: "let us schedule the review for friday", startUtc: "2026-07-20T15:00:01.000Z", endUtc: "2026-07-20T15:00:05.000Z" },
  ];
  const kept = dedupeCrossChannel(segments);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].channel, "system");
});

test("dedupeCrossChannel keeps mic when text differs below threshold", () => {
  const segments = [
    { channel: "mic", text: "the weather is nice today outside", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:04.000Z" },
    { channel: "system", text: "quarterly revenue numbers look strong", startUtc: "2026-07-20T15:00:01.000Z", endUtc: "2026-07-20T15:00:05.000Z" },
  ];
  assert.equal(dedupeCrossChannel(segments).length, 2);
});

test("dedupeCrossChannel keeps mic when the system copy is outside the time tolerance", () => {
  const segments = [
    { channel: "mic", text: "same exact words here", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:02.000Z" },
    { channel: "system", text: "same exact words here", startUtc: "2026-07-20T15:00:30.000Z", endUtc: "2026-07-20T15:00:32.000Z" },
  ];
  assert.equal(dedupeCrossChannel(segments).length, 2);
});

test("dedupeCrossChannel never drops system segments", () => {
  const segments = [
    { channel: "system", text: "one", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" },
    { channel: "system", text: "one", startUtc: "2026-07-20T15:00:00.500Z", endUtc: "2026-07-20T15:00:01.500Z" },
  ];
  assert.equal(dedupeCrossChannel(segments).length, 2);
});
