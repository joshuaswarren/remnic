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
