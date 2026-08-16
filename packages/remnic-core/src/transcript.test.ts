import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateTokenCount } from "./token-estimate.js";
import { TranscriptManager } from "./transcript.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    transcriptSkipChannelTypes: [],
  } as unknown as PluginConfig;
}

async function makeManager(): Promise<{ manager: TranscriptManager; memoryDir: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-transcript-recent-"));
  const manager = new TranscriptManager(makeConfig(memoryDir));
  await manager.initialize();
  return { manager, memoryDir };
}

function entryAt(timestamp: string, sessionKey: string, turnId: string): TranscriptEntry {
  return { timestamp, role: "user", content: `turn ${turnId}`, sessionKey, turnId };
}

test("formatForRecall counts transcript separators inside its token budget", () => {
  const manager = new TranscriptManager(makeConfig("/tmp/remnic-transcript-format-test"));
  const entries = ["one", "two", "three"].map((turnId) =>
    entryAt("2026-06-29T12:00:00.000Z", "agent:test-agent:main", turnId)
  );

  const formatted = manager.formatForRecall(entries, 23);

  assert.ok(estimateTokenCount(formatted) <= 23);
});
test("formatForRecall returns no content for zero or undersized budgets", () => {
  const manager = new TranscriptManager(makeConfig("/tmp/remnic-transcript-small-budget"));
  const entries = [
    {
      ...entryAt("2026-06-29T12:00:00.000Z", "agent:test-agent:main", "oversized"),
      content: "日本語".repeat(100),
    },
  ];

  assert.equal(manager.formatForRecall(entries, 0), "");
  assert.equal(manager.formatForRecall(entries, 10), "");
});
/**
 * Freeze `new Date()` / `Date.now()` to a fixed instant for the duration of `fn`.
 *
 * This lets a test seed a transcript entry whose timestamp is *exactly* the
 * instant the read observes as "now", deterministically reproducing the
 * millisecond-collision that the recent-window boundary fix targets.
 * Single-argument constructions (`new Date(isoString)`, `new Date(ms)`,
 * `new Date(otherDate)`) are forwarded unchanged so timestamp parsing still works.
 */
async function withFrozenNow<T>(now: Date, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = now.getTime();
  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedMs);
      } else if (args.length === 1) {
        super(args[0] as number);
      } else {
        super(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
          args[6] as number
        );
      }
    }
    static now(): number {
      return fixedMs;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}

test("readRecent (session fast path) returns a turn written at the same instant as the read", async () => {
  const { manager } = await makeManager();
  const sessionKey = "agent:test-agent:main";
  const now = new Date("2026-06-29T12:00:00.000Z");

  const entries = await withFrozenNow(now, async () => {
    // Seed an entry stamped at the exact instant the read observes as "now".
    await manager.append(entryAt(now.toISOString(), sessionKey, "boundary"));
    return manager.readRecent(48, sessionKey);
  });

  assert.equal(entries.length, 1, "just-written boundary entry should be included in last-N-hours read");
  assert.equal(entries[0].turnId, "boundary");
});

test("readRecent (full scan, no sessionKey) returns a turn written at the same instant as the read", async () => {
  const { manager } = await makeManager();
  const sessionKey = "agent:test-agent:main";
  const now = new Date("2026-06-29T12:00:00.000Z");

  const entries = await withFrozenNow(now, async () => {
    await manager.append(entryAt(now.toISOString(), sessionKey, "boundary"));
    return manager.readRecent(48);
  });

  assert.equal(entries.length, 1, "just-written boundary entry should be included in full-scan recent read");
  assert.equal(entries[0].turnId, "boundary");
});

test("readRange keeps an exclusive upper bound for caller-specified ranges", async () => {
  const { manager } = await makeManager();
  const sessionKey = "agent:test-agent:main";
  const start = "2026-06-29T00:00:00.000Z";
  const end = "2026-06-29T12:00:00.000Z";

  await manager.append(entryAt("2026-06-29T11:59:59.999Z", sessionKey, "inside"));
  await manager.append(entryAt(end, sessionKey, "at-end"));

  const exclusive = await manager.readRange(start, end, sessionKey);
  const ids = exclusive.map((e) => e.turnId);
  assert.deepEqual(ids, ["inside"], "explicit [start, end) range must exclude the entry at exactly end (rule #35)");
});
