import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { ExtractionResult } from "../types.js";
import { hashTranscriptBody, parseDayTranscript } from "./day-store.js";
import { saveCorrectionsFile } from "./corrections.js";
import type { WearableMemoryWriter } from "./memory-gen.js";
import {
  dateInTimezone,
  resolveSyncDates,
  syncWearableSource,
  type WearableSyncDeps,
} from "./pipeline.js";
import { loadSyncState } from "./sync-state.js";
import type {
  WearableConversation,
  WearableSourceConnector,
  WearableSourceSettings,
  WearablesConfig,
} from "./types.js";
import { defaultWearableSourceSettings, defaultWearablesConfig } from "./config.js";

const NOW = new Date("2026-06-11T03:00:00.000Z");

function settings(overrides: Partial<WearableSourceSettings> = {}): WearableSourceSettings {
  return { ...defaultWearableSourceSettings(), enabled: true, ...overrides };
}

function config(overrides: Partial<WearablesConfig> = {}): WearablesConfig {
  return {
    ...defaultWearablesConfig(),
    enabled: true,
    timezone: "UTC",
    ...overrides,
  };
}

function makeConversation(
  id: string,
  date: string,
  texts: Array<{ speaker: string; text: string; isWearer?: boolean }>,
): WearableConversation {
  return {
    id,
    source: "testsource",
    title: `Conversation ${id}`,
    startIso: `${date}T15:00:00.000Z`,
    endIso: `${date}T15:30:00.000Z`,
    segments: texts.map((entry) => ({
      speakerKey: entry.speaker,
      speakerName: entry.speaker,
      isWearer: entry.isWearer,
      text: entry.text,
    })),
  };
}

function fakeConnector(
  byDate: Record<string, WearableConversation[]>,
  nativeMemories: Array<{ id: string; content: string }> = [],
): WearableSourceConnector & { fetchCount: number } {
  const connector = {
    id: "testsource",
    displayName: "Test Source",
    fetchCount: 0,
    async verifyAuth() {
      return { ok: true };
    },
    async fetchConversations(opts: { date: string }) {
      connector.fetchCount += 1;
      return {
        conversations: byDate[opts.date] ?? [],
        nextCursor: null,
      };
    },
    async fetchNativeMemories() {
      return { memories: nativeMemories, nextCursor: null };
    },
  };
  return connector;
}

interface DayWrite {
  source: string;
  date: string;
  serialized: string;
}

function makeDeps(memoryDir: string): {
  deps: WearableSyncDeps;
  written: DayWrite[];
  reindexes: { count: number };
  memoryWrites: Array<{ category: string; content: string; options: Record<string, unknown> }>;
} {
  const written: DayWrite[] = [];
  const reindexes = { count: 0 };
  const memoryWrites: Array<{ category: string; content: string; options: Record<string, unknown> }> = [];
  const files = new Map<string, string>();
  const writer: WearableMemoryWriter = {
    async writeMemory(category, content, options) {
      memoryWrites.push({ category, content, options: options as Record<string, unknown> });
      return `mem-${memoryWrites.length}`;
    },
    async hasFactContentHash() {
      return false;
    },
  };
  const deps: WearableSyncDeps = {
    memoryDir,
    async readDayContentHash(sourceId, date) {
      const raw = files.get(`${sourceId}/${date}`);
      if (raw === undefined) return null;
      return parseDayTranscript(raw)?.meta.contentHash ?? null;
    },
    async writeDayTranscript(sourceId, date, serialized) {
      files.set(`${sourceId}/${date}`, serialized);
      written.push({ source: sourceId, date, serialized });
    },
    async afterTranscriptsWritten() {
      reindexes.count += 1;
    },
    memoryGen: {
      extract: async (): Promise<ExtractionResult> => ({
        facts: [
          {
            category: "fact",
            content: "The launch moved to September twelfth per the planning chat.",
            confidence: 0.9,
            tags: [],
          },
        ],
        profileUpdates: [],
        entities: [],
        questions: [],
      }),
      writer,
    },
    now: () => NOW,
  };
  return { deps, written, reindexes, memoryWrites };
}

test("dateInTimezone formats correctly across timezones", () => {
  const instant = new Date("2026-06-11T03:00:00.000Z");
  assert.equal(dateInTimezone(instant, "UTC"), "2026-06-11");
  // 03:00 UTC is still the previous day in Chicago (UTC-5 in June).
  assert.equal(dateInTimezone(instant, "America/Chicago"), "2026-06-10");
});

test("resolveSyncDates validates input and builds lookback windows", () => {
  assert.deepEqual(resolveSyncDates({ date: "2026-06-01" }, "UTC", NOW), ["2026-06-01"]);
  assert.deepEqual(resolveSyncDates({}, "UTC", NOW), ["2026-06-10", "2026-06-11"]);
  assert.deepEqual(resolveSyncDates({ days: 1 }, "UTC", NOW), ["2026-06-11"]);
  assert.throws(() => resolveSyncDates({ date: "junk" }, "UTC", NOW), /invalid date/);
  assert.throws(() => resolveSyncDates({ days: 0 }, "UTC", NOW), /invalid days/);
  assert.throws(() => resolveSyncDates({ days: 9000 }, "UTC", NOW), /invalid days/);
});

test("end-to-end sync: cleans, redacts, corrects, stores, extracts, reindexes, records state", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-pipeline-"));
  try {
    await saveCorrectionsFile(memoryDir, [{ match: "remnick", replace: "Remnic" }]);
    const connector = fakeConnector({
      "2026-06-11": [
        makeConversation("c1", "2026-06-11", [
          { speaker: "user", isWearer: true, text: "Um, I I told remnick my card is 4111 1111 1111 1111." },
          { speaker: "Speaker 2", text: "Got it, noted for the project plan we discussed." },
          { speaker: "Speaker 2", text: "zzzzzzzzzz" },
        ]),
      ],
    });
    const { deps, written, reindexes, memoryWrites } = makeDeps(memoryDir);
    const summary = await syncWearableSource(
      connector,
      settings({ memoryMode: "review" }),
      config(),
      { days: 1 },
      deps,
    );

    assert.equal(summary.conversations, 1);
    assert.equal(summary.segmentsKept, 2);
    assert.equal(summary.segmentsDropped, 1);
    assert.equal(summary.redactions, 1);
    assert.equal(summary.correctionsApplied, 1);
    assert.deepEqual(summary.transcriptsWritten, ["2026-06-11"]);
    assert.equal(reindexes.count, 1);

    assert.equal(written.length, 1);
    const parsed = parseDayTranscript(written[0].serialized);
    assert.ok(parsed);
    assert.match(parsed.body, /I told Remnic my card is \[redacted\]\./);
    assert.ok(!parsed.body.includes("4111"), "card number must not be stored");
    assert.ok(!parsed.body.includes("Um,"), "fillers are stripped");
    assert.ok(!parsed.body.includes("I I "), "stutters are collapsed");

    assert.equal(summary.memoriesCreated, 1);
    assert.equal(memoryWrites[0].options.status, "pending_review");

    const state = await loadSyncState(memoryDir);
    assert.equal(state.sources.testsource.lastDateSynced, "2026-06-11");
    assert.equal(
      state.sources.testsource.dayHashes["2026-06-11"],
      hashTranscriptBody(parsed.body),
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("unchanged days skip rewrite, reindex, and re-extraction; forceMemories re-extracts", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-pipeline-"));
  try {
    const byDate = {
      "2026-06-11": [
        makeConversation("c1", "2026-06-11", [
          { speaker: "user", isWearer: true, text: "We agreed the offsite happens in Austin this October." },
          { speaker: "Speaker 2", text: "Austin in October works for the whole team I think." },
        ]),
      ],
    };
    const { deps, written, reindexes, memoryWrites } = makeDeps(memoryDir);
    const run = () =>
      syncWearableSource(fakeConnector(byDate), settings(), config(), { days: 1 }, deps);

    const first = await run();
    assert.equal(first.transcriptsWritten.length, 1);
    assert.equal(first.memoriesCreated, 1);

    const second = await run();
    assert.equal(second.transcriptsWritten.length, 0, "unchanged day must not rewrite");
    assert.equal(second.memoriesCreated, 0, "unchanged day must not re-extract");
    assert.equal(written.length, 1);
    assert.equal(reindexes.count, 1);

    const third = await syncWearableSource(
      fakeConnector(byDate),
      settings(),
      config(),
      { days: 1, forceMemories: true },
      deps,
    );
    assert.equal(third.memoriesCreated, 1, "forceMemories re-runs extraction");
    assert.equal(memoryWrites.length, 2);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("memoryMode wanting extraction without an engine warns instead of failing", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-pipeline-"));
  try {
    const { deps } = makeDeps(memoryDir);
    deps.memoryGen = null;
    const summary = await syncWearableSource(
      fakeConnector({
        "2026-06-11": [
          makeConversation("c1", "2026-06-11", [
            { speaker: "user", isWearer: true, text: "A real conversation about the quarterly numbers happened." },
            { speaker: "Speaker 2", text: "Yes the numbers looked strong across all three regions." },
          ]),
        ],
      }),
      settings(),
      config(),
      { days: 1 },
      deps,
    );
    assert.equal(summary.transcriptsWritten.length, 1, "transcripts still sync");
    assert.equal(summary.memoriesCreated, 0);
    assert.ok(summary.warnings.some((warning) => warning.includes("no extraction engine")));
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("native memories import once and are tracked across syncs", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-pipeline-"));
  try {
    const native = [{ id: "nat-1", content: "User volunteers at the food bank monthly." }];
    const { deps, memoryWrites } = makeDeps(memoryDir);
    const run = () =>
      syncWearableSource(
        fakeConnector({}, native),
        settings({ importNativeMemories: "review" }),
        config(),
        { days: 1 },
        deps,
      );
    const first = await run();
    assert.equal(first.nativeMemoriesImported, 1);
    assert.equal(memoryWrites.length, 1);
    assert.equal(memoryWrites[0].options.status, "pending_review");

    const second = await run();
    assert.equal(second.nativeMemoriesImported, 0, "already-imported ids skip");
    assert.equal(memoryWrites.length, 1);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("a transcript write failure prevents the sync watermark from advancing", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-pipeline-"));
  try {
    const { deps } = makeDeps(memoryDir);
    deps.writeDayTranscript = async () => {
      throw new Error("disk full");
    };
    await assert.rejects(
      syncWearableSource(
        fakeConnector({
          "2026-06-11": [
            makeConversation("c1", "2026-06-11", [
              { speaker: "user", isWearer: true, text: "Something memorable happened today at the office." },
              { speaker: "Speaker 2", text: "It really did, everyone was talking about it after." },
            ]),
          ],
        }),
        settings(),
        config(),
        { days: 1 },
        deps,
      ),
      /disk full/,
    );
    const state = await loadSyncState(memoryDir);
    assert.equal(state.sources.testsource, undefined, "watermark must not advance");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
