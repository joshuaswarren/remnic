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
  assert.deepEqual(spans[0], { app: "Zoom", startUtc: "2026-03-10T14:00:00.000Z", endUtc: "2026-03-10T14:01:00.000Z" });
  assert.deepEqual(spans[1], { app: "Zoom", startUtc: "2026-03-10T14:03:00.000Z", endUtc: "2026-03-10T14:03:00.000Z" });
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
