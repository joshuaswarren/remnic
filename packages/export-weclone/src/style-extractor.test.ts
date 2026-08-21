import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractStyleMarkers } from "./style-extractor.js";

describe("extractStyleMarkers", () => {
  it("detects emoji usage", () => {
    const samples = [
      "I love coffee! Best thing ever.",
      "Going to the park today, so excited!",
    ];
    const noEmoji = extractStyleMarkers(samples);
    assert.equal(noEmoji.usesEmoji, false);

    const withEmoji = extractStyleMarkers([
      "Love this place! \u{1F60D}",
      "Great day \u{2728}\u{1F389}",
    ]);
    assert.equal(withEmoji.usesEmoji, true);
  });

  it("detects formal tone", () => {
    const samples = [
      "I would like to express my appreciation for the opportunity.",
      "Furthermore, the documentation should be reviewed thoroughly.",
      "Please consider the following recommendations.",
    ];
    const markers = extractStyleMarkers(samples);
    assert.equal(markers.formality, "formal");
  });

  it("detects casual tone", () => {
    const samples = [
      "yeah i dunno, it's kinda cool tho",
      "lol that's awesome, can't wait",
      "gonna grab some food, wanna come?",
    ];
    const markers = extractStyleMarkers(samples);
    assert.equal(markers.formality, "casual");
  });

  it("calculates average sentence length", () => {
    // 3 words per sentence, 2 sentences
    const samples = ["Hello my friend. Goodbye for now."];
    const markers = extractStyleMarkers(samples);

    // "Hello my friend" = 3, "Goodbye for now" = 3, avg = 3
    assert.ok(
      markers.avgSentenceLength >= 2 && markers.avgSentenceLength <= 4,
      `expected avg ~3, got ${markers.avgSentenceLength}`,
    );
  });

  it("detects lowercase preference", () => {
    const samples = [
      "i like to keep things simple. no need for capitals.",
      "that's just how i write. works for me.",
    ];
    const markers = extractStyleMarkers(samples);
    assert.equal(markers.usesLowercase, true);

    const upperSamples = [
      "This is a properly capitalized sentence. It follows the rules.",
      "Another well-formed sentence. Grammar is important.",
    ];
    const upperMarkers = extractStyleMarkers(upperSamples);
    assert.equal(upperMarkers.usesLowercase, false);
  });

  it("handles empty samples array", () => {
    const markers = extractStyleMarkers([]);

    assert.equal(markers.avgSentenceLength, 0);
    assert.equal(markers.usesEmoji, false);
    assert.equal(markers.formality, "mixed");
    assert.equal(markers.usesLowercase, false);
    assert.deepEqual(markers.commonPhrases, []);
  });

  it("finds common phrases across samples", () => {
    const samples = [
      "I really think this is great. I really enjoy it.",
      "I really believe in this approach.",
      "We should try something new. I really want to.",
    ];
    const markers = extractStyleMarkers(samples);

    // "I really" should appear as a common phrase
    assert.ok(
      markers.commonPhrases.some((p) => p.toLowerCase().includes("i really")),
      `expected "i really" in common phrases, got: ${JSON.stringify(markers.commonPhrases)}`,
    );
  });

  it("returns mixed formality for neutral text", () => {
    const samples = [
      "The weather is nice today.",
      "I went to the store.",
    ];
    const markers = extractStyleMarkers(samples);
    assert.equal(markers.formality, "mixed");
  });

  it("does not false-positive 'tho' inside 'those' or 'method'", () => {
    const samples = [
      "Those methods are well documented.",
      "The author thoroughly reviewed the code.",
    ];
    const markers = extractStyleMarkers(samples);
    // "those", "method", "author", "thoroughly" should not trigger casual markers
    assert.equal(markers.formality, "mixed");
  });

  it("does not false-positive 'bro' inside 'broken' or 'broadly'", () => {
    const samples = [
      "The broken pipe was broadly reported across servers.",
      "Browsing through the documentation revealed the issue.",
    ];
    const markers = extractStyleMarkers(samples);
    assert.equal(markers.formality, "mixed");
  });

  it("punctuation-strip regex does not ReDoS on pathological input", () => {
    // 1000 forward slashes should complete well under 100ms
    const pathological = "/".repeat(1000);
    const samples = [pathological, pathological, pathological];
    const start = Date.now();
    const markers = extractStyleMarkers(samples);
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 100,
      `expected < 100ms, took ${elapsed}ms (possible ReDoS)`,
    );
    assert.deepEqual(markers.commonPhrases, []);
  });

  it("still detects standalone casual markers with word boundaries", () => {
    // "tho" and "bro" as standalone words should still count
    const samples = [
      "i know tho, it's kind of a thing bro",
      "yeah tho that's what i was saying",
    ];
    const markers = extractStyleMarkers(samples);
    assert.equal(markers.formality, "casual");
  });
});
