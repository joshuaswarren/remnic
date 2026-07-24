import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { composeMeetingRecord, type MeetingRecordBase } from "./store.js";
import {
  composeMeetingEpisodeContent,
  generateMeetingEpisodes,
  generateMeetingSummaryFacts,
  meetingDayTag,
  meetingSourceLabel,
  writeMeetingEpisodeMemory,
  createMeetingMemoryWriter,
  createMeetingMemoryGenerator,
  type MeetingFactCandidate,
  type MeetingSummaryExtractor,
  type MeetingSummaryJudge,
} from "./memory-gen.js";
import type { MeetingMemoryWriter } from "./memory-generator.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import type { FusedMeeting, MeetingRecord, MeetingsConfig } from "./types.js";
import type { FusedSegment } from "../wearables/fusion/types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import { StorageManager, type MemoryWriteResult } from "../storage.js";

const DATE = "2026-03-10";

interface WriteCall {
  envelope: SealedMemoryEnvelope;
  extras: { status?: string; memoryKind?: string };
}

/** In-memory writer modelling the sealed write path + source-scoped dedup. */
class FakeWriter implements MeetingMemoryWriter {
  writes: WriteCall[] = [];
  retired: string[] = [];
  private bySource = new Map<string, Set<string>>();

  async writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status?: string; memoryKind?: string; contentHashSource?: string },
  ): Promise<MemoryWriteResult> {
    this.writes.push({ envelope, extras });
    if (extras.contentHashSource !== undefined) {
      const set = this.bySource.get(envelope.source) ?? new Set<string>();
      set.add(extras.contentHashSource);
      this.bySource.set(envelope.source, set);
    }
    return { id: `m${this.writes.length}`, path: `moments/m${this.writes.length}.md` } as unknown as MemoryWriteResult;
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

function fused(overrides: Partial<FusedMeeting> = {}): FusedMeeting {
  return {
    attendees: ["Jane", "Sam"],
    sources: ["desktop", "pendant"],
    corroboratedBy: ["pendant"],
    screenContext: [],
    contextExcerpts: [],
    transcript: [],
    speakers: [],
    snapshotCount: 0,
    ...overrides,
  };
}

function record(base: Partial<MeetingRecordBase> = {}, f: Partial<FusedMeeting> = {}): MeetingRecord {
  return composeMeetingRecord(
    {
      id: "mtg-2026-03-10-abcdef01",
      date: DATE,
      startUtc: "2026-03-10T14:00:00.000Z",
      endUtc: "2026-03-10T14:30:00.000Z",
      app: "Zoom",
      detectionSource: "app+audio",
      ...base,
    },
    fused(f),
  );
}

test("episode content is deterministic and includes span, attendees, sources, app", () => {
  const content = composeMeetingEpisodeContent(record());
  assert.match(content, /Meeting mtg-2026-03-10-abcdef01 — 2026-03-10 14:00–14:30 UTC \(Zoom\)/);
  assert.match(content, /Attendees: Jane, Sam\./);
  assert.match(content, /Transcript sources: desktop, pendant\./);
  // Same input → identical content (idempotency anchor).
  assert.equal(composeMeetingEpisodeContent(record()), content);
});

test("writeMeetingEpisodeMemory writes an active episode with meeting provenance", async () => {
  const writer = new FakeWriter();
  const wrote = await writeMeetingEpisodeMemory(record(), writer);
  assert.equal(wrote, true);
  assert.equal(writer.writes.length, 1);
  const { envelope, extras } = writer.writes[0]!;
  assert.equal(extras.status, "active");
  assert.equal(extras.memoryKind, "episode");
  assert.equal(envelope.category, "moment");
  assert.equal(envelope.source, meetingSourceLabel("mtg-2026-03-10-abcdef01"));
  assert.equal(envelope.validAt, "2026-03-10T14:00:00.000Z");
  assert.ok(envelope.tags.includes("meeting"));
  assert.ok(envelope.tags.includes(meetingDayTag(DATE)));
  // Byte-preserved camelCase provenance (composer canonicalizes structuredAttributes
  // keys to lowercase; rawStructuredAttributes keeps the original casing).
  assert.equal(envelope.rawStructuredAttributes?.meetingId, "mtg-2026-03-10-abcdef01");
  assert.equal(envelope.rawStructuredAttributes?.meetingDate, DATE);
  assert.equal(envelope.rawStructuredAttributes?.meetingApp, "Zoom");
  assert.equal(envelope.rawStructuredAttributes?.transcriptSources, "desktop,pendant");
  // Canonical (lowercased) form is what fingerprints/consumers query.
  assert.equal(envelope.structuredAttributes?.meetingid, "mtg-2026-03-10-abcdef01");
});

test("episode write is idempotent — an identical episode is skipped", async () => {
  const writer = new FakeWriter();
  assert.equal(await writeMeetingEpisodeMemory(record(), writer), true);
  assert.equal(await writeMeetingEpisodeMemory(record(), writer), false);
  assert.equal(writer.writes.length, 1);
});

test("an audio-only meeting omits the meetingApp attribute and the app suffix", async () => {
  const writer = new FakeWriter();
  const audioOnly = record({ app: undefined, detectionSource: "audio" });
  await writeMeetingEpisodeMemory(audioOnly, writer);
  const { envelope } = writer.writes[0]!;
  assert.equal(envelope.structuredAttributes?.meetingApp, undefined);
  assert.doesNotMatch(composeMeetingEpisodeContent(audioOnly), /\(Zoom\)/);
});

test("generateMeetingEpisodes writes one per record and is idempotent on re-run", async () => {
  const writer = new FakeWriter();
  const records = [
    record({ id: "mtg-2026-03-10-00000001", startUtc: "2026-03-10T09:00:00.000Z" }),
    record({ id: "mtg-2026-03-10-00000002", startUtc: "2026-03-10T15:00:00.000Z" }),
  ];
  const first = await generateMeetingEpisodes(records, writer);
  assert.deepEqual(first, { written: 2, skipped: 0 });
  const second = await generateMeetingEpisodes(records, writer);
  assert.deepEqual(second, { written: 0, skipped: 2 });
});

function segment(text: string): FusedSegment {
  return {
    speaker: "Jane",
    isSelf: false,
    text,
    startIso: "2026-03-10T14:05:00.000Z",
    confidence: 0.9,
    provenance: { source: "desktop", conversationId: "d1", sourceTrust: 0.9, reason: "only-source", alternatives: [] },
  };
}

function meetingConfig(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return { ...DEFAULT_MEETINGS_CONFIG, appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns], enabled: true, ...overrides };
}

function spyExtractor(summary: string, candidates: MeetingFactCandidate[]): MeetingSummaryExtractor & { calls: number } {
  return {
    calls: 0,
    async extract() {
      this.calls++;
      return { summary, candidates };
    },
  };
}

const TRANSCRIPT_RECORD = (): MeetingRecord =>
  record({}, { transcript: [segment("we shipped it")], corroboratedBy: [] });

test("summaryMode off never invokes the extractor and writes no facts", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("s", [{ content: "we decided to ship", category: "decision", confidence: 0.9 }]);
  const res = await generateMeetingSummaryFacts(TRANSCRIPT_RECORD(), meetingConfig({ summaryMode: "off" }), { extractor, writer });
  assert.equal(res.llmInvoked, false);
  assert.equal(extractor.calls, 0, "the LLM extractor must NOT be called in off mode");
  assert.equal(writer.writes.length, 0);
});

test("summaryMode smart routes a high-trust decision to active with meeting provenance", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("Meeting summary.", [
    { content: "Team decided to ship v2 on Friday", category: "decision", confidence: 0.9 },
    { content: "Sam will send the recap by EOD", category: "commitment", confidence: 0.9 },
  ]);
  const res = await generateMeetingSummaryFacts(TRANSCRIPT_RECORD(), meetingConfig({ summaryMode: "smart" }), { extractor, writer });
  assert.equal(res.llmInvoked, true);
  // 0.9 * 0.85 = 0.765 >= autoApprove 0.7 -> both active; plus the summary fact.
  assert.equal(res.active, 2);
  assert.equal(res.dropped, 0);
  assert.equal(res.summaryWritten, true);
  const decision = writer.writes.find((w) => w.envelope.category === "decision");
  assert.ok(decision, "a decision fact was written");
  assert.equal(decision!.extras.status, "active");
  assert.equal(decision!.envelope.rawStructuredAttributes?.meetingId, "mtg-2026-03-10-abcdef01");
  assert.ok(writer.writes.some((w) => w.envelope.category === "commitment"), "a commitment fact was written");
});

test("summaryMode smart drops a low-trust candidate but corroboration promotes it to review", async () => {
  // conf 0.5 * sourceTrust 0.85 = 0.425 < reviewTrust 0.45 -> drop.
  const lowConf: MeetingFactCandidate[] = [{ content: "maybe we will refactor later", category: "fact", confidence: 0.5 }];
  const w1 = new FakeWriter();
  const r1 = await generateMeetingSummaryFacts(
    record({}, { transcript: [segment("x")], corroboratedBy: [] }),
    meetingConfig({ summaryMode: "smart" }),
    { extractor: spyExtractor("", lowConf), writer: w1 },
  );
  assert.equal(r1.dropped, 1);
  assert.equal(r1.active + r1.review, 0);
  // With corroboration (+0.15 -> 0.575) it clears reviewTrust but not autoApprove -> review.
  const w2 = new FakeWriter();
  const r2 = await generateMeetingSummaryFacts(
    record({}, { transcript: [segment("x")], corroboratedBy: ["pendant"] }),
    meetingConfig({ summaryMode: "smart" }),
    { extractor: spyExtractor("", lowConf), writer: w2 },
  );
  assert.equal(r2.review, 1);
  assert.equal(r2.dropped, 0);
});

test("summaryMode review queues every candidate as pending_review regardless of trust", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("summary", [{ content: "high trust decision here", category: "decision", confidence: 0.99 }]);
  const res = await generateMeetingSummaryFacts(TRANSCRIPT_RECORD(), meetingConfig({ summaryMode: "review" }), { extractor, writer });
  assert.equal(res.active, 0);
  assert.equal(res.review, 1);
  const fact = writer.writes.find((w) => w.envelope.category === "decision");
  assert.equal(fact!.extras.status, "pending_review");
});

test("a judge reject drops the candidate even at high trust", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("", [{ content: "decision that the judge rejects", category: "decision", confidence: 0.99 }]);
  const res = await generateMeetingSummaryFacts(TRANSCRIPT_RECORD(), meetingConfig({ summaryMode: "smart" }), {
    extractor,
    writer,
    judge: { async judge() { return ["reject"]; } },
  });
  assert.equal(res.dropped, 1);
  assert.equal(res.active, 0);
});

test("no transcript (no audio) short-circuits without invoking the extractor", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("s", [{ content: "x y z decision", category: "decision", confidence: 0.9 }]);
  const res = await generateMeetingSummaryFacts(record({}, { transcript: [] }), meetingConfig({ summaryMode: "smart" }), { extractor, writer });
  assert.equal(res.llmInvoked, false);
  assert.equal(extractor.calls, 0);
});

test("finding 3 — smart-mode summary is trust-gated, not force-active for a low-trust meeting", async () => {
  const writer = new FakeWriter();
  // sourceTrust 0.5 → summary trust 0.8 * 0.5 = 0.4 < reviewTrust 0.45 → drop.
  // The judge also rejects the only candidate. Before the fix the summary text
  // was written ACTIVE whenever not already hashed, bypassing the gate.
  const extractor = spyExtractor("Everyone agreed to ship on Friday.", [
    { content: "we will ship on friday", category: "decision", confidence: 0.9 },
  ]);
  const res = await generateMeetingSummaryFacts(
    TRANSCRIPT_RECORD(),
    meetingConfig({ summaryMode: "smart", sourceTrust: 0.5 }),
    { extractor, writer, judge: { async judge() { return ["reject"]; } } },
  );
  assert.equal(res.active, 0, "no candidate auto-actives");
  assert.equal(res.summaryWritten, false, "the summary must be gated, not force-active");
  assert.ok(res.dropped >= 1, "the below-review-bar summary is dropped");
  assert.equal(writer.writes.length, 0, "nothing was written when everything is below the bar");
});

test("finding 1 — episode idempotency holds against a real StorageManager (source+content, not fact-only hash)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-meeting-mem-"));
  try {
    const storage = new StorageManager(dir);
    const writer = createMeetingMemoryWriter(storage);
    const rec = record();
    assert.equal(await writeMeetingEpisodeMemory(rec, writer), true, "first write lands the episode");
    // The episode is a `moment`, absent from the fact-only hash index, so a
    // rebuild must recognize it via the source+content probe and skip.
    assert.equal(await writeMeetingEpisodeMemory(rec, writer), false, "unchanged rebuild skips");
    const memories = await storage.readAllMemories();
    const episodes = memories.filter((m) => m.frontmatter.source === meetingSourceLabel(rec.id));
    assert.equal(episodes.length, 1, "exactly one episode after two runs — no duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 2 — smart-mode facts are idempotent on rebuild against a real StorageManager", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-meeting-mem-"));
  try {
    const storage = new StorageManager(dir);
    const writer = createMeetingMemoryWriter(storage);
    const extractor = spyExtractor("Team shipped v2 on Friday.", [
      { content: "Team decided to ship v2 on Friday", category: "decision", confidence: 0.9 },
      { content: "Sam will send the recap by EOD", category: "commitment", confidence: 0.9 },
    ]);
    const cfg = meetingConfig({ summaryMode: "smart" });
    const rec = TRANSCRIPT_RECORD();
    const first = await generateMeetingSummaryFacts(rec, cfg, { extractor, writer });
    assert.equal(first.active, 2, "both high-trust candidates auto-active on the first pass");
    assert.equal(first.skipped, 0);
    const afterFirst = (await storage.readAllMemories()).filter(
      (m) => m.frontmatter.source === meetingSourceLabel(rec.id),
    ).length;
    // Rebuild/retry with identical extraction: every claim already persisted for
    // this meeting → all skipped, nothing duplicated.
    const second = await generateMeetingSummaryFacts(rec, cfg, { extractor, writer });
    assert.equal(second.active, 0, "no new active facts on the second pass");
    assert.ok(second.skipped >= 2, "duplicate candidates are skipped, not re-written");
    const afterSecond = (await storage.readAllMemories()).filter(
      (m) => m.frontmatter.source === meetingSourceLabel(rec.id),
    ).length;
    assert.equal(afterSecond, afterFirst, "no meeting-derived memory was duplicated on rebuild");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 1 — two production builds of an unchanged day write the episode once (generator + writer + StorageManager)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-meeting-mem-"));
  try {
    const storage = new StorageManager(dir);
    const writer = createMeetingMemoryWriter(storage);
    const cfg = meetingConfig({ summaryMode: "off" });
    const generator = createMeetingMemoryGenerator(writer, cfg);
    const rec = record();
    // Both builds hand the record as BUILT (not unchanged) so the writer-level
    // source+content dedup is what must hold end to end — proving the episode is
    // idempotent through createMeetingMemoryGenerator + createMeetingMemoryWriter
    // even if the seam's unchanged-skip did not fire.
    const first = await generator.onRecordsBuilt({ built: [rec], removedIds: [], unchangedIds: [], updatedIds: [] });
    assert.deepEqual(first.episodes, { written: 1, skipped: 0 });
    const second = await generator.onRecordsBuilt({ built: [rec], removedIds: [], unchangedIds: [], updatedIds: [] });
    assert.deepEqual(second.episodes, { written: 0, skipped: 1 }, "the unchanged-day rebuild writes no duplicate episode");
    const episodes = (await storage.readAllMemories()).filter(
      (m) => m.frontmatter.source === meetingSourceLabel(rec.id),
    );
    assert.equal(episodes.length, 1, "exactly one episode persisted after two production builds");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding 2 — the generator skips an unchanged id WHOSE memories exist: zero extractor calls, nothing new written", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("summary", [{ content: "we decided to ship", category: "decision", confidence: 0.9 }]);
  const cfg = meetingConfig({ summaryMode: "smart" });
  const generator = createMeetingMemoryGenerator(writer, cfg, { extractor });
  const rec = TRANSCRIPT_RECORD();
  // Seed: a prior build generated this record's episode + facts.
  await generator.onRecordsBuilt({ built: [rec], removedIds: [], unchangedIds: [], updatedIds: [] });
  const extractorCallsAfterSeed = extractor.calls;
  const writesAfterSeed = writer.writes.length;
  assert.ok(writesAfterSeed > 0, "the seed build wrote memories");
  // Rebuild: the id is unchanged AND its memories already exist → the generator
  // must skip it: no episode re-write, and crucially no LLM extractor call.
  const outcome = await generator.onRecordsBuilt({
    built: [rec],
    removedIds: [],
    unchangedIds: [rec.id],
    updatedIds: [],
  });
  assert.equal(extractor.calls, extractorCallsAfterSeed, "the LLM extractor never re-runs on an idempotent rebuild");
  assert.equal(writer.writes.length, writesAfterSeed, "no new memory is written for an unchanged record");
  assert.equal(outcome.episodes, undefined, "no episode aggregate when everything was skipped");
  assert.equal(outcome.facts, undefined, "no fact aggregate when everything was skipped");
  assert.equal(outcome.reindexNeeded, false, "a no-op rebuild needs no reindex");
});

test("finding 2b — an unchanged id whose memories are MISSING is regenerated (retryable after a prior generation throw)", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("summary", [{ content: "we decided to ship", category: "decision", confidence: 0.9 }]);
  const cfg = meetingConfig({ summaryMode: "smart" });
  const generator = createMeetingMemoryGenerator(writer, cfg, { extractor });
  const rec = TRANSCRIPT_RECORD();
  // Build A persisted the record but its generation threw AFTER the record save,
  // so NO episode/summary memory exists for meeting:<id>. Model that state as a
  // writer that holds nothing for the source.
  assert.equal(writer.writes.length, 0, "no memories exist yet (generation threw before writing)");
  const source = meetingSourceLabel(rec.id);
  assert.equal(await writer.hasMemoryFromSource(source, composeMeetingEpisodeContent(rec)), false);
  // Build B: the store reports the record UNCHANGED (contentHash identical). A plain
  // skip would strand the meeting with zero memories forever; the generator must
  // instead regenerate because the expected episode is absent.
  const outcome = await generator.onRecordsBuilt({
    built: [rec],
    removedIds: [],
    unchangedIds: [rec.id],
    updatedIds: [],
  });
  assert.deepEqual(outcome.episodes, { written: 1, skipped: 0 }, "the missing episode is regenerated on the retry build");
  assert.equal(extractor.calls, 1, "the summary/facts layer runs on the retry too");
  assert.equal(await writer.hasMemoryFromSource(source, composeMeetingEpisodeContent(rec)), true, "the episode now resolves");
  // Build C: memories now present → unchanged rebuild skips (idempotent, no LLM).
  const again = await generator.onRecordsBuilt({
    built: [rec],
    removedIds: [],
    unchangedIds: [rec.id],
    updatedIds: [],
  });
  assert.equal(extractor.calls, 1, "with memories present, the extractor never re-runs");
  assert.equal(again.episodes, undefined, "with the episode present, an unchanged rebuild skips generation");
});

test("finding 3 — the generator refreshes an updated id: retract then regenerate, no duplicate", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("summary", [{ content: "we decided to ship", category: "decision", confidence: 0.9 }]);
  const cfg = meetingConfig({ summaryMode: "smart" });
  const generator = createMeetingMemoryGenerator(writer, cfg, { extractor });
  const rec = TRANSCRIPT_RECORD();
  await generator.onRecordsBuilt({ built: [rec], removedIds: [], unchangedIds: [], updatedIds: [] });
  const writesAfterFirst = writer.writes.length;
  assert.ok(writesAfterFirst > 0, "the first build wrote memories");
  const source = meetingSourceLabel(rec.id);

  // Same id, changed content: the record is signalled as updated. The generator
  // must retract the prior memories for the source, then regenerate.
  const changed = record({ app: "Meet" }, { transcript: [segment("we shipped it")], corroboratedBy: [] });
  const outcome = await generator.onRecordsBuilt({
    built: [changed],
    removedIds: [],
    unchangedIds: [],
    updatedIds: [changed.id],
  });
  assert.equal(writer.retired.filter((s) => s === source).length, 1, "the updated meeting's prior memories were retracted once");
  assert.equal(extractor.calls, 2, "the updated record is re-extracted");
  assert.deepEqual(outcome.episodes, { written: 1, skipped: 0 }, "a fresh episode is regenerated after the retract");
  // After retract, only the refreshed copy resolves for the source — no stale duplicate.
  const stale = composeMeetingEpisodeContent(rec);
  const fresh = composeMeetingEpisodeContent(changed);
  assert.notEqual(stale, fresh, "the changed record renders a different episode");
  assert.equal(await writer.hasMemoryFromSource(source, stale), false, "the stale episode no longer resolves");
  assert.equal(await writer.hasMemoryFromSource(source, fresh), true, "the refreshed episode resolves");
});

test("finding 4 — a throwing durability judge degrades gracefully, queueing candidates instead of failing", async () => {
  const writer = new FakeWriter();
  const extractor = spyExtractor("We shipped v2.", [
    { content: "Team decided to ship v2 on Friday", category: "decision", confidence: 0.9 },
  ]);
  const judge: MeetingSummaryJudge = {
    async judge() {
      throw new Error("judge provider timed out");
    },
  };
  // review mode routes every survivor to the review queue via the bands — with a
  // throwing judge the pass must still COMPLETE (no exception) and queue the
  // candidate rather than aborting the whole day build.
  const cfg = meetingConfig({ summaryMode: "review" });
  const rec = TRANSCRIPT_RECORD();
  const result = await generateMeetingSummaryFacts(rec, cfg, { extractor, judge, writer });
  assert.equal(result.llmInvoked, true, "the extractor still ran");
  assert.equal(result.review, 1, "the candidate is queued for review despite the judge throwing");
  assert.ok(
    result.warnings.some((w) => w.includes("judge unavailable")),
    "a degradation warning records the judge failure",
  );
});

test("finding 5 — a tombstone-blocked fact write is counted as blocked, not active/written", async () => {
  const extractor = spyExtractor("We shipped v2.", [
    { content: "Team decided to ship v2 on Friday", category: "fact", confidence: 0.95 },
  ]);
  // Writer whose sealed writes always report the #1579 tombstone block (the
  // chokepoint downgraded the fact to pending_review — no active copy).
  const blocked = new Set<string>();
  const writer: MeetingMemoryWriter = {
    async writeSealedMemory(envelope, extras) {
      if (extras.contentHashSource !== undefined) {
        blocked.add(`${envelope.source}\u0000${extras.contentHashSource}`);
      }
      return { id: "blocked-1", tombstoneBlocked: true, blockedBy: "tomb-1" };
    },
    async hasMemoryFromSource(source, content) {
      return blocked.has(`${source}\u0000${content}`);
    },
    async retireMemoriesFromSource() {
      return 0;
    },
  };
  const cfg = meetingConfig({ summaryMode: "smart" });
  const rec = TRANSCRIPT_RECORD();
  const result = await generateMeetingSummaryFacts(rec, cfg, { extractor, writer });
  assert.equal(result.active, 0, "a tombstone-blocked write must NOT be reported active");
  assert.equal(result.review, 0, "a tombstone-blocked write must NOT be reported review");
  assert.ok(result.tombstoneBlocked >= 1, "the blocked write is counted as tombstone-blocked");
  assert.equal(result.summaryWritten, false, "a blocked summary is not reported as written");
});
