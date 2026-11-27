import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingsBuilder, type MeetingDayData, type MeetingsDayBuildSummary, type MeetingsDaySource } from "./build.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import { MeetingRecordStore, type MeetingRecordFileIo } from "./store.js";
import type {
  MeetingsConfig,
  MeetingAppSpan,
  MeetingAudioWindow,
  MeetingRecord,
} from "./types.js";
import type { ActivitySnapshot } from "../activity/types.js";
import type { FusionConversationInput, FusionSegmentInput } from "../wearables/fusion/types.js";
import type { MeetingMemoryGenerator, MeetingMemoryOutcome } from "./memory-generator.js";

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

interface RecordedSeamCall {
  built: readonly MeetingRecord[];
  removedIds: readonly string[];
  unchangedIds: readonly string[];
  updatedIds: readonly string[];
}
class FakeMemoryGenerator implements MeetingMemoryGenerator {
  calls: RecordedSeamCall[] = [];
  constructor(private readonly outcome: MeetingMemoryOutcome) {}
  async onRecordsBuilt(input: RecordedSeamCall): Promise<MeetingMemoryOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

class ThrowingMemoryGenerator implements MeetingMemoryGenerator {
  async onRecordsBuilt(): Promise<MeetingMemoryOutcome> {
    throw new Error("secret episode extractor stack trace");
  }
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
  const activity: ActivitySnapshot[] = [
    {
      machine: "workstation",
      capturedAtUtc: "2026-03-10T14:05:00.000Z",
      app: "Preview",
      windowTitle: "Q3-roadmap.pdf",
      text: "",
      textSource: "ax",
      contentHash: "snap-1",
    },
    {
      machine: "workstation",
      capturedAtUtc: "2026-03-10T14:30:00.000Z",
      app: "Zoom",
      windowTitle: "",
      text: "meeting chat",
      textSource: "ax",
      contentHash: "snap-2",
    },
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

test("rebuild reconciles stale same-day records whose meeting no longer detects", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const START2 = "2026-03-10T16:00:00.000Z";
  const END2 = "2026-03-10T17:00:00.000Z";

  const firstData: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(firstData), store, config: cfg }).buildDay(DATE);
  assert.equal(firstSummary.meetings.length, 1);
  const staleId = firstSummary.meetings[0]!.id;
  assert.deepEqual(await store.listMeetingIds(DATE), [staleId]);

  const secondData: MeetingDayData = {
    detection: {
      date: DATE,
      appSpans: [appSpan("Zoom", START2, END2)],
      audioWindows: [audioWin("desktop", START2, END2)],
    },
    conversations: [conv("desktop", "d2", [seg("later meeting", "2026-03-10T16:05:00.000Z")])],
  };
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(secondData), store, config: cfg }).buildDay(DATE);
  assert.equal(secondSummary.meetings.length, 1);
  const freshId = secondSummary.meetings[0]!.id;
  assert.notEqual(freshId, staleId);
  assert.deepEqual(secondSummary.removed, [staleId], "the stale record must be deleted");
  assert.deepEqual(await store.listMeetingIds(DATE), [freshId]);
  assert.equal(await store.readMeetingRecord(DATE, staleId), null);
});

test("rebuild preserves the id of an overlapping shifted-start meeting", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const first: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(first), store, config: cfg }).buildDay(DATE);
  const originalId = firstSummary.meetings[0]!.id;

  const shiftedStart = "2026-03-10T14:05:00.000Z";
  const second: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", shiftedStart, END)], audioWindows: [audioWin("desktop", shiftedStart, END)] },
    conversations: [conv("desktop", "d2", [seg("hello again", "2026-03-10T14:10:00.000Z")])],
  };
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(second), store, config: cfg }).buildDay(DATE);
  assert.equal(secondSummary.meetings.length, 1);
  assert.equal(secondSummary.meetings[0]?.id, originalId, "overlapping shifted-start resync must keep the original id");
  assert.deepEqual(secondSummary.removed, [], "the meeting was adopted, not deleted");
  assert.deepEqual(await store.listMeetingIds(DATE), [originalId]);
  const raw = await store.readMeetingRecord(DATE, originalId);
  assert.match(raw!, /startUtc: "2026-03-10T14:05:00.000Z"/, "the adopted record's window is updated to the shifted start");
});

test("reindex hook fires only when records change", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const calls: MeetingsDayBuildSummary[] = [];
  const builder = new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: config(),
    hooks: { reindex: (summary) => { calls.push(summary); } },
  });
  const first = await builder.buildDay(DATE);
  assert.equal(first.built, 1);
  assert.equal(calls.length, 1, "reindex fires after new records are written");
  assert.equal(calls[0]?.built, 1);
  const second = await builder.buildDay(DATE);
  assert.equal(second.built, 0);
  assert.equal(second.removed.length, 0);
  assert.equal(calls.length, 1, "reindex does not fire when nothing changed");
});

test("finding 3 — a rejecting reindex hook is isolated with a SANITIZED warning (no raw error text)", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const builder = new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: config(),
    hooks: { reindex: () => { throw new Error("qmd backend unreachable (ECONNREFUSED 127.0.0.1:9999)"); } },
  });
  const summary = await builder.buildDay(DATE);
  assert.equal(summary.built, 1, "records persist even though reindex threw");
  assert.match(summary.reindexWarning ?? "", /reindex hook failed after records were persisted/);
  assert.doesNotMatch(summary.reindexWarning ?? "", /qmd|ECONNREFUSED|9999/i, "raw internal error text must not reach the surfaced warning");
  assert.equal((await store.listMeetingIds(DATE)).length, 1);
});

test("buildDay rejects a day source whose detection.date disagrees with the requested day", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const wrongDay: MeetingDayData = {
    detection: { date: "2026-03-11", appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [],
  };
  const builder = new MeetingsBuilder({ source: fixedSource(wrongDay), store, config: config() });
  await assert.rejects(() => builder.buildDay(DATE), /detection\.date "2026-03-11" for requested day "2026-03-10"/);
});

test("finding 6 — a marginally-overlapping different meeting does not adopt a stale id", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const first: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(first), store, config: cfg }).buildDay(DATE);
  const staleId = firstSummary.meetings[0]!.id;

  const OVERLAP_START = "2026-03-10T14:55:00.000Z";
  const LATER_END = "2026-03-10T16:00:00.000Z";
  const second: MeetingDayData = {
    detection: {
      date: DATE,
      appSpans: [appSpan("Microsoft Teams", OVERLAP_START, LATER_END)],
      audioWindows: [audioWin("pendant", OVERLAP_START, LATER_END)],
    },
    conversations: [
      {
        source: "pendant",
        conversationId: "p1",
        startIso: OVERLAP_START,
        endIso: LATER_END,
        segments: [{ speaker: "Bob", isSelf: false, text: "different meeting", startIso: "2026-03-10T15:30:00.000Z" }],
      },
    ],
  };
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(second), store, config: cfg }).buildDay(DATE);
  assert.equal(secondSummary.meetings.length, 1);
  assert.notEqual(secondSummary.meetings[0]?.id, staleId, "marginal overlap must NOT reuse the stale id");
  assert.deepEqual(secondSummary.removed, [staleId], "the stale meeting is removed, not overwritten");
  assert.equal(await store.readMeetingRecord(DATE, staleId), null);
});

test("seam — the memory generator receives built records + removed ids and its counts fold into the summary", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const gen = new FakeMemoryGenerator({
    episodes: { written: 1, skipped: 0 },
    facts: { llmInvoked: true, active: 2, review: 0, dropped: 0, skipped: 0, summariesWritten: 1 },
    reindexNeeded: false,
    warnings: [],
  });
  const cfg = config();
  const summary = await new MeetingsBuilder({ source: fixedSource(data), store, config: cfg, memoryGenerator: gen }).buildDay(DATE);
  assert.equal(gen.calls.length, 1, "the generator is invoked once per build");
  assert.equal(gen.calls[0]?.built.length, 1, "the built records are handed to the generator");
  assert.equal(gen.calls[0]?.built[0]?.id, summary.meetings[0]?.id, "the same record ids flow through the seam");
  assert.deepEqual(gen.calls[0]?.removedIds, [], "no records were removed on a first build");
  assert.deepEqual(summary.episodes, { written: 1, skipped: 0 });
  assert.deepEqual(summary.facts, { llmInvoked: true, active: 2, review: 0, dropped: 0, skipped: 0, summariesWritten: 1 });
});

test("finding 2 (round-4) — non-fatal generator warnings surface in the day-build summary", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const gen = new FakeMemoryGenerator({
    episodes: { written: 1, skipped: 0 },
    reindexNeeded: false,
    warnings: ["summary dep degraded: skipped fact synthesis", "1 transcript segment dropped"],
  });
  const summary = await new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: config(),
    memoryGenerator: gen,
  }).buildDay(DATE);
  assert.equal(summary.built, 1, "the build still succeeds when the generator returns warnings");
  assert.match(
    summary.memoryWarning ?? "",
    /summary dep degraded/,
    "a successful build must not drop the generator's non-fatal warnings",
  );
  assert.match(
    summary.memoryWarning ?? "",
    /transcript segment dropped/,
    "every generator warning surfaces in the summary",
  );
});

test("seam — removed record ids are forwarded to the generator on a reconciling rebuild", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const first: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(first), store, config: cfg }).buildDay(DATE);
  const staleId = firstSummary.meetings[0]!.id;

  const LATER_START = "2026-03-10T16:00:00.000Z";
  const LATER_END = "2026-03-10T17:00:00.000Z";
  const second: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", LATER_START, LATER_END)], audioWindows: [audioWin("desktop", LATER_START, LATER_END)] },
    conversations: [conv("desktop", "d2", [seg("later", "2026-03-10T16:05:00.000Z")])],
  };
  const gen = new FakeMemoryGenerator({ reindexNeeded: false, warnings: [] });
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(second), store, config: cfg, memoryGenerator: gen }).buildDay(DATE);
  assert.deepEqual(secondSummary.removed, [staleId]);
  assert.equal(gen.calls.length, 1);
  assert.deepEqual(gen.calls[0]?.removedIds, [staleId], "the removed meeting id is handed to the generator to retire");
});

test("seam — outcome.reindexNeeded fires the reindex hook even when no record changed", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const cfg = config();
  await new MeetingsBuilder({ source: fixedSource(data), store, config: cfg }).buildDay(DATE);

  const calls: MeetingsDayBuildSummary[] = [];
  const gen = new FakeMemoryGenerator({ episodes: { written: 1, skipped: 0 }, reindexNeeded: true, warnings: [] });
  const summary = await new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: cfg,
    memoryGenerator: gen,
    hooks: { reindex: (s) => { calls.push(s); } },
  }).buildDay(DATE);
  assert.equal(summary.built, 0, "the record was unchanged");
  assert.equal(summary.removed.length, 0);
  assert.deepEqual(summary.episodes, { written: 1, skipped: 0 }, "episode counts still fold in");
  assert.equal(calls.length, 1, "reindexNeeded from the generator drives the reindex even with no record change");
});

test("seam — no record change and a false reindexNeeded does not fire the reindex hook", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const cfg = config();
  await new MeetingsBuilder({ source: fixedSource(data), store, config: cfg }).buildDay(DATE);

  const calls: MeetingsDayBuildSummary[] = [];
  const gen = new FakeMemoryGenerator({ episodes: { written: 0, skipped: 1 }, reindexNeeded: false, warnings: [] });
  await new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: cfg,
    memoryGenerator: gen,
    hooks: { reindex: (s) => { calls.push(s); } },
  }).buildDay(DATE);
  assert.equal(calls.length, 0, "no record change + no reindexNeeded → no reindex");
});

test("finding 2 — a rejecting memory generator is isolated: records persist + a sanitized warning", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const summary = await new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: config(),
    memoryGenerator: new ThrowingMemoryGenerator(),
  }).buildDay(DATE);
  assert.equal(summary.built, 1, "the built record survives a generator failure");
  assert.equal(summary.meetings.length, 1);
  assert.equal((await store.listMeetingIds(DATE)).length, 1, "the record is on disk despite the generator throwing");
  assert.match(summary.memoryWarning ?? "", /memory generation failed after records were persisted/);
  assert.doesNotMatch(summary.memoryWarning ?? "", /stack trace|extractor/i, "raw generator error must not reach the surfaced warning");
  assert.equal(summary.episodes, undefined, "no counts fold in from a failed generator");
});

test("finding 4 — marginal overlap with a matching app+source still does NOT adopt a stale id", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const first: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(first), store, config: cfg }).buildDay(DATE);
  const staleId = firstSummary.meetings[0]!.id;

  const OVERLAP_START = "2026-03-10T14:55:00.000Z";
  const LATER_END = "2026-03-10T16:00:00.000Z";
  const second: MeetingDayData = {
    detection: {
      date: DATE,
      appSpans: [appSpan("Zoom", OVERLAP_START, LATER_END)],
      audioWindows: [audioWin("desktop", OVERLAP_START, LATER_END)],
    },
    conversations: [
      {
        source: "desktop",
        conversationId: "d2",
        startIso: OVERLAP_START,
        endIso: LATER_END,
        segments: [{ speaker: "Bob", isSelf: false, text: "different meeting", startIso: "2026-03-10T15:30:00.000Z" }],
      },
    ],
  };
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(second), store, config: cfg }).buildDay(DATE);
  assert.equal(secondSummary.meetings.length, 1);
  assert.notEqual(
    secondSummary.meetings[0]?.id,
    staleId,
    "marginal overlap must not reuse the stale id even when app + source match",
  );
  assert.deepEqual(secondSummary.removed, [staleId], "the stale meeting is removed, not overwritten");
  assert.equal(await store.readMeetingRecord(DATE, staleId), null);
});

test("finding 5 — the seam forwards updatedIds when a record keeps its id but its content changes", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const first: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstGen = new FakeMemoryGenerator({ reindexNeeded: false, warnings: [] });
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(first), store, config: cfg, memoryGenerator: firstGen }).buildDay(DATE);
  const id = firstSummary.meetings[0]!.id;
  assert.deepEqual(firstGen.calls[0]?.updatedIds, [], "a brand-new record is not an update");
  assert.deepEqual(firstGen.calls[0]?.unchangedIds, [], "a brand-new record is not unchanged");

  const shiftedStart = "2026-03-10T14:05:00.000Z";
  const second: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", shiftedStart, END)], audioWindows: [audioWin("desktop", shiftedStart, END)] },
    conversations: [conv("desktop", "d2", [seg("hello again", "2026-03-10T14:10:00.000Z")])],
  };
  const gen = new FakeMemoryGenerator({ reindexNeeded: false, warnings: [] });
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(second), store, config: cfg, memoryGenerator: gen }).buildDay(DATE);
  assert.equal(secondSummary.meetings[0]?.id, id, "the id is adopted (kept) across the shifted-start resync");
  assert.equal(secondSummary.built, 1, "the record was rewritten (content changed)");
  assert.deepEqual(gen.calls[0]?.updatedIds, [id], "the same-id rewrite is forwarded as an updated id");
  assert.deepEqual(gen.calls[0]?.unchangedIds, [], "an updated record is not reported unchanged");
});

test("finding 6 — the seam forwards unchangedIds for an idempotent rebuild", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const cfg = config();
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const firstGen = new FakeMemoryGenerator({ reindexNeeded: false, warnings: [] });
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(data), store, config: cfg, memoryGenerator: firstGen }).buildDay(DATE);
  const id = firstSummary.meetings[0]!.id;
  assert.deepEqual(firstGen.calls[0]?.unchangedIds, [], "the first write is not unchanged");

  const gen = new FakeMemoryGenerator({ reindexNeeded: false, warnings: [] });
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(data), store, config: cfg, memoryGenerator: gen }).buildDay(DATE);
  assert.equal(secondSummary.built, 0, "nothing was rewritten on the idempotent rebuild");
  assert.equal(secondSummary.skipped, 1);
  assert.deepEqual(gen.calls[0]?.unchangedIds, [id], "the unchanged record id is forwarded so the generator skips regeneration");
  assert.deepEqual(gen.calls[0]?.updatedIds, [], "an unchanged record is not an update");
  assert.deepEqual(gen.calls[0]?.built.map((r) => r.id), [id], "built still carries every record for context");
});
