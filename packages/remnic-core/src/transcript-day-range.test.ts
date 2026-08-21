/**
 * Tests for the CLI transcript day-view window helper `utcDayRange`.
 *
 * The `transcript --date <day>` and default "today" CLI views read a single
 * calendar day via {@link TranscriptManager.readRange}, which uses a half-open
 * `[start, end)` interval (`entryTime < end`, CLAUDE.md rule #35). The day end
 * must therefore be the NEXT day's `00:00:00Z`, not `${date}T23:59:59Z`:
 * a literal `23:59:59Z` end (== `.000Z`) silently drops any entry stamped in
 * the final second of the day (`23:59:59.000Z`–`23:59:59.999Z`).
 *
 * (Pre-existing boundary gap flagged as a P2 on PR #1507, fixed out of band.)
 */

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TranscriptManager, utcDayRange } from "./transcript.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
  // TranscriptManager only reads memoryDir + transcriptSkipChannelTypes.
  return {
    memoryDir,
    transcriptSkipChannelTypes: [],
  } as unknown as PluginConfig;
}

// On macOS `os.tmpdir()` is a `/var/folders/...` symlink to `/private/var/...`.
// Canonicalize the test root upfront (issue #691 symlink convention).
async function makeMemoryDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-tx-dayrange-")));
}

function entryAt(timestamp: string, turnId: string): TranscriptEntry {
  return {
    sessionKey: "agent:generalist:main",
    turnId,
    role: "user",
    content: `content-${turnId}`,
    timestamp,
  } as TranscriptEntry;
}

// ── utcDayRange: half-open [start, next-day-00:00:00Z) ───────────────────────

test("utcDayRange end is the next day's 00:00:00Z (half-open day window)", () => {
  assert.deepEqual(utcDayRange("2025-03-15"), {
    start: "2025-03-15T00:00:00Z",
    end: "2025-03-16T00:00:00Z",
  });
});

test("utcDayRange rolls over month boundaries", () => {
  assert.deepEqual(utcDayRange("2025-01-31"), {
    start: "2025-01-31T00:00:00Z",
    end: "2025-02-01T00:00:00Z",
  });
});

test("utcDayRange rolls over leap-day and year boundaries", () => {
  assert.deepEqual(utcDayRange("2024-02-28"), {
    start: "2024-02-28T00:00:00Z",
    end: "2024-02-29T00:00:00Z",
  });
  assert.deepEqual(utcDayRange("2025-12-31"), {
    start: "2025-12-31T00:00:00Z",
    end: "2026-01-01T00:00:00Z",
  });
});

// ── Day-view range includes the final second of the day (the bug fix) ────────

test("day-view range returns an entry stamped at 23:59:59.500Z of the queried day", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    const date = "2025-03-15";
    const channel = "agent:generalist:main";

    // Entry in the final second of the day — dropped by the old
    // `${date}T23:59:59Z` (== `.000Z`) exclusive upper bound.
    await tm.append(entryAt(`${date}T23:59:59.500Z`, "final-second"));
    // Midday control entry, comfortably inside the window.
    await tm.append(entryAt(`${date}T12:00:00.000Z`, "midday"));
    // Start-of-next-day entry must stay OUT — the upper bound is exclusive
    // (`[start, end)`, rule #35), so `nextDate T00:00:00.000Z` is not the
    // queried day.
    await tm.append(entryAt("2025-03-16T00:00:00.000Z", "next-day"));

    const { start, end } = utcDayRange(date);
    const entries = await tm.readRange(start, end, channel);
    const ids = entries.map((e) => e.turnId).sort();

    assert.deepEqual(ids, ["final-second", "midday"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
