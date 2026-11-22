
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TranscriptManager, utcDayRange } from "./transcript.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
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


test("day-view range returns an entry stamped at 23:59:59.500Z of the queried day", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    const date = "2025-03-15";
    const channel = "agent:generalist:main";

    await tm.append(entryAt(`${date}T23:59:59.500Z`, "final-second"));
    await tm.append(entryAt(`${date}T12:00:00.000Z`, "midday"));
    await tm.append(entryAt("2025-03-16T00:00:00.000Z", "next-day"));

    const { start, end } = utcDayRange(date);
    const entries = await tm.readRange(start, end, channel);
    const ids = entries.map((e) => e.turnId).sort();

    assert.deepEqual(ids, ["final-second", "midday"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
