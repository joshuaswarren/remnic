/**
 * Unscoped `readRecent(hours)` (MCP recalls carry no sessionKey) parsed every
 * line of every daily file in the window plus one day of margin: ~614 MB on the
 * production store, ~7 s of main-thread work per recall (COS-666b). Appended
 * files hold entries in write order, so the recent window is a file's tail and a
 * file not modified since the window began holds nothing in it. These tests pin
 * that the result is unchanged and that the cost is bounded to the window.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TranscriptManager } from "./transcript.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const PAD = "x".repeat(2000);

function entry(turnId: string, timestampMs: number, content = `content-${turnId}`): TranscriptEntry {
  return { sessionKey: "agent:a:main", turnId, role: "user", content, timestamp: new Date(timestampMs).toISOString() } as TranscriptEntry;
}

async function writeFileOf(file: string, entries: TranscriptEntry[], mtimeMs?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  if (mtimeMs !== undefined) await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

async function withStore(run: (ctx: { root: string; manager: TranscriptManager; now: number }) => Promise<void>): Promise<void> {
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-tx-tail-")));
  try {
    const config = { memoryDir, transcriptSkipChannelTypes: [] } as unknown as PluginConfig;
    await run({ root: path.join(memoryDir, "transcripts"), manager: new TranscriptManager(config), now: Date.now() });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

function countParses<T>(fn: () => Promise<T>): Promise<{ result: T; parses: number }> {
  const real = JSON.parse;
  let parses = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return real(...args);
  }) as typeof JSON.parse;
  return fn().then(
    (result) => ({ result, parses }),
  ).finally(() => {
    JSON.parse = real;
  });
}

test("a file not modified since before the window (less an hour of skew) is not read", async () => {
  await withStore(async ({ root, manager, now }) => {
    const hours = 6;
    const start = now - hours * HOUR;
    const day = today(now);
    // Violates the append invariant on purpose (in-window entry, stale mtime) to pin the bound.
    await writeFileOf(path.join(root, "session/stale", `${day}.jsonl`), [entry("stale", now - 2 * HOUR)], start - 2 * HOUR);
    await writeFileOf(path.join(root, "session/skew", `${day}.jsonl`), [entry("skew", now - 2 * HOUR)], start - 30 * MIN);
    await writeFileOf(path.join(root, "session/live", `${day}.jsonl`), [entry("live", now - 1 * HOUR)], now);
    const ids = (await manager.readRecent(hours)).map((e) => e.turnId).sort();
    assert.deepEqual(ids, ["live", "skew"]);
    const full = (await manager.readRange(new Date(start).toISOString(), new Date(now + 1).toISOString(), undefined)).map((e) => e.turnId);
    assert.ok(full.includes("stale"), "an explicit range still reads every file");
  });
});

test("a large file is read from its tail: same entries as the full scan, a fraction of the parses", async () => {
  await withStore(async ({ root, manager, now }) => {
    const hours = 6;
    const start = now - hours * HOUR;
    // 3000 lines x ~2 KB = ~6 MB across several 1 MiB tail chunks; the last 40 are in the window.
    const lines: TranscriptEntry[] = [];
    for (let i = 0; i < 3000; i++) lines.push(entry(`t${i}`, i < 2960 ? start - 20 * HOUR + i * (19 * HOUR / 2960) : start + 10 * MIN + (i - 2960) * 5 * MIN, PAD));
    await writeFileOf(path.join(root, "session/big", `${today(now)}.jsonl`), lines, now);
    const startIso = new Date(start).toISOString();
    const endIso = new Date(now + 1).toISOString();
    const full = await manager.readRange(startIso, endIso, undefined);
    const { result: recent, parses } = await countParses(() => manager.readRecent(hours));
    assert.deepEqual(recent, full);
    assert.ok(recent.length > 0 && recent.length < 100, `window should hold a handful of turns, got ${recent.length}`);
    assert.ok(parses < 1000, `tail read must not parse the whole file, parsed ${parses}`);
  });
});

test("tail read tolerates out-of-order timestamps within the skew margin", async () => {
  await withStore(async ({ root, manager, now }) => {
    const hours = 6;
    const start = now - hours * HOUR;
    const lines: TranscriptEntry[] = [];
    for (let i = 0; i < 2500; i++) lines.push(entry(`o${i}`, start - 10 * HOUR + i * (9 * HOUR / 2500), PAD));
    // Out-of-order tail: an in-window entry written before an older out-of-window one.
    lines.push(entry("late-in", start + 5 * MIN, PAD), entry("early-out", start - 20 * MIN, PAD), entry("tail", now - 10 * MIN, PAD));
    await writeFileOf(path.join(root, "session/jitter", `${today(now)}.jsonl`), lines, now);
    const full = await manager.readRange(new Date(start).toISOString(), new Date(now + 1).toISOString(), undefined);
    assert.deepEqual(await manager.readRecent(hours), full);
    assert.ok(full.some((e) => e.turnId === "late-in"));
  });
});

test("a file smaller than one chunk, with a line spanning it, and malformed lines still round-trip", async () => {
  await withStore(async ({ root, manager, now }) => {
    const file = path.join(root, "session/small", `${today(now)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    const a = JSON.stringify(entry("a", now - HOUR));
    const huge = JSON.stringify(entry("huge", now - 30 * MIN, "é".repeat(700_000)));
    await writeFile(file, `${a}\nnot json\n${huge}\n${JSON.stringify(entry("z", now - 5 * MIN))}\n`, "utf-8");
    const ids = (await manager.readRecent(3)).map((e) => e.turnId);
    assert.deepEqual(ids, ["a", "huge", "z"]);
  });
});

async function seedManySessions(root: string, now: number): Promise<void> {
  const day = today(now);
  // 40 sessions x 600 lines x ~2 KB = ~48 MB. Each file's last entry is stamped at its mtime (the append invariant).
  for (let s = 0; s < 40; s++) {
    const mtime = now - (40 - s) * 10 * MIN;
    const lines: TranscriptEntry[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push({ ...entry(`s${s}-${i}`, mtime - 8 * HOUR + (i + 1) * (8 * HOUR / 600) - s * 7, PAD), sessionKey: `agent:${s}:main` } as TranscriptEntry);
    }
    await writeFileOf(path.join(root, `session/s${s}`, `${day}.jsonl`), lines, mtime);
  }
}

test("readRecent(hours, undefined, N) equals the last N of the full window, reading a fraction of it", async () => {
  await withStore(async ({ root, manager, now }) => {
    await seedManySessions(root, now);
    const hours = 12;
    const full = await manager.readRange(new Date(now - hours * HOUR).toISOString(), new Date(now + 1).toISOString(), undefined);
    for (const n of [1, 50, 700]) {
      const { result, parses } = await countParses(() => manager.readRecent(hours, undefined, n));
      assert.deepEqual(result.map((e) => e.turnId), full.slice(-n).map((e) => e.turnId), `last ${n}`);
      if (n <= 50) assert.ok(parses < 3000, `last ${n} must not parse the window (${full.length} entries), parsed ${parses}`);
    }
  });
});

test("readRecent(hours, undefined, N) with fewer than N entries returns them all", async () => {
  await withStore(async ({ root, manager, now }) => {
    await writeFileOf(path.join(root, "session/one", `${today(now)}.jsonl`), [entry("a", now - 3 * HOUR), entry("b", now - HOUR)], now);
    assert.deepEqual((await manager.readRecent(12, undefined, 50)).map((e) => e.turnId), ["a", "b"]);
  });
});
