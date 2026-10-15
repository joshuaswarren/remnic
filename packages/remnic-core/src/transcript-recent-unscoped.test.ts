/**
 * `readRecent(hours)` without a sessionKey used to read and JSON.parse every
 * transcript file ever written, which stalled the recall `transcript` section
 * for tens of seconds on a large store. It now skips daily files older than the
 * window (less one day for clock skew). These tests pin that the result is the
 * same as the full scan, and where the documented bound sits.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TranscriptManager } from "./transcript.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeConfig(memoryDir: string): PluginConfig {
  return { memoryDir, transcriptSkipChannelTypes: [] } as unknown as PluginConfig;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function writeLines(file: string, entries: TranscriptEntry[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function entry(sessionKey: string, turnId: string, timestampMs: number): TranscriptEntry {
  return {
    sessionKey,
    turnId,
    role: "user",
    content: `content-${turnId}`,
    timestamp: new Date(timestampMs).toISOString(),
  } as TranscriptEntry;
}

async function withStore(run: (ctx: { root: string; manager: TranscriptManager; now: number }) => Promise<void>): Promise<void> {
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-tx-unscoped-")));
  try {
    await run({ root: path.join(memoryDir, "transcripts"), manager: new TranscriptManager(makeConfig(memoryDir)), now: Date.now() });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

// Files are named for the date they were written on, entries are written at or
// after their own timestamp: so a file dated D holds entries stamped <= end of D.
async function seedStandardStore(root: string, now: number): Promise<void> {
  const a = "agent:a:main";
  const b = "agent:b:main";
  await writeLines(path.join(root, "session/aaa", `${utcDate(now)}.jsonl`), [entry(a, "a1", now - 40 * 60_000), entry(a, "a2", now - 3 * HOUR)]);
  await writeLines(path.join(root, "session/aaa", `${utcDate(now - DAY)}.jsonl`), [entry(a, "a3", now - 26 * HOUR), entry(a, "a4", now - 30 * HOUR)]);
  await writeLines(path.join(root, "session/aaa", `${utcDate(now - 5 * DAY)}.jsonl`), [entry(a, "a5", now - 5 * DAY)]);
  await writeLines(path.join(root, "session/bbb", `${utcDate(now)}.jsonl`), [entry(b, "b1", now - 2 * HOUR)]);
  await writeLines(path.join(root, "session/bbb", `${utcDate(now - 40 * DAY)}.jsonl`), [entry(b, "b2", now - 40 * DAY)]);
  await writeLines(path.join(root, "discord/chan1", `${utcDate(now - DAY)}.jsonl`), [entry("discord:chan1", "d1", now - 13 * HOUR)]);
  // Files without a daily date name can never be pruned by date.
  await writeLines(path.join(root, "legacy-flat.jsonl"), [entry("legacy", "l1", now - 90 * 60_000), entry("legacy", "l2", now - 90 * DAY)]);
  await writeLines(path.join(root, "session/aaa", "notes.jsonl"), [entry(a, "n1", now - 4 * HOUR)]);
}

function window(now: number, hours: number): { startIso: string; endIso: string } {
  return { startIso: new Date(now - hours * HOUR).toISOString(), endIso: new Date(now + 1).toISOString() };
}

test("unscoped readRecent returns exactly what the full scan returns, for every window size", async () => {
  await withStore(async ({ root, manager, now }) => {
    await seedStandardStore(root, now);
    for (const hours of [1, 6, 12, 36, 24 * 7, 24 * 400]) {
      const { startIso, endIso } = window(now, hours);
      const full = await manager.readRange(startIso, endIso, undefined);
      const recent = await manager.readRecent(hours);
      assert.deepEqual(recent, full, `${hours}h window must match the full scan`);
      assert.ok(recent.length > 0, `${hours}h window should not be empty`);
    }
    // Sanity on the fixture itself: the 12h window holds the in-window turns
    // from dated files, the legacy flat file and the non-date-named file (d1 is
    // 13h old and a3 is 26h old, so both are outside it).
    const ids = (await manager.readRecent(12)).map((e) => e.turnId).sort();
    assert.deepEqual(ids, ["a1", "a2", "b1", "l1", "n1"]);
    const wide = (await manager.readRecent(36)).map((e) => e.turnId).sort();
    assert.deepEqual(wide, ["a1", "a2", "a3", "a4", "b1", "d1", "l1", "n1"]);
  });
});

test("readRecent skips daily files older than the window, but reads the one-day margin and non-date names", async () => {
  await withStore(async ({ root, manager, now }) => {
    await seedStandardStore(root, now);
    const hours = 6;
    const start = now - hours * HOUR;
    // Violates the write-time invariant on purpose: an in-window entry stored in
    // files whose names are older than the window. These pin the pruning bound.
    await writeLines(path.join(root, "session/zzz", `${utcDate(start - DAY)}.jsonl`), [entry("agent:z:main", "inside-margin", now - 2 * HOUR)]);
    await writeLines(path.join(root, "session/yyy", `${utcDate(start - 2 * DAY)}.jsonl`), [entry("agent:y:main", "outside-margin", now - 2 * HOUR)]);

    const { startIso, endIso } = window(now, hours);
    const full = (await manager.readRange(startIso, endIso, undefined)).map((e) => e.turnId);
    const recent = (await manager.readRecent(hours)).map((e) => e.turnId);
    assert.ok(full.includes("inside-margin") && full.includes("outside-margin"), "the full scan reads every file");
    assert.ok(recent.includes("inside-margin"), "a file dated one day before the window start is still read");
    assert.ok(!recent.includes("outside-margin"), "a file dated two days before the window start is skipped");
    // A window wide enough to cover that date reads it again.
    const wide = (await manager.readRecent(24 * 3)).map((e) => e.turnId);
    assert.ok(wide.includes("outside-margin"));
  });
});

test("readRange without a cutoff keeps scanning every file", async () => {
  await withStore(async ({ root, manager, now }) => {
    await seedStandardStore(root, now);
    const all = await manager.readRange(new Date(now - 400 * DAY).toISOString(), new Date(now + 1).toISOString(), undefined);
    assert.ok(all.some((e) => e.turnId === "b2"), "40-day-old file is still read by an explicit range");
    assert.ok(all.some((e) => e.turnId === "l2"), "90-day-old entry in the legacy file is still read");
  });
});
