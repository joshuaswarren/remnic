import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeMeetingRecord,
  MeetingRecordStore,
  parseMeetingRecordSummary,
  serializeMeetingRecord,
  type MeetingRecordBase,
  type MeetingRecordFileIo,
} from "./store.js";
import type { FusedMeeting } from "./types.js";
import type { FusedSegment, FusedSpeaker } from "../wearables/fusion/types.js";

const MEMORY_DIR = "/mem";
const DATE = "2026-03-10";

/** In-memory secure IO for tests: no real filesystem. */
class InMemoryIo implements MeetingRecordFileIo {
  files = new Map<string, string>();
  symlinkedDirs = new Set<string>();

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }
  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw enoent();
    return value;
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
  async deleteFile(filePath: string): Promise<void> {
    if (!this.files.delete(filePath)) throw enoent();
  }
  async realpath(filePath: string): Promise<string> {
    return filePath;
  }
  async lstat(filePath: string): Promise<{ isSymbolicLink: boolean }> {
    return { isSymbolicLink: this.symlinkedDirs.has(filePath) };
  }
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function speaker(label: string, isSelf: boolean): FusedSpeaker {
  return { label, isSelf, confidence: 1, sources: ["desktop"] };
}

function segment(speakerLabel: string, text: string, startIso: string): FusedSegment {
  return {
    speaker: speakerLabel,
    isSelf: false,
    text,
    startIso,
    confidence: 0.9,
    provenance: { source: "desktop", conversationId: "d1", sourceTrust: 0.9, reason: "only-source", alternatives: [] },
  };
}

function fused(overrides: Partial<FusedMeeting> = {}): FusedMeeting {
  return {
    attendees: ["Jane"],
    sources: ["desktop"],
    corroboratedBy: [],
    screenContext: [],
    contextExcerpts: [],
    transcript: [segment("Jane", "hello everyone", "2026-03-10T14:05:00.000Z")],
    speakers: [speaker("Jane", false), speaker("Me (you)", true)],
    snapshotCount: 0,
    ...overrides,
  };
}

function base(overrides: Partial<MeetingRecordBase> = {}): MeetingRecordBase {
  return {
    id: "mtg-2026-03-10-abcdef01",
    date: DATE,
    startUtc: "2026-03-10T14:00:00.000Z",
    endUtc: "2026-03-10T14:30:00.000Z",
    app: "Zoom",
    detectionSource: "app+audio",
    ...overrides,
  };
}

test("content hash rewrite is idempotent — unchanged records skip the write", async () => {
  const io = new InMemoryIo();
  const store = new MeetingRecordStore(MEMORY_DIR, io);
  const record = composeMeetingRecord(base(), fused());

  const first = await store.saveMeetingRecord(record);
  assert.equal(first.written, true);
  const second = await store.saveMeetingRecord(record);
  assert.equal(second.written, false, "identical record must not rewrite");
  assert.equal(second.contentHash, first.contentHash);

  // A semantic change flips the hash and forces a rewrite.
  const changed = composeMeetingRecord(base(), fused({ attendees: ["Jane", "Sam"] }));
  assert.notEqual(changed.contentHash, record.contentHash);
  const third = await store.saveMeetingRecord(changed);
  assert.equal(third.written, true);
});

test("serialize → parse round-trips the frontmatter summary", () => {
  const record = composeMeetingRecord(base(), fused({ sources: ["desktop", "pendant"], corroboratedBy: ["pendant"] }));
  const raw = serializeMeetingRecord(record);
  const summary = parseMeetingRecordSummary(raw);
  assert.notEqual(summary, null);
  assert.equal(summary?.id, record.id);
  assert.equal(summary?.date, DATE);
  assert.equal(summary?.contentHash, record.contentHash);
  assert.equal(summary?.detectionSource, "app+audio");
  assert.deepEqual(summary?.attendees, ["Jane"]);
  assert.deepEqual(summary?.sources, ["desktop", "pendant"]);
  assert.deepEqual(summary?.corroboratedBy, ["pendant"]);
  assert.equal(summary?.app, "Zoom");
});

test("serialized body carries the day-store transcript line grammar", () => {
  const raw = serializeMeetingRecord(composeMeetingRecord(base(), fused()));
  assert.match(raw, /\*\*Jane\*\* \[14:05\]: hello everyone/);
  assert.match(raw, /## Transcript/);
  assert.match(raw, /## Attendees/);
});

test("parseMeetingRecordSummary rejects non-meeting content", () => {
  assert.equal(parseMeetingRecordSummary("not frontmatter"), null);
  assert.equal(parseMeetingRecordSummary("---\nkind: wearable-fusion\n---\n"), null);
});

test("recordPath validates date, id, and their agreement", () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  assert.throws(() => store.recordPath("2026-13-40", "mtg-2026-03-10-abcdef01"), /invalid meeting date/);
  assert.throws(() => store.recordPath(DATE, "not-a-meeting-id"), /invalid meeting id/);
  assert.throws(() => store.recordPath(DATE, "mtg-2026-03-11-abcdef01"), /does not belong to date/);
});

test("listing returns days newest-first and ids/summaries by start time", async () => {
  const io = new InMemoryIo();
  const store = new MeetingRecordStore(MEMORY_DIR, io);
  const early = composeMeetingRecord(
    base({ id: "mtg-2026-03-10-00000001", startUtc: "2026-03-10T09:00:00.000Z" }),
    fused(),
  );
  const late = composeMeetingRecord(
    base({ id: "mtg-2026-03-10-00000002", startUtc: "2026-03-10T15:00:00.000Z" }),
    fused(),
  );
  const otherDay = composeMeetingRecord(
    base({ id: "mtg-2026-03-11-00000003", date: "2026-03-11", startUtc: "2026-03-11T10:00:00.000Z" }),
    fused(),
  );
  // Insert late before early to prove the sort is by start, not insertion.
  await store.saveMeetingRecord(late);
  await store.saveMeetingRecord(early);
  await store.saveMeetingRecord(otherDay);

  assert.deepEqual(await store.listMeetingDates(), ["2026-03-11", "2026-03-10"]);
  assert.deepEqual(await store.listMeetingIds(DATE), [
    "mtg-2026-03-10-00000001",
    "mtg-2026-03-10-00000002",
  ]);
  const summaries = await store.listMeetingSummaries(DATE);
  assert.deepEqual(summaries.map((s) => s.startUtc), [
    "2026-03-10T09:00:00.000Z",
    "2026-03-10T15:00:00.000Z",
  ]);
});

test("empty store lists nothing", async () => {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  assert.deepEqual(await store.listMeetingDates(), []);
  assert.deepEqual(await store.listMeetingIds(DATE), []);
  assert.equal(await store.readMeetingRecord(DATE, "mtg-2026-03-10-abcdef01"), null);
});

test("a symlinked meetings dir is refused before any IO", async () => {
  const io = new InMemoryIo();
  io.symlinkedDirs.add("/mem/meetings");
  const store = new MeetingRecordStore(MEMORY_DIR, io);
  await assert.rejects(
    () => store.saveMeetingRecord(composeMeetingRecord(base(), fused())),
    /symbolic link/,
  );
});

test("a symlinked intermediate day directory is refused for reads and writes", async () => {
  const io = new InMemoryIo();
  io.symlinkedDirs.add("/mem/meetings/2026-03-10");
  const store = new MeetingRecordStore(MEMORY_DIR, io);
  await assert.rejects(
    () => store.saveMeetingRecord(composeMeetingRecord(base(), fused())),
    /symbolic link/,
  );
  await assert.rejects(() => store.listMeetingIds(DATE), /symbolic link/);
  await assert.rejects(
    () => store.readMeetingRecord(DATE, "mtg-2026-03-10-abcdef01"),
    /symbolic link/,
  );
});

test("finding 4 — a symlinked leaf record file is refused for reads and writes", async () => {
  const io = new InMemoryIo();
  // A pre-existing `<id>.md` symlink (e.g. pointing into facts/) resolves inside
  // the memory dir, so realpath containment + the dir checks pass — but a
  // follow would write raw transcript into the recall corpus. Refuse the leaf.
  io.symlinkedDirs.add("/mem/meetings/2026-03-10/mtg-2026-03-10-abcdef01.md");
  const store = new MeetingRecordStore(MEMORY_DIR, io);
  await assert.rejects(
    () => store.saveMeetingRecord(composeMeetingRecord(base(), fused())),
    /symbolic link/,
  );
  await assert.rejects(
    () => store.readMeetingRecord(DATE, "mtg-2026-03-10-abcdef01"),
    /symbolic link/,
  );
});
