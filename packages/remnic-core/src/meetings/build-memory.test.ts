import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingsBuilder, type MeetingDayData, type MeetingsDayBuildSummary } from "./build.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import { MeetingRecordStore, type MeetingRecordFileIo } from "./store.js";
import type { MeetingsConfig, MeetingAppSpan, MeetingAudioWindow } from "./types.js";
import type { FusionConversationInput, FusionSegmentInput } from "../wearables/fusion/types.js";
import {
  createMeetingMemoryGenerator,
  meetingSourceLabel,
  type MeetingFactCandidate,
  type MeetingSummaryExtractor,
} from "./memory-gen.js";
import type { MeetingMemoryWriter } from "./memory-generator.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import type { MemoryWriteResult } from "../storage.js";

// Integration coverage for the builder driving the CONCRETE memory generator
// (createMeetingMemoryGenerator) through the seam — migrated out of the engine
// build.test.ts (issue #1900 re-slice). The engine test asserts SEAM contract
// with an inline fake; these tests assert the real memory-generation BEHAVIOR
// (episode idempotency, retract-on-delete, and smart/review/off trust-gating)
// end to end through MeetingsBuilder.

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

/** Fake meeting memory writer modelling source-scoped dedup + retire. */
class FakeMeetingWriter implements MeetingMemoryWriter {
  writes: Array<{ source: string; content?: string; status?: string; category: string; meetingId?: string }> = [];
  retired: string[] = [];
  private bySource = new Map<string, Set<string>>();

  async writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { contentHashSource?: string; status?: string },
  ): Promise<MemoryWriteResult> {
    this.writes.push({
      source: envelope.source,
      ...(extras.contentHashSource !== undefined ? { content: extras.contentHashSource } : {}),
      ...(extras.status !== undefined ? { status: extras.status } : {}),
      category: envelope.category,
      ...(envelope.rawStructuredAttributes?.meetingId !== undefined
        ? { meetingId: envelope.rawStructuredAttributes.meetingId }
        : {}),
    });
    if (extras.contentHashSource !== undefined) {
      const set = this.bySource.get(envelope.source) ?? new Set<string>();
      set.add(extras.contentHashSource);
      this.bySource.set(envelope.source, set);
    }
    return { id: `m${this.writes.length}`, path: `mem/m${this.writes.length}.md` } as unknown as MemoryWriteResult;
  }
  async hasMemoryFromSource(source: string, content: string): Promise<boolean> {
    return this.bySource.get(source)?.has(content) ?? false;
  }
  async retireMemoriesFromSource(source: string): Promise<number> {
    this.retired.push(source);
    const count = this.bySource.get(source)?.size ?? 0;
    this.bySource.delete(source);
    return count;
  }
}

function spyExtractor(
  summary: string,
  candidates: MeetingFactCandidate[],
): MeetingSummaryExtractor & { calls: number } {
  return {
    calls: 0,
    async extract() {
      this.calls++;
      return { summary, candidates };
    },
  };
}

function config(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return {
    ...DEFAULT_MEETINGS_CONFIG,
    appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns],
    enabled: true,
    ...overrides,
  };
}

function fixedSource(data: MeetingDayData) {
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

test("builder writes a deterministic episode memory per built record when a writer is injected", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const memoryWriter = new FakeMeetingWriter();
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const cfg = config();
  const builder = new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: cfg,
    memoryGenerator: createMeetingMemoryGenerator(memoryWriter, cfg),
  });
  const first = await builder.buildDay(DATE);
  assert.equal(first.meetings.length, 1);
  assert.deepEqual(first.episodes, { written: 1, skipped: 0 });
  assert.equal(memoryWriter.writes.length, 1);
  // Rebuild: the episode already exists → skipped, no second write.
  const second = await builder.buildDay(DATE);
  assert.deepEqual(second.episodes, { written: 0, skipped: 1 });
  assert.equal(memoryWriter.writes.length, 1);
});

test("finding 8 — reindex fires when only episodes are newly written (records unchanged)", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const data: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  // First build with NO memory writer: the record persists, but no episode is
  // written (models a prior run whose episode write had not happened / failed).
  await new MeetingsBuilder({ source: fixedSource(data), store, config: config() }).buildDay(DATE);

  // Second build with a writer + reindex hook: the record is unchanged
  // (built == 0 && removed == 0) but a new episode is created → reindex MUST
  // still fire so the new active memory is discoverable now.
  const memoryWriter = new FakeMeetingWriter();
  const calls: MeetingsDayBuildSummary[] = [];
  const cfg = config();
  const summary = await new MeetingsBuilder({
    source: fixedSource(data),
    store,
    config: cfg,
    memoryGenerator: createMeetingMemoryGenerator(memoryWriter, cfg),
    hooks: { reindex: (s) => { calls.push(s); } },
  }).buildDay(DATE);
  assert.equal(summary.built, 0, "the record was unchanged");
  assert.equal(summary.removed.length, 0);
  assert.deepEqual(summary.episodes, { written: 1, skipped: 0 });
  assert.equal(calls.length, 1, "reindex fires because a new episode was written");
});

test("finding 9 — removing a meeting retires its episode/summary memories", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const memoryWriter = new FakeMeetingWriter();
  const first: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("hello", "2026-03-10T14:05:00.000Z")])],
  };
  const cfg = config();
  const firstSummary = await new MeetingsBuilder({ source: fixedSource(first), store, config: cfg, memoryGenerator: createMeetingMemoryGenerator(memoryWriter, cfg) }).buildDay(DATE);
  const staleId = firstSummary.meetings[0]!.id;
  const episodeContent = memoryWriter.writes.find((w) => w.source === meetingSourceLabel(staleId))?.content;
  assert.ok(episodeContent !== undefined, "episode written for the meeting");
  assert.equal(await memoryWriter.hasMemoryFromSource(meetingSourceLabel(staleId), episodeContent!), true);

  // Rebuild: a non-overlapping later meeting replaces it → the stale meeting is
  // removed, and its meeting-derived memories must be retired too.
  const LATER_START = "2026-03-10T16:00:00.000Z";
  const LATER_END = "2026-03-10T17:00:00.000Z";
  const second: MeetingDayData = {
    detection: { date: DATE, appSpans: [appSpan("Zoom", LATER_START, LATER_END)], audioWindows: [audioWin("desktop", LATER_START, LATER_END)] },
    conversations: [
      { source: "desktop", conversationId: "d2", startIso: LATER_START, endIso: LATER_END, segments: [{ speaker: "Jane", isSelf: false, text: "later", startIso: "2026-03-10T16:05:00.000Z" }] },
    ],
  };
  const secondSummary = await new MeetingsBuilder({ source: fixedSource(second), store, config: cfg, memoryGenerator: createMeetingMemoryGenerator(memoryWriter, cfg) }).buildDay(DATE);
  assert.deepEqual(secondSummary.removed, [staleId]);
  assert.ok(memoryWriter.retired.includes(meetingSourceLabel(staleId)), "the removed meeting's memories are retired");
  assert.equal(
    await memoryWriter.hasMemoryFromSource(meetingSourceLabel(staleId), episodeContent!),
    false,
    "no memory remains for the removed meeting",
  );
});

function summaryData(): MeetingDayData {
  return {
    detection: { date: DATE, appSpans: [appSpan("Zoom", START, END)], audioWindows: [audioWin("desktop", START, END)] },
    conversations: [conv("desktop", "d1", [seg("we shipped v2", "2026-03-10T14:05:00.000Z")])],
  };
}

const SUMMARY_CANDIDATES: MeetingFactCandidate[] = [
  { content: "Team decided to ship v2 on Friday", category: "decision", confidence: 0.9 },
  { content: "Sam will send the recap by EOD", category: "commitment", confidence: 0.9 },
];

test("finding 11+12 — smart mode wires trust-gated decision + commitment on the production build path", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const memoryWriter = new FakeMeetingWriter();
  const extractor = spyExtractor("We shipped v2.", SUMMARY_CANDIDATES);
  const cfg = config({ summaryMode: "smart" });
  const summary = await new MeetingsBuilder({
    source: fixedSource(summaryData()),
    store,
    config: cfg,
    memoryGenerator: createMeetingMemoryGenerator(memoryWriter, cfg, { extractor }),
  }).buildDay(DATE);
  const builtId = summary.meetings[0]!.id;
  assert.equal(extractor.calls, 1, "the extractor runs on the production path");
  assert.ok(summary.facts !== undefined, "facts aggregate is present");
  assert.equal(summary.facts?.llmInvoked, true);
  assert.equal(summary.facts?.active, 2, "both high-trust claims auto-active");
  const commitment = memoryWriter.writes.find((w) => w.category === "commitment");
  assert.ok(commitment, "a commitment fact was written");
  assert.equal(commitment?.status, "active");
  assert.equal(commitment?.meetingId, builtId, "commitment carries meetingId provenance");
  assert.ok(memoryWriter.writes.some((w) => w.category === "decision" && w.status === "active"), "a decision fact was written active");
});

test("finding 11+12 — review mode queues facts, off mode makes zero LLM calls", async () => {
  const reviewStore = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const reviewWriter = new FakeMeetingWriter();
  const reviewExtractor = spyExtractor("We shipped v2.", SUMMARY_CANDIDATES);
  const reviewCfg = config({ summaryMode: "review" });
  const reviewSummary = await new MeetingsBuilder({
    source: fixedSource(summaryData()),
    store: reviewStore,
    config: reviewCfg,
    memoryGenerator: createMeetingMemoryGenerator(reviewWriter, reviewCfg, { extractor: reviewExtractor }),
  }).buildDay(DATE);
  assert.equal(reviewExtractor.calls, 1);
  assert.equal(reviewSummary.facts?.active, 0, "review mode never auto-actives");
  assert.equal(reviewSummary.facts?.review, 2, "both candidates queued for review");
  assert.ok(reviewWriter.writes.some((w) => w.category === "commitment" && w.status === "pending_review"));

  const offStore = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const offWriter = new FakeMeetingWriter();
  const offExtractor = spyExtractor("We shipped v2.", SUMMARY_CANDIDATES);
  const offCfg = config({ summaryMode: "off" });
  const offSummary = await new MeetingsBuilder({
    source: fixedSource(summaryData()),
    store: offStore,
    config: offCfg,
    memoryGenerator: createMeetingMemoryGenerator(offWriter, offCfg, { extractor: offExtractor }),
  }).buildDay(DATE);
  assert.equal(offExtractor.calls, 0, "off mode must NEVER invoke the extractor");
  assert.equal(offSummary.facts, undefined, "no fact aggregate in off mode");
  assert.ok(offWriter.writes.every((w) => w.category === "moment"), "off mode writes only the episode, no summary facts");
});
