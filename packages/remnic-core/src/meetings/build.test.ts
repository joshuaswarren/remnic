import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingsBuilder, type MeetingDayData, type MeetingsDaySource } from "./build.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import { MeetingRecordStore, type MeetingRecordFileIo } from "./store.js";
import type { MeetingActivitySnapshot, MeetingsConfig, MeetingAppSpan, MeetingAudioWindow } from "./types.js";
import type { FusionConversationInput, FusionSegmentInput } from "../wearables/fusion/types.js";

const MEMORY_DIR = "/mem";
const DATE = "2026-03-10";
const START = "2026-03-10T14:00:00.000Z";
const END = "2026-03-10T15:00:00.000Z";

class InMemoryIo implements MeetingRecordFileIo {
  files = new Map<string, string>();
  async writeFile(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async readFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw enoent();
    return v;
  }
  async readDir(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    const names = new Set<string>();
    let found = false;
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      found = true;
      names.add(key.slice(prefix.length).split("/")[0]!);
    }
    if (!found) throw enoent();
    return [...names];
  }
  async deleteFile(p: string): Promise<void> {
    if (!this.files.delete(p)) throw enoent();
  }
  async realpath(p: string): Promise<string> {
    return p;
  }
  async lstat(): Promise<{ isSymbolicLink: boolean }> {
    return { isSymbolicLink: false };
  }
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function config(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return {
    ...DEFAULT_MEETINGS_CONFIG,
    appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns],
    enabled: true,
    ...overrides,
  };
}

function fixedSource(data: MeetingDayData): MeetingsDaySource {
  return { loadDayData: () => data };
}

function appSpan(app: string, start: string, end: string): MeetingAppSpan {
  return { app, startUtc: start, endUtc: end };
}

function audioWin(
  source: string,
  start: string,
  end: string,
  overrides: Partial<MeetingAudioWindow> = {},
): MeetingAudioWindow {
  return { source, startUtc: start, endUtc: end, distinctNonWearerSpeakers: 2, ...overrides };
}

function seg(text: string, startIso: string): FusionSegmentInput {
  return { speaker: "Jane", isSelf: false, text, startIso };
}

function conv(source: string, id: string, segments: FusionSegmentInput[]): FusionConversationInput {
  return { source, conversationId: id, startIso: START, endIso: END, segments };
}

function builder(data: MeetingDayData, cfg: MeetingsConfig, fusionOptions?: { sourceTrust?: Record<string, number> }) {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  return {
    store,
    builder: new MeetingsBuilder({ source: fixedSource(data), store, config: cfg, ...(fusionOptions ? { fusionOptions } : {}) }),
  };
}

test("degradation — meetings.enabled false builds nothing on every surface", async () => {
  const { builder: b, store } = builder(
    { detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] }, conversations: [] },
    config({ enabled: false }),
  );
  const summary = await b.buildDay(DATE);
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.meetings, []);
  assert.deepEqual(await store.listMeetingDates(), []);
});

test("degradation — activity only (no audio) detects zero meetings", async () => {
  const { builder: b, store } = builder(
    { detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [] }, conversations: [] },
    config(),
  );
  const summary = await b.buildDay(DATE);
  assert.equal(summary.enabled, true);
  assert.equal(summary.meetings.length, 0);
  assert.deepEqual(await store.listMeetingDates(), []);
});

test("degradation — audio only yields a record with no screen-context section", async () => {
  const { builder: b, store } = builder(
    {
      detection: { date: DATE, appSpans: [], audioWindows: [audioWin("limitless", START, END)] },
      conversations: [conv("limitless", "l1", [seg("quarterly numbers", "2026-03-10T14:05:00.000Z")])],
      // No activity.
    },
    config(),
  );
  const summary = await b.buildDay(DATE);
  assert.equal(summary.meetings.length, 1);
  assert.equal(summary.meetings[0]?.detectionSource, "audio");
  assert.equal(summary.built, 1);
  const raw = await store.readMeetingRecord(DATE, summary.meetings[0]!.id);
  assert.notEqual(raw, null);
  assert.doesNotMatch(raw!, /## Screen context/);
  assert.match(raw!, /## Transcript/);
});

test("full — app+audio with activity fuses transcript and screen context", async () => {
  const activity: MeetingActivitySnapshot[] = [
    { tsUtc: "2026-03-10T14:05:00.000Z", app: "Preview", title: "Q3-roadmap.pdf" },
    { tsUtc: "2026-03-10T14:30:00.000Z", app: "Zoom", text: "meeting chat" },
  ];
  const { builder: b, store } = builder(
    {
      detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
      conversations: [conv("desktop", "d1", [seg("agenda", "2026-03-10T14:06:00.000Z")])],
      activity,
    },
    config(),
  );
  const summary = await b.buildDay(DATE);
  assert.equal(summary.meetings.length, 1);
  const outcome = summary.meetings[0]!;
  assert.equal(outcome.detectionSource, "app+audio");
  assert.equal(outcome.written, true);
  assert.ok(outcome.snapshotCount >= 1);
  const raw = await store.readMeetingRecord(DATE, outcome.id);
  assert.match(raw!, /## Screen context/);
  assert.match(raw!, /Preview: Q3-roadmap\.pdf/);

  // Re-build with the same data is idempotent (nothing rewritten).
  const again = await b.buildDay(DATE);
  assert.equal(again.built, 0);
  assert.equal(again.skipped, 1);
});

test("multiple audio sources for one meeting fuse with recorded corroboration", async () => {
  const { builder: b, store } = builder(
    {
      detection: {
        date: DATE,
        appSpans: [appSpan("Zoom", START, END)],
        audioWindows: [audioWin("desktop", START, END), audioWin("pendant", START, END)],
      },
      conversations: [
        conv("desktop", "d1", [seg("hello everyone", "2026-03-10T14:05:00.000Z")]),
        conv("pendant", "p1", [seg("hello everyone", "2026-03-10T14:05:00.000Z")]),
      ],
    },
    config(),
    { sourceTrust: { desktop: 0.9, pendant: 0.6 } },
  );
  const summary = await b.buildDay(DATE);
  assert.equal(summary.meetings.length, 1, "the two sources collapse into one meeting");
  assert.deepEqual(summary.meetings[0]?.sources, ["desktop", "pendant"]);
  const record = await store.listMeetingSummaries(DATE);
  assert.deepEqual(record[0]?.corroboratedBy, ["pendant"]);
});

test("degradation — provider transcript detects without an app span", async () => {
  const { builder: b } = builder(
    {
      detection: {
        date: DATE,
        appSpans: [],
        audioWindows: [audioWin("granola", START, END, { providerMeeting: true, title: "Weekly sync", distinctNonWearerSpeakers: 1 })],
      },
      conversations: [conv("granola", "g1", [seg("standup", "2026-03-10T14:05:00.000Z")])],
    },
    config(),
  );
  const summary = await b.buildDay(DATE);
  assert.equal(summary.meetings.length, 1);
  assert.equal(summary.meetings[0]?.detectionSource, "provider");
});
