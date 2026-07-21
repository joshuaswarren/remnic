import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MEETINGS_DETECTION_CONFIG, detectMeetings, meetingId } from "./detect.js";
import type { MeetingAppSpan, MeetingAudioWindow, MeetingsDetectionInput } from "./types.js";

const DATE = "2026-03-10";

function span(app: string, startUtc: string, endUtc: string): MeetingAppSpan {
  return { app, startUtc, endUtc };
}

function audio(overrides: Partial<MeetingAudioWindow> & { startUtc: string; endUtc: string }): MeetingAudioWindow {
  return { source: "desktop", distinctNonWearerSpeakers: 2, ...overrides };
}

function input(overrides: Partial<MeetingsDetectionInput> = {}): MeetingsDetectionInput {
  return { date: DATE, appSpans: [], audioWindows: [], ...overrides };
}

test("app+audio: an app span overlapping a conversation yields one meeting", () => {
  const meetings = detectMeetings(
    input({
      appSpans: [span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T15:00:00.000Z")],
      audioWindows: [audio({ source: "desktop", startUtc: "2026-03-10T14:01:00.000Z", endUtc: "2026-03-10T14:55:00.000Z" })],
    }),
  );
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0]?.detectionSource, "app+audio");
  assert.equal(meetings[0]?.app, "Zoom");
  assert.deepEqual(meetings[0]?.sources, ["desktop"]);
});

test("activity only (app span, zero audio) → NO meeting (watching a recording)", () => {
  const meetings = detectMeetings(
    input({ appSpans: [span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T15:00:00.000Z")] }),
  );
  assert.equal(meetings.length, 0);
});

test("audio only: a long multi-speaker conversation with no app span is a meeting", () => {
  const meetings = detectMeetings(
    input({
      audioWindows: [
        audio({ source: "limitless", startUtc: "2026-03-10T09:00:00.000Z", endUtc: "2026-03-10T09:20:00.000Z", distinctNonWearerSpeakers: 3 }),
      ],
    }),
  );
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0]?.detectionSource, "audio");
  assert.equal(meetings[0]?.app, undefined);
});

test("audio only: too short OR too few speakers is NOT a meeting", () => {
  const short = detectMeetings(
    input({ audioWindows: [audio({ startUtc: "2026-03-10T09:00:00.000Z", endUtc: "2026-03-10T09:05:00.000Z", distinctNonWearerSpeakers: 3 })] }),
  );
  assert.equal(short.length, 0);
  const solo = detectMeetings(
    input({ audioWindows: [audio({ startUtc: "2026-03-10T09:00:00.000Z", endUtc: "2026-03-10T09:30:00.000Z", distinctNonWearerSpeakers: 1 })] }),
  );
  assert.equal(solo.length, 0);
});

test("provider meeting is detected from its own boundaries without an app span", () => {
  const meetings = detectMeetings(
    input({
      audioWindows: [
        audio({ source: "granola", startUtc: "2026-03-10T16:00:00.000Z", endUtc: "2026-03-10T16:30:00.000Z", providerMeeting: true, title: "Roadmap", distinctNonWearerSpeakers: 0 }),
      ],
    }),
  );
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0]?.detectionSource, "provider");
  assert.equal(meetings[0]?.title, "Roadmap");
});

test("rejoin within the merge gap collapses into ONE meeting; a 10-min gap stays TWO", () => {
  const rejoin = detectMeetings(
    input({
      appSpans: [
        span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T14:20:00.000Z"),
        span("Zoom", "2026-03-10T14:21:00.000Z", "2026-03-10T14:40:00.000Z"),
      ],
      audioWindows: [
        audio({ startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:19:00.000Z" }),
        audio({ startUtc: "2026-03-10T14:20:30.000Z", endUtc: "2026-03-10T14:39:00.000Z" }),
      ],
    }),
  );
  assert.equal(rejoin.length, 1);

  const twoMeetings = detectMeetings(
    input({
      appSpans: [
        span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T14:20:00.000Z"),
        span("Zoom", "2026-03-10T14:30:00.000Z", "2026-03-10T14:50:00.000Z"),
      ],
      audioWindows: [
        audio({ startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:19:00.000Z" }),
        audio({ startUtc: "2026-03-10T14:30:00.000Z", endUtc: "2026-03-10T14:49:00.000Z" }),
      ],
    }),
  );
  assert.equal(twoMeetings.length, 2);
});

test("multiple audio sources over the same window fuse into one meeting with both sources", () => {
  const meetings = detectMeetings(
    input({
      appSpans: [span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T15:00:00.000Z")],
      audioWindows: [
        audio({ source: "desktop", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:55:00.000Z" }),
        audio({ source: "limitless", startUtc: "2026-03-10T14:02:00.000Z", endUtc: "2026-03-10T14:58:00.000Z" }),
      ],
    }),
  );
  assert.equal(meetings.length, 1);
  assert.deepEqual(meetings[0]?.sources, ["desktop", "limitless"]);
});

test("detected meetings never overlap after merge", () => {
  const meetings = detectMeetings(
    input({
      appSpans: [span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T15:30:00.000Z")],
      audioWindows: [
        audio({ startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:40:00.000Z" }),
        audio({ startUtc: "2026-03-10T14:30:00.000Z", endUtc: "2026-03-10T15:10:00.000Z" }),
      ],
    }),
  );
  for (let i = 1; i < meetings.length; i++) {
    assert.ok((meetings[i - 1]?.endUtc ?? "") <= (meetings[i]?.startUtc ?? ""), "meetings must not overlap");
  }
});

test("sub-threshold overlap does not pair an app span with a conversation", () => {
  // Only 1 minute of overlap; minOverlapMinutes default is 2 → audio-only rules apply.
  const meetings = detectMeetings(
    input({
      appSpans: [span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T14:10:00.000Z")],
      audioWindows: [audio({ startUtc: "2026-03-10T14:09:00.000Z", endUtc: "2026-03-10T14:16:00.000Z", distinctNonWearerSpeakers: 2 })],
    }),
  );
  // 7-min conversation < 15-min audio-only floor and no qualifying app overlap → no meeting.
  assert.equal(meetings.length, 0);
});

test("ids are stable across a re-run with 10% more fixture data appended", () => {
  const base = input({
    appSpans: [span("Zoom", "2026-03-10T14:00:00.000Z", "2026-03-10T15:00:00.000Z")],
    audioWindows: [audio({ startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:55:00.000Z" })],
  });
  const first = detectMeetings(base);
  // Re-run with an extra, later meeting appended (more data, same early meeting).
  const more = detectMeetings(
    input({
      appSpans: [...base.appSpans, span("Zoom", "2026-03-10T17:00:00.000Z", "2026-03-10T17:30:00.000Z")],
      audioWindows: [...base.audioWindows, audio({ startUtc: "2026-03-10T17:01:00.000Z", endUtc: "2026-03-10T17:28:00.000Z" })],
    }),
  );
  const firstId = first[0]?.id;
  const sameId = more.find((m) => m.startUtc === first[0]?.startUtc)?.id;
  assert.ok(firstId);
  assert.equal(sameId, firstId, "the earlier meeting keeps its id when later data is added");
});

test("meetingId is deterministic and rounds the start to the minute", () => {
  const a = meetingId(DATE, "2026-03-10T14:00:05.000Z", "Zoom");
  const b = meetingId(DATE, "2026-03-10T14:00:59.000Z", "Zoom");
  assert.equal(a, b); // same minute → same id
  assert.match(a, /^mtg-2026-03-10-[0-9a-f]{8}$/);
  assert.notEqual(a, meetingId(DATE, "2026-03-10T14:01:00.000Z", "Zoom"));
});

test("default config matches the issue-specified thresholds", () => {
  assert.equal(DEFAULT_MEETINGS_DETECTION_CONFIG.minOverlapMinutes, 2);
  assert.equal(DEFAULT_MEETINGS_DETECTION_CONFIG.audioOnlyMinMinutes, 15);
  assert.equal(DEFAULT_MEETINGS_DETECTION_CONFIG.mergeGapMinutes, 2);
});
