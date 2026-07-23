import assert from "node:assert/strict";
import { test } from "node:test";

import type { ActivitySnapshot } from "../activity/types.js";
import type { FusionConversationInput } from "../wearables/fusion/types.js";
import {
  ActivityWearablesMeetingsDaySource,
  buildAudioWindows,
  deriveAppSpans,
  type MeetingsActivityReader,
  type MeetingsWearableReader,
} from "./day-source.js";
import { MeetingsInputError } from "./errors.js";
import { detectMeetings } from "./detect.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import type { MeetingsConfig } from "./types.js";

const DATE = "2026-03-10";

function config(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return {
    ...DEFAULT_MEETINGS_CONFIG,
    appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns],
    enabled: true,
    ...overrides,
  };
}

function snap(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    machine: "workstation-a",
    capturedAtUtc: "2026-03-10T14:00:00.000Z",
    app: "Chrome",
    windowTitle: "",
    text: "",
    textSource: "ax",
    contentHash: Math.random().toString(36).slice(2),
    ...overrides,
  };
}

function conv(overrides: Partial<FusionConversationInput> = {}): FusionConversationInput {
  return {
    source: "desktop",
    conversationId: "c1",
    startIso: "2026-03-10T14:00:00.000Z",
    segments: [],
    ...overrides,
  };
}

test("deriveAppSpans groups consecutive matching snapshots and breaks on a non-match", () => {
  const spans = deriveAppSpans(
    [
      snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:00:00.000Z" }),
      snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:01:00.000Z" }),
      snap({ app: "Notes", capturedAtUtc: "2026-03-10T14:02:00.000Z" }), // breaks the run
      snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:03:00.000Z" }),
    ],
    config().appPatterns,
  );
  assert.equal(spans.length, 2, "the non-matching snapshot splits the run into two spans");
  assert.deepEqual(spans[0], { app: "Zoom", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:02:00.000Z" }, "the run ends at the next (non-matching) snapshot that bounds it");
  assert.deepEqual(spans[1], { app: "Zoom", startUtc: "2026-03-10T14:03:00.000Z", endUtc: "2026-03-10T14:04:00.000Z" }, "a lone trailing run gets a finite end at the machine's cadence, not a zero-length point");
});

test("deriveAppSpans matches a meeting URL in the browser url, not just the app name", () => {
  const spans = deriveAppSpans(
    [
      snap({ app: "Chrome", browserUrl: "https://meet.google.com/abc-defg-hij", capturedAtUtc: "2026-03-10T09:00:00.000Z" }),
      snap({ app: "Chrome", browserUrl: "https://meet.google.com/abc-defg-hij", capturedAtUtc: "2026-03-10T09:05:00.000Z" }),
    ],
    config().appPatterns,
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.startUtc, "2026-03-10T09:00:00.000Z");
  assert.equal(spans[0]?.endUtc, "2026-03-10T09:05:00.000Z");
});

test("deriveAppSpans returns nothing when there are no patterns", () => {
  assert.deepEqual(deriveAppSpans([snap({ app: "Zoom" })], []), []);
});

test("buildAudioWindows counts distinct non-wearer speakers and derives the end", () => {
  const windows = buildAudioWindows([
    conv({
      source: "limitless",
      startIso: "2026-03-10T09:00:00.000Z",
      segments: [
        { speaker: "Me (you)", isSelf: true, text: "hi", startIso: "2026-03-10T09:00:00.000Z" },
        { speaker: "Jane", isSelf: false, text: "hello", startIso: "2026-03-10T09:01:00.000Z", endIso: "2026-03-10T09:01:30.000Z" },
        { speaker: "Bob", isSelf: false, text: "hey", startIso: "2026-03-10T09:02:00.000Z" },
        { speaker: "Jane", isSelf: false, text: "again", startIso: "2026-03-10T09:03:00.000Z" },
      ],
    }),
  ]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.source, "limitless");
  assert.equal(windows[0]?.distinctNonWearerSpeakers, 2, "Jane + Bob, deduped; the wearer excluded");
  assert.equal(windows[0]?.startUtc, "2026-03-10T09:00:00.000Z");
  assert.equal(windows[0]?.endUtc, "2026-03-10T09:03:00.000Z", "latest segment instant when no conversation endIso");
});

test("buildAudioWindows prefers an explicit conversation endIso", () => {
  const windows = buildAudioWindows([
    conv({ startIso: "2026-03-10T09:00:00.000Z", endIso: "2026-03-10T10:00:00.000Z", segments: [] }),
  ]);
  assert.equal(windows[0]?.endUtc, "2026-03-10T10:00:00.000Z");
  assert.equal(windows[0]?.distinctNonWearerSpeakers, 0);
});

test("loadDayData assembles detection + activity for the requested day, keyed to that day", async () => {
  const activity: MeetingsActivityReader = {
    listSnapshotsForDay: (_machine, startUtc, endUtc) => {
      assert.ok(startUtc < endUtc, "half-open UTC window");
      return [
        snap({ app: "Zoom", windowTitle: "Standup", capturedAtUtc: "2026-03-10T14:00:00.000Z" }),
        snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:05:00.000Z" }),
      ];
    },
  };
  const wearables: MeetingsWearableReader = { readDayBodies: async () => [] };
  const source = new ActivityWearablesMeetingsDaySource({ activity, wearables, config: config(), timezone: "UTC" });
  const data = await source.loadDayData(DATE);
  assert.equal(data.detection.date, DATE, "detection is keyed to the requested day (builder asserts this)");
  assert.equal(data.detection.appSpans.length, 1);
  assert.equal(data.detection.appSpans[0]?.app, "Zoom");
  assert.deepEqual(data.detection.audioWindows, [], "no wearable transcripts → no audio windows");
  assert.equal(data.activity?.length, 2);
  assert.equal(data.activity?.[0]?.title, "Standup");
  assert.equal(data.conversations.length, 0);
});

test("loadDayData rejects a malformed day with a clean input error", async () => {
  const source = new ActivityWearablesMeetingsDaySource({
    activity: { listSnapshotsForDay: () => [] },
    wearables: { readDayBodies: async () => [] },
    config: config(),
    timezone: "UTC",
  });
  await assert.rejects(() => Promise.resolve(source.loadDayData("2026-13-40")), MeetingsInputError);
});

test("deriveAppSpans gives a lone matching snapshot a non-zero span so app+audio detection is not missed (issue #1900)", () => {
  const spans = deriveAppSpans(
    [
      snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:00:00.000Z" }), // single match
      snap({ app: "Notes", capturedAtUtc: "2026-03-10T14:30:00.000Z" }), // ends + bounds it
    ],
    config().appPatterns,
  );
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], { app: "Zoom", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:30:00.000Z" });
  assert.ok(
    Date.parse(spans[0]!.endUtc) > Date.parse(spans[0]!.startUtc),
    "the span is non-zero-length, so detect's isFinitePair keeps it",
  );
  // With a real span the overlapping audio window now classifies as app+audio;
  // the old zero-length span was dropped and this returned nothing.
  const detected = detectMeetings({
    date: DATE,
    appSpans: spans,
    audioWindows: [
      { source: "desktop", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:30:00.000Z", distinctNonWearerSpeakers: 1 },
    ],
  });
  assert.equal(detected.length, 1);
  assert.equal(detected[0]?.detectionSource, "app+audio");
});

test("deriveAppSpans derives runs per capture machine so another machine cannot split a call (issue #1900)", () => {
  // Laptop is in Zoom continuously; a desktop ticks Chrome (non-match) in between.
  const spans = deriveAppSpans(
    [
      snap({ machine: "laptop", app: "Zoom", capturedAtUtc: "2026-03-10T14:00:00.000Z" }),
      snap({ machine: "desktop", app: "Chrome", capturedAtUtc: "2026-03-10T14:01:00.000Z" }),
      snap({ machine: "laptop", app: "Zoom", capturedAtUtc: "2026-03-10T14:02:00.000Z" }),
      snap({ machine: "desktop", app: "Chrome", capturedAtUtc: "2026-03-10T14:03:00.000Z" }),
      snap({ machine: "laptop", app: "Zoom", capturedAtUtc: "2026-03-10T14:04:00.000Z" }),
    ],
    config().appPatterns,
  );
  assert.equal(spans.length, 1, "the desktop's Chrome ticks must not fragment the laptop's Zoom run");
  assert.deepEqual(spans[0], { app: "Zoom", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:04:00.000Z" });
});

test("loadDayData converts the transcript timezone so audio lines up with UTC screen snapshots (issue #1900)", async () => {
  const body = [
    "# desktop transcript — 2026-03-10",
    "",
    "## 09:00–09:30 · Standup (conversation c1)",
    "",
    "**Me (you)** [09:00]: morning",
    "**Jane** [09:05]: hi",
    "**Bob** [09:10]: hey",
    "",
  ].join("\n");
  const activity: MeetingsActivityReader = {
    listSnapshotsForDay: () => [
      snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:00:00.000Z" }),
      snap({ app: "Notes", capturedAtUtc: "2026-03-10T14:35:00.000Z" }),
    ],
  };
  const wearables: MeetingsWearableReader = {
    readDayBodies: async () => [{ source: "desktop", body, timezone: "America/Chicago" }],
  };
  const source = new ActivityWearablesMeetingsDaySource({
    activity,
    wearables,
    config: config(),
    timezone: "America/Chicago",
  });
  const data = await source.loadDayData(DATE);
  // 09:00 America/Chicago (CDT) is 14:00Z, not 09:00Z: the window now overlaps
  // the 14:00Z Zoom snapshot; before the fix it drifted to 09:00Z and missed it.
  assert.equal(data.detection.audioWindows.length, 1);
  assert.equal(data.detection.audioWindows[0]?.startUtc, "2026-03-10T14:00:00.000Z");
  assert.equal(data.detection.audioWindows[0]?.endUtc, "2026-03-10T14:30:00.000Z");
  assert.equal(data.conversations[0]?.startIso, "2026-03-10T14:00:00.000Z");
  const detected = detectMeetings(data.detection);
  assert.equal(detected.length, 1);
  assert.equal(detected[0]?.detectionSource, "app+audio");
});

test("deriveAppSpans gives a LONE TRAILING matching snapshot a finite span so end-of-window app+audio is not missed (issue #1900)", () => {
  // A single Zoom tick at the end of the machine's snapshots, with NO later
  // non-matching tick to bound it. Before the fix this pushed endUtc==startUtc,
  // a zero-length point detect's isFinitePair dropped — so overlapping audio
  // never paired and no meeting surfaced.
  const spans = deriveAppSpans(
    [snap({ app: "Zoom", capturedAtUtc: "2026-03-10T14:00:00.000Z" })],
    config().appPatterns,
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.startUtc, "2026-03-10T14:00:00.000Z");
  assert.ok(
    Date.parse(spans[0]!.endUtc) > Date.parse(spans[0]!.startUtc),
    "the trailing run gets a non-zero end so detect's isFinitePair keeps it",
  );
  const detected = detectMeetings(
    {
      date: DATE,
      appSpans: spans,
      audioWindows: [
        { source: "desktop", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:30:00.000Z", distinctNonWearerSpeakers: 1 },
      ],
    },
    config(),
  );
  assert.equal(detected.length, 1, "the finite trailing span now pairs with the overlapping audio window");
  assert.equal(detected[0]?.detectionSource, "app+audio");
});

test("buildAudioWindows marks provider sources + carries the title so a titled provider conversation with no app span is detected (issue #1900)", () => {
  const windows = buildAudioWindows([
    conv({
      source: "granola",
      conversationId: "g1",
      title: "Weekly sync",
      startIso: "2026-03-10T16:00:00.000Z",
      endIso: "2026-03-10T16:30:00.000Z",
      segments: [{ speaker: "Jane", isSelf: false, text: "hi", startIso: "2026-03-10T16:05:00.000Z" }],
    }),
  ]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.providerMeeting, true, "a known provider source is marked so detect's provider branch fires");
  assert.equal(windows[0]?.title, "Weekly sync", "the provider-supplied title is carried onto the window");
  // No app spans and only one non-wearer speaker: the provider branch is the
  // ONLY path to a meeting. Before the fix the window carried neither
  // providerMeeting nor title, so nothing was detected.
  const detected = detectMeetings({ date: DATE, appSpans: [], audioWindows: windows });
  assert.equal(detected.length, 1);
  assert.equal(detected[0]?.detectionSource, "provider");
  assert.equal(detected[0]?.title, "Weekly sync");
});
