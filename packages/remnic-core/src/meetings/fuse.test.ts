import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import { fuseMeeting } from "./fuse.js";
import type {
  DetectedMeeting,
  MeetingActivitySnapshot,
  MeetingsConfig,
} from "./types.js";
import type { FusionConversationInput, FusionSegmentInput } from "../wearables/fusion/types.js";

const DATE = "2026-03-10";
const WINDOW_START = "2026-03-10T14:00:00.000Z";
const WINDOW_END = "2026-03-10T14:30:00.000Z";

function config(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return { ...DEFAULT_MEETINGS_CONFIG, appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns], ...overrides };
}

function meeting(overrides: Partial<DetectedMeeting> = {}): DetectedMeeting {
  return {
    id: "mtg-2026-03-10-abcdef01",
    date: DATE,
    startUtc: WINDOW_START,
    endUtc: WINDOW_END,
    app: "Zoom",
    detectionSource: "app+audio",
    sources: ["desktop"],
    ...overrides,
  };
}

function seg(
  speaker: string,
  isSelf: boolean,
  text: string,
  startIso: string,
  endIso?: string,
): FusionSegmentInput {
  return { speaker, isSelf, text, startIso, ...(endIso !== undefined ? { endIso } : {}) };
}

function conv(
  source: string,
  id: string,
  startIso: string,
  endIso: string,
  segments: FusionSegmentInput[],
): FusionConversationInput {
  return { source, conversationId: id, startIso, endIso, segments };
}

function snap(overrides: Partial<MeetingActivitySnapshot> & { tsUtc: string; app: string }): MeetingActivitySnapshot {
  return { ...overrides };
}

test("fusion prefers the higher-trust source in overlap regions and records corroboratedBy without duplicating text", () => {
  const fused = fuseMeeting(
    {
      meeting: meeting(),
      conversations: [
        conv("desktop", "d1", "2026-03-10T14:05:00.000Z", "2026-03-10T14:07:00.000Z", [
          seg("Jane", false, "hello everyone", "2026-03-10T14:05:00.000Z", "2026-03-10T14:05:04.000Z"),
          seg("Me (you)", true, "lets begin", "2026-03-10T14:06:00.000Z"),
        ]),
        conv("pendant", "p1", "2026-03-10T14:05:00.000Z", "2026-03-10T14:05:10.000Z", [
          seg("Jane", false, "hello everyone", "2026-03-10T14:05:00.000Z", "2026-03-10T14:05:04.000Z"),
        ]),
      ],
    },
    config(),
    { sourceTrust: { desktop: 0.9, pendant: 0.6 } },
  );

  // Same utterance recorded by two sources → ONE fused segment (no dup).
  const helloSegments = fused.transcript.filter((s) => s.text === "hello everyone");
  assert.equal(helloSegments.length, 1);
  // Higher-trust source won the overlapping region.
  assert.equal(helloSegments[0]?.provenance.source, "desktop");
  assert.equal(helloSegments[0]?.provenance.reason, "higher-trust");
  // The out-voted source is recorded as corroboration.
  assert.deepEqual(fused.corroboratedBy, ["pendant"]);
  assert.deepEqual(fused.sources, ["desktop", "pendant"]);
  // Jane merged + wearer utterance = two segments total; wearer is not an attendee.
  assert.equal(fused.transcript.length, 2);
  assert.deepEqual(fused.attendees, ["Jane"]);
});

test("screen context includes a >=20s dwell and omits a 5s alt-tab; meeting-app text feeds excerpts", () => {
  const fused = fuseMeeting(
    {
      meeting: meeting(),
      conversations: [
        conv("desktop", "d1", "2026-03-10T14:05:00.000Z", "2026-03-10T14:12:00.000Z", [
          seg("Jane", false, "agenda item one", "2026-03-10T14:10:00.000Z"),
        ]),
      ],
      activity: [
        snap({ tsUtc: "2026-03-10T14:05:00.000Z", app: "Preview", title: "Q3-roadmap.pdf", text: "Q3 roadmap draft" }),
        snap({ tsUtc: "2026-03-10T14:05:25.000Z", app: "Notes", title: "scratch" }), // Preview dwell 25s → include; Notes starts
        snap({ tsUtc: "2026-03-10T14:05:30.000Z", app: "Preview", title: "Q3-roadmap.pdf" }), // Notes dwell 5s → exclude
        snap({ tsUtc: "2026-03-10T14:10:00.000Z", app: "Zoom", text: "Jane: agenda item one" }), // meeting-app → excerpt
      ],
    },
    config(),
  );

  assert.equal(fused.snapshotCount, 4);
  const apps = fused.screenContext.map((e) => e.app);
  assert.ok(apps.includes("Preview"), "Preview dwell should be in the timeline");
  assert.ok(!apps.includes("Notes"), "5s alt-tab must be excluded");
  const preview = fused.screenContext.find((e) => e.app === "Preview");
  assert.equal(preview?.label, "Preview: Q3-roadmap.pdf");
  assert.ok(preview !== undefined && preview.dwellSeconds >= 20);
  assert.ok(fused.contextExcerpts.includes("Jane: agenda item one"));
});

test("context excerpts respect maxContextChars", () => {
  const fused = fuseMeeting(
    {
      meeting: meeting(),
      conversations: [],
      activity: [
        snap({ tsUtc: "2026-03-10T14:01:00.000Z", app: "Zoom", text: "aaaa" }),
        snap({ tsUtc: "2026-03-10T14:02:00.000Z", app: "Zoom", text: "bbbb" }),
        snap({ tsUtc: "2026-03-10T14:03:00.000Z", app: "Zoom", text: "cccc" }),
      ],
    },
    config({ maxContextChars: 8 }),
  );
  // 4-char excerpts, cap 8 → exactly two fit.
  assert.deepEqual(fused.contextExcerpts, ["aaaa", "bbbb"]);
});

test("degradation — no activity yields an empty screen context but a full transcript", () => {
  const fused = fuseMeeting(
    {
      meeting: meeting({ detectionSource: "audio", app: undefined }),
      conversations: [
        conv("limitless", "l1", "2026-03-10T14:05:00.000Z", "2026-03-10T14:20:00.000Z", [
          seg("Jane", false, "quarterly numbers", "2026-03-10T14:05:00.000Z"),
        ]),
      ],
    },
    config(),
  );
  assert.equal(fused.snapshotCount, 0);
  assert.deepEqual(fused.screenContext, []);
  assert.deepEqual(fused.contextExcerpts, []);
  assert.equal(fused.transcript.length, 1);
  assert.deepEqual(fused.sources, ["limitless"]);
});

test("degradation — no audio yields an empty transcript without crashing", () => {
  const fused = fuseMeeting(
    { meeting: meeting(), conversations: [] },
    config(),
  );
  assert.deepEqual(fused.transcript, []);
  assert.deepEqual(fused.sources, []);
  assert.deepEqual(fused.corroboratedBy, []);
  assert.deepEqual(fused.attendees, []);
});

test("segments outside the half-open window are clipped out", () => {
  const fused = fuseMeeting(
    {
      meeting: meeting(),
      conversations: [
        conv("desktop", "d1", "2026-03-10T13:50:00.000Z", "2026-03-10T14:35:00.000Z", [
          seg("Jane", false, "before start", "2026-03-10T13:59:59.000Z"),
          seg("Jane", false, "in window", "2026-03-10T14:05:00.000Z"),
          seg("Jane", false, "at end boundary", WINDOW_END), // half-open: end excluded
        ]),
      ],
    },
    config(),
  );
  const texts = fused.transcript.map((s) => s.text);
  assert.deepEqual(texts, ["in window"]);
});

test("throws on an invalid meeting window", () => {
  assert.throws(
    () => fuseMeeting({ meeting: meeting({ endUtc: WINDOW_START }), conversations: [] }, config()),
    /invalid window/,
  );
});

test("a lone trailing other-app snapshot is not inflated to the meeting end", () => {
  const fused = fuseMeeting(
    {
      meeting: meeting(),
      conversations: [
        conv("desktop", "d1", "2026-03-10T14:05:00.000Z", "2026-03-10T14:12:00.000Z", [
          seg("Jane", false, "agenda", "2026-03-10T14:06:00.000Z"),
        ]),
      ],
      // A single Notes snapshot 1 min before the window end. With no later
      // snapshot, the trailing run must NOT count dwell up to the meeting end.
      activity: [snap({ tsUtc: "2026-03-10T14:29:00.000Z", app: "Notes", title: "scratch" })],
    },
    config(),
  );
  assert.equal(fused.snapshotCount, 1);
  assert.deepEqual(fused.screenContext, [], "a lone trailing snapshot has zero observed dwell");
});
