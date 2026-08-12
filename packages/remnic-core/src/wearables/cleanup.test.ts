import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanConversation,
  collapseImmediateRepeats,
  isLowQualitySegment,
  stripFillerTokens,
} from "./cleanup.js";
import type { WearableCleanupSettings, WearableConversation } from "./types.js";

const ALL_ON: WearableCleanupSettings = {
  mergeSameSpeaker: true,
  stripFillers: true,
  collapseRepeats: true,
  dropLowQuality: true,
};

function conversation(
  segments: Array<{ speakerKey: string; text: string; startIso?: string; endIso?: string }>,
): WearableConversation {
  return {
    id: "c1",
    source: "testsource",
    startIso: "2026-06-10T10:00:00Z",
    segments,
  };
}

test("stripFillerTokens removes standalone fillers but not words containing them", () => {
  assert.equal(stripFillerTokens("Um, so we should ship it"), "so we should ship it");
  assert.equal(stripFillerTokens("Grab the umbrella, uh, before noon"), "Grab the umbrella, before noon");
  assert.equal(stripFillerTokens("hmm"), "");
});

test("collapseImmediateRepeats collapses word and phrase stutters fully", () => {
  assert.equal(collapseImmediateRepeats("I I I think so"), "I think so");
  assert.equal(collapseImmediateRepeats("we should we should go"), "we should go");
  assert.equal(collapseImmediateRepeats("that's a really really really good point"), "that's a really good point");
});

test("collapseImmediateRepeats never collapses pure digit sequences", () => {
  assert.equal(collapseImmediateRepeats("call 555 555 1234 now"), "call 555 555 1234 now");
});

test("isLowQualitySegment flags garbage and keeps real speech", () => {
  assert.equal(isLowQualitySegment("aaaaaaaaaa"), true);
  assert.equal(isLowQualitySegment("%$#@! ---- ////"), true);
  assert.equal(isLowQualitySegment("yeah yeah yeah yeah yeah"), true);
  assert.equal(isLowQualitySegment("Let's review the budget tomorrow."), false);
  assert.equal(isLowQualitySegment("ok"), false);
});

test("merges consecutive same-speaker segments within the gap", () => {
  const result = cleanConversation(
    conversation([
      {
        speakerKey: "a",
        text: "First part.",
        startIso: "2026-06-10T10:00:00Z",
        endIso: "2026-06-10T10:00:05Z",
      },
      {
        speakerKey: "a",
        text: "Second part.",
        startIso: "2026-06-10T10:00:10Z",
        endIso: "2026-06-10T10:00:15Z",
      },
      { speakerKey: "b", text: "Reply.", startIso: "2026-06-10T10:00:20Z" },
    ]),
    ALL_ON,
  );
  assert.equal(result.conversation.segments.length, 2);
  assert.equal(result.conversation.segments[0].text, "First part. Second part.");
  assert.equal(result.conversation.segments[0].endIso, "2026-06-10T10:00:15Z");
  assert.equal(result.mergedSegments, 1);
});

test("does not merge across a long silence gap", () => {
  const result = cleanConversation(
    conversation([
      {
        speakerKey: "a",
        text: "Before lunch.",
        startIso: "2026-06-10T10:00:00Z",
        endIso: "2026-06-10T10:00:05Z",
      },
      {
        speakerKey: "a",
        text: "After lunch.",
        startIso: "2026-06-10T11:30:00Z",
        endIso: "2026-06-10T11:30:05Z",
      },
    ]),
    ALL_ON,
  );
  assert.equal(result.conversation.segments.length, 2);
});

test("drops low-quality segments and counts them", () => {
  const result = cleanConversation(
    conversation([
      { speakerKey: "a", text: "Real sentence about plans." },
      { speakerKey: "a", text: "zzzzzzzzz" },
    ]),
    { ...ALL_ON, mergeSameSpeaker: false },
  );
  assert.equal(result.conversation.segments.length, 1);
  assert.equal(result.droppedSegments, 1);
});

test("respects disabled passes", () => {
  const result = cleanConversation(
    conversation([
      { speakerKey: "a", text: "Um, well well well" },
      { speakerKey: "a", text: "Um, again" },
    ]),
    {
      mergeSameSpeaker: false,
      stripFillers: false,
      collapseRepeats: false,
      dropLowQuality: false,
    },
  );
  assert.equal(result.conversation.segments.length, 2);
  assert.equal(result.conversation.segments[0].text, "Um, well well well");
});

test("input conversation is not mutated", () => {
  const input = conversation([{ speakerKey: "a", text: "Um, hello there" }]);
  const before = JSON.stringify(input);
  cleanConversation(input, ALL_ON);
  assert.equal(JSON.stringify(input), before);
});


test("merges consecutive same-speaker runs across diarized speakers", () => {
  const result = cleanConversation(
    conversation([
      { speakerKey: "0", text: "Hello there.", startIso: "2026-06-10T10:00:00Z", endIso: "2026-06-10T10:00:03Z" },
      { speakerKey: "0", text: "How are you?", startIso: "2026-06-10T10:00:04Z", endIso: "2026-06-10T10:00:07Z" },
      { speakerKey: "1", text: "Good, thanks.", startIso: "2026-06-10T10:00:08Z", endIso: "2026-06-10T10:00:11Z" },
      { speakerKey: "1", text: "And you?", startIso: "2026-06-10T10:00:12Z", endIso: "2026-06-10T10:00:14Z" },
      { speakerKey: "0", text: "Busy day.", startIso: "2026-06-10T10:00:15Z", endIso: "2026-06-10T10:00:18Z" },
    ]),
    ALL_ON,
  );
  // Three runs: 0+0, 1+1, 0. Generic-label protection is off here, so
  // diarized same-speaker adjacency merges within the gap.
  assert.equal(result.conversation.segments.length, 3);
  assert.equal(result.conversation.segments[0].text, "Hello there. How are you?");
  assert.equal(result.conversation.segments[1].text, "Good, thanks. And you?");
  assert.equal(result.conversation.segments[2].text, "Busy day.");
  assert.equal(result.mergedSegments, 2);
});

test("preserveUtteranceBoundaries keeps generic-labeled utterances distinct (#1811)", () => {
  const settings: WearableCleanupSettings = { ...ALL_ON, preserveUtteranceBoundaries: true };
  const result = cleanConversation(
    conversation([
      { speakerKey: "unknown", text: "First.", startIso: "2026-06-10T10:00:00Z", endIso: "2026-06-10T10:00:02Z" },
      { speakerKey: "unknown", text: "Second.", startIso: "2026-06-10T10:00:03Z", endIso: "2026-06-10T10:00:05Z" },
      { speakerKey: "Unknown", text: "Third.", startIso: "2026-06-10T10:00:06Z", endIso: "2026-06-10T10:00:08Z" },
      { speakerKey: "0", text: "Diarized A.", startIso: "2026-06-10T10:00:09Z", endIso: "2026-06-10T10:00:11Z" },
      { speakerKey: "0", text: "Diarized B.", startIso: "2026-06-10T10:00:12Z", endIso: "2026-06-10T10:00:14Z" },
    ]),
    settings,
  );
  // Generic "unknown"/"Unknown" utterances are NOT merged into one block.
  assert.equal(result.conversation.segments.length, 4);
  assert.deepEqual(
    result.conversation.segments.map((segment) => segment.text),
    ["First.", "Second.", "Third.", "Diarized A. Diarized B."],
  );
  assert.equal(result.mergedSegments, 1);
});

test("preserveUtteranceBoundaries default (off) still collapses generic labels", () => {
  // The flag is opt-in: without it the legacy merge-everything behavior
  // is unchanged for sources that never set it.
  const result = cleanConversation(
    conversation([
      { speakerKey: "unknown", text: "First.", startIso: "2026-06-10T10:00:00Z", endIso: "2026-06-10T10:00:02Z" },
      { speakerKey: "unknown", text: "Second.", startIso: "2026-06-10T10:00:03Z", endIso: "2026-06-10T10:00:05Z" },
    ]),
    ALL_ON,
  );
  assert.equal(result.conversation.segments.length, 1);
  assert.equal(result.conversation.segments[0].text, "First. Second.");
});

test("strips Japanese filler tokens that carry no word spaces", () => {
  assert.equal(
    stripFillerTokens("えーと、明日の会議は三時です"),
    "明日の会議は三時です",
  );
  assert.equal(stripFillerTokens("あのー来週で"), "来週で");
});

test("keeps a meaning-bearing Japanese demonstrative", () => {
  assert.equal(stripFillerTokens("あの会議は長かった"), "あの会議は長かった");
});

test("strips Korean and Cyrillic filler tokens as whole tokens", () => {
  assert.equal(stripFillerTokens("음 회의는 세시입니다"), "회의는 세시입니다");
  assert.equal(stripFillerTokens("эм встреча в три"), "встреча в три");
});

test("never strips a filler lookalike inside a longer token", () => {
  assert.equal(stripFillerTokens("the umbrella is uhh wet"), "the umbrella is wet");
  // "음" also occurs inside ordinary Korean words; only the whole token goes.
  assert.equal(stripFillerTokens("다음 회의"), "다음 회의");
});

test("operator filler tokens apply to any script", () => {
  assert.equal(stripFillerTokens("bueno vamos a empezar", ["bueno"]), "vamos a empezar");
  assert.equal(stripFillerTokens("那个我们开始吧", ["那个"]), "我们开始吧");
});

test("cleanConversation strips configured filler tokens", () => {
  const result = cleanConversation(
    conversation([
      { speakerKey: "a", text: "えーと、予算を確認します" },
      { speakerKey: "b", text: "bueno, de acuerdo" },
    ]),
    ALL_ON,
    ["bueno"],
  );
  assert.deepEqual(
    result.conversation.segments.map((segment) => segment.text),
    ["予算を確認します", "de acuerdo"],
  );
});
