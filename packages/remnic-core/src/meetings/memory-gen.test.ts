import assert from "node:assert/strict";
import { test } from "node:test";

import { composeMeetingRecord, type MeetingRecordBase } from "./store.js";
import {
  composeMeetingEpisodeContent,
  generateMeetingEpisodes,
  generateMeetingSummaryFacts,
  meetingDayTag,
  meetingSourceLabel,
  writeMeetingEpisodeMemory,
  type MeetingFactCandidate,
  type MeetingMemoryWriter,
  type MeetingSummaryExtractor,
} from "./memory-gen.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import type { FusedMeeting, MeetingRecord, MeetingsConfig } from "./types.js";
import type { FusedSegment } from "../wearables/fusion/types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import type { MemoryWriteResult } from "../storage.js";

const DATE = "2026-03-10";

interface WriteCall {
  envelope: SealedMemoryEnvelope;
  extras: { status?: string; memoryKind?: string };
}

/** In-memory writer modelling the sealed write path + content-hash dedup. */
class FakeWriter implements MeetingMemoryWriter {
  writes: WriteCall[] = [];
  private hashes = new Set<string>();

  async writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: { status?: string; memoryKind?: string; contentHashSource?: string },
  ): Promise<MemoryWriteResult> {
    this.writes.push({ envelope, extras });
    if (extras.contentHashSource !== undefined) this.hashes.add(extras.contentHashSource);
    return { id: `m${this.writes.length}`, path: `moments/m${this.writes.length}.md` } as unknown as MemoryWriteResult;
  }
  async hasFactContentHash(content: string): Promise<boolean> {
    return this.hashes.has(content);
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
