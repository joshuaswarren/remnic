import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingsBuilder, type MeetingDayData, type MeetingsDaySource } from "./build.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import { MeetingRecordStore, type MeetingRecordFileIo } from "./store.js";
import { MeetingsInputError } from "./errors.js";
import { MeetingsService } from "./service.js";
import type { MeetingsConfig } from "./types.js";

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

/** A day source that detects one app+audio meeting for DATE. */
function dayData(): MeetingDayData {
  return {
    detection: {
      date: DATE,
      appSpans: [{ app: "Zoom", startUtc: START, endUtc: END }],
      audioWindows: [{ source: "desktop", startUtc: START, endUtc: END, distinctNonWearerSpeakers: 2 }],
    },
    conversations: [
      {
        source: "desktop",
        conversationId: "c1",
        startIso: START,
        endIso: END,
        segments: [{ speaker: "Jane", isSelf: false, text: "hello", startIso: "2026-03-10T14:05:00.000Z" }],
      },
    ],
  };
}

function makeService(cfg: MeetingsConfig, source: MeetingsDaySource): {
  service: MeetingsService;
  store: MeetingRecordStore;
} {
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const builder = new MeetingsBuilder({ source, store, config: cfg });
  const service = new MeetingsService({ config: cfg, store, builder, buildDebounceMs: 10_000 });
  return { service, store };
}

test("meetingsBuild detects + stores, and meetingsList/meetingsGet then surface it", async () => {
  const { service } = makeService(config(), { loadDayData: () => dayData() });
  const built = await service.meetingsBuild(DATE);
  assert.equal(built.enabled, true);
  assert.equal(built.meetings.length, 1);
  const id = built.meetings[0]!.id;

  const list = await service.meetingsList(DATE);
  assert.equal(list.enabled, true);
  assert.equal(list.days.length, 1);
  assert.equal(list.days[0]?.date, DATE);
  assert.equal(list.days[0]?.meetings[0]?.id, id);

  const listAll = await service.meetingsList();
  assert.deepEqual(listAll.days.map((d) => d.date), [DATE]);

  const got = await service.meetingsGet(id);
  assert.equal(got.enabled, true);
  assert.equal(got.found, true);
  assert.equal(got.id, id);
  assert.match(got.record ?? "", /## Transcript/);
});

test("meetingsGet reports a missing record without throwing", async () => {
  const { service } = makeService(config(), { loadDayData: () => dayData() });
  const got = await service.meetingsGet("mtg-2026-03-10-deadbeef");
  assert.equal(got.found, false);
  assert.equal(got.record, null);
});

test("disabled mode: every entrypoint is a no-op", async () => {
  const { service, store } = makeService(config({ enabled: false }), { loadDayData: () => dayData() });

  const built = await service.meetingsBuild(DATE);
  assert.equal(built.enabled, false);
  assert.deepEqual(built.meetings, []);
  assert.deepEqual(await store.listMeetingDates(), [], "disabled build writes nothing");

  const list = await service.meetingsList(DATE);
  assert.equal(list.enabled, false);
  assert.deepEqual(list.days, []);

  const got = await service.meetingsGet("mtg-2026-03-10-deadbeef");
  assert.equal(got.enabled, false);
  assert.equal(got.found, false);

  // requestBuild is a no-op when disabled: flushing must build nothing.
  service.requestBuild(DATE);
  await service.flushBuilds();
  assert.deepEqual(await store.listMeetingDates(), []);
});

test("invalid inputs surface MeetingsInputError (mapped to 400 by the transports)", async () => {
  const { service } = makeService(config(), { loadDayData: () => dayData() });
  await assert.rejects(() => service.meetingsList("2026-13-40"), MeetingsInputError);
  await assert.rejects(() => service.meetingsBuild("not-a-date"), MeetingsInputError);
  await assert.rejects(() => service.meetingsGet("not-a-meeting-id"), MeetingsInputError);
  await assert.rejects(() => service.meetingsGet("mtg-2026-13-40-abcdef01"), MeetingsInputError);
});

test("requestBuild + flush runs the debounced tail-step build when enabled", async () => {
  const { service, store } = makeService(config(), { loadDayData: () => dayData() });
  service.requestBuild(DATE);
  service.requestBuild(DATE); // coalesced
  await service.flushBuilds();
  assert.deepEqual(await store.listMeetingDates(), [DATE], "the coalesced tail-step build persisted the day");
  const summaries = await store.listMeetingSummaries(DATE);
  assert.equal(summaries.length, 1);
});
