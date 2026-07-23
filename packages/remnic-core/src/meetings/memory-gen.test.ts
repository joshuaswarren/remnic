import assert from "node:assert/strict";
import { test } from "node:test";

import { composeMeetingRecord, type MeetingRecordBase } from "./store.js";
import {
  composeMeetingEpisodeContent,
  generateMeetingEpisodes,
  meetingDayTag,
  meetingSourceLabel,
  writeMeetingEpisodeMemory,
  type MeetingMemoryWriter,
} from "./memory-gen.js";
import type { FusedMeeting, MeetingRecord } from "./types.js";
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
