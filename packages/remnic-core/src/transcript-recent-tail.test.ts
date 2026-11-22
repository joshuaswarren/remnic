
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { parseConfig } from "./config.js";
import { TranscriptManager } from "./transcript.js";
import type { TranscriptEntry } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const PAD = "x".repeat(2000);

function entry(turnId: string, timestampMs: number, content = `content-${turnId}`): TranscriptEntry {
  return { sessionKey: "agent:a:main", turnId, role: "user", content, timestamp: new Date(timestampMs).toISOString() };
}

async function writeFileOf(file: string, entries: TranscriptEntry[], mtimeMs?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  if (mtimeMs !== undefined) await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

async function withStore(run: (ctx: { root: string; manager: TranscriptManager; now: number }) => Promise<void>): Promise<void> {
  const memoryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-tx-tail-")));
  try {
    const config = parseConfig({ memoryDir, transcriptSkipChannelTypes: [] });
    await run({ root: path.join(memoryDir, "transcripts"), manager: new TranscriptManager(config), now: Date.now() });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

async function countParses<T>(fn: () => Promise<T>): Promise<{ result: T; parses: number }> {
  const spy = mock.method(JSON, "parse");
  try {
    const result = await fn();
    return { result, parses: spy.mock.callCount() };
  } finally {
    spy.mock.restore();
  }
}

test("a file not modified since before the window (less an hour of skew) is not read", async () => {
  await withStore(async ({ root, manager, now }) => {
    const hours = 6;
    const start = now - hours * HOUR;
    const day = today(now);
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
  for (let s = 0; s < 40; s++) {
    const mtime = now - (40 - s) * 10 * MIN;
    const lines: TranscriptEntry[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push({ ...entry(`s${s}-${i}`, mtime - 8 * HOUR + (i + 1) * (8 * HOUR / 600) - s * 7, PAD), sessionKey: `agent:${s}:main` });
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
      if (n <= 50) assert.ok(parses < 700, `last ${n} must not parse the window (${full.length} entries), parsed ${parses}`);
    }
  });
});

test("readRecent(hours, undefined, N) with fewer than N entries returns them all", async () => {
  await withStore(async ({ root, manager, now }) => {
    await writeFileOf(path.join(root, "session/one", `${today(now)}.jsonl`), [entry("a", now - 3 * HOUR), entry("b", now - HOUR)], now);
    assert.deepEqual((await manager.readRecent(12, undefined, 50)).map((e) => e.turnId), ["a", "b"]);
  });
});

test("bad lines among a file's newest do not shrink the newest-N result", async () => {
  await withStore(async ({ root, manager, now }) => {
    const file = path.join(root, "session/bad", `${today(now)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(JSON.stringify(entry(`v${i}`, now - 5 * HOUR + i * MIN)));
    lines.splice(58, 0, "not json");
    lines.push(JSON.stringify({ sessionKey: "k", turnId: "no-ts", role: "user", content: "x" }));
    lines.push(JSON.stringify(entry("future", now + 2 * HOUR)));
    await writeFile(file, `${lines.join("\n")}\n{"sessionKey":"agent:a:main","turnId":"torn","ti`, "utf-8");
    for (const n of [1, 50]) {
      const want = (await manager.readRecent(12)).slice(-n).map((e) => e.turnId);
      const got = (await manager.readRecent(12, undefined, n)).map((e) => e.turnId);
      assert.equal(got.length, n, `last ${n}`);
      assert.deepEqual(got, want, `last ${n}`);
    }
  });
});

test("newest-N does not read a file modified too long ago to hold a newer entry", async () => {
  await withStore(async ({ root, manager, now }) => {
    const recent: TranscriptEntry[] = [];
    for (let i = 0; i < 60; i++) recent.push(entry(`r${i}`, now - (61 - i) * MIN));
    await writeFileOf(path.join(root, "session/live", `${today(now)}.jsonl`), recent, now);
    await writeFileOf(path.join(root, "session/stale", `${today(now)}.jsonl`), [entry("stale-newer", now - 30_000)], now - 5 * HOUR);
    const ids = (await manager.readRecent(12, undefined, 50)).map((e) => e.turnId);
    assert.equal(ids.length, 50);
    assert.ok(!ids.includes("stale-newer"));
  });
});

const ids = (entries: TranscriptEntry[]): string[] => entries.map((e) => e.turnId);

test("blank lines among a file's newest do not shrink the newest-N result", async () => {
  await withStore(async ({ root, manager, now }) => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify(entry(`t${i}`, now - 10 * HOUR + i * 2 * MIN, "y".repeat(40_000))));
      if (i >= 170 && i % 2 === 0) lines.push(""); // 15 blanks among the newest 30
    }
    const file = path.join(root, "session/blank", `${today(now)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
    const got = await manager.readRecent(12, undefined, 50);
    assert.equal(got.length, 50);
    assert.deepEqual(ids(got), ids(await manager.readRecent(12)).slice(-50));
  });
});

test("a tail chunk holding exactly N lines is not mistaken for the whole window", async () => {
  await withStore(async ({ root, manager, now }) => {
    const lineBytes = 5300;
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `f${String(i).padStart(4, "0")}`;
      const pad = lineBytes - 1 - JSON.stringify(entry(id, 0, "")).length;
      lines.push(JSON.stringify(entry(id, now - 8 * HOUR + i * 2 * MIN, "p".repeat(pad))));
    }
    const file = path.join(root, "session/exact", `${today(now)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
    const got = await manager.readRecent(12, undefined, 50);
    assert.equal(got.length, 50);
    assert.deepEqual(ids(got), ids(await manager.readRecent(12)).slice(-50));
  });
});

test("newest-N leaves out entries stamped before the window even when they sit in a file's tail", async () => {
  await withStore(async ({ root, manager, now }) => {
    const inWindow: TranscriptEntry[] = [];
    for (let i = 0; i < 20; i++) inWindow.push(entry(`in${i}`, now - HOUR + i * MIN));
    const old: TranscriptEntry[] = [];
    for (let i = 0; i < 30; i++) old.push(entry(`old${i}`, now - 20 * HOUR + i * MIN));
    await writeFileOf(path.join(root, "session/mixed", `${today(now)}.jsonl`), [...inWindow, ...old], now);
    assert.deepEqual(ids(await manager.readRecent(6, undefined, 50)), ids(inWindow));
  });
});

test("maxEntries that is not a positive integer falls back to the full window", async () => {
  await withStore(async ({ root, manager, now }) => {
    const all: TranscriptEntry[] = [];
    for (let i = 0; i < 8; i++) all.push(entry(`e${i}`, now - HOUR + i * MIN));
    await writeFileOf(path.join(root, "session/guard", `${today(now)}.jsonl`), all, now);
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      assert.deepEqual(ids(await manager.readRecent(6, undefined, bad)), ids(all), `maxEntries ${bad}`);
    }
    assert.deepEqual(ids(await manager.readRecent(6, undefined, 3)), ["e5", "e6", "e7"]);
  });
});

test("a short read skips that file rather than returning a gap", async (t) => {
  await withStore(async ({ root, manager, now }) => {
    await writeFileOf(path.join(root, "session/short", `${today(now)}.jsonl`), [entry("s1", now - 2 * HOUR), entry("s2", now - HOUR)], now);
    await writeFileOf(path.join(root, "session/whole", `${today(now)}.jsonl`), [entry("w1", now - 90 * MIN)], now);
    const realOpen = fsp.open;
    t.mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
      const fh = await realOpen(...args);
      if (!String(args[0]).includes("/short/")) return fh;
      const realRead = fh.read.bind(fh);
      Object.defineProperty(fh, "read", {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const r = await realRead(buffer, offset, length, position);
          return { buffer: r.buffer, bytesRead: r.bytesRead - 1 };
        },
      });
      return fh;
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(ids(await manager.readRecent(6, undefined, 50)), ["w1"]);
      assert.deepEqual(ids(await manager.readRecent(6)), ["w1"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("a missing transcripts directory reads as empty", async () => {
  await withStore(async ({ manager }) => {
    assert.deepEqual(await manager.readRecent(6, undefined, 50), []);
    assert.deepEqual(await manager.readRecent(6), []);
  });
});

test("unreadable and unstatable files do not hide the readable ones", async () => {
  await withStore(async ({ root, manager, now }) => {
    const day = today(now);
    await writeFileOf(path.join(root, "session/good", `${day}.jsonl`), [entry("g1", now - HOUR)], now);
    await mkdir(path.join(root, "session/isdir", `${day}.jsonl`), { recursive: true });
    await mkdir(path.join(root, "session/dangling"), { recursive: true });
    await symlink(path.join(root, "nowhere"), path.join(root, "session/dangling", `${day}.jsonl`));
    assert.deepEqual(ids(await manager.readRecent(6, undefined, 50)), ["g1"]);
    assert.deepEqual(ids(await manager.readRecent(6)), ["g1"]);
  });
});

test("an unreadable channel or channel-type directory is skipped", { skip: process.getuid?.() === 0 && "root ignores directory modes" }, async () => {
  await withStore(async ({ root, manager, now }) => {
    const day = today(now);
    await writeFileOf(path.join(root, "session/good", `${day}.jsonl`), [entry("g1", now - HOUR)], now);
    await writeFileOf(path.join(root, "session/locked", `${day}.jsonl`), [entry("hidden1", now - HOUR)], now);
    await writeFileOf(path.join(root, "lockedtype/chan", `${day}.jsonl`), [entry("hidden2", now - HOUR)], now);
    await chmod(path.join(root, "session/locked"), 0o000);
    await chmod(path.join(root, "lockedtype"), 0o000);
    try {
      assert.deepEqual(ids(await manager.readRecent(6, undefined, 50)), ["g1"]);
      assert.deepEqual(ids(await manager.readRecent(6)), ["g1"]);
    } finally {
      await chmod(path.join(root, "session/locked"), 0o755);
      await chmod(path.join(root, "lockedtype"), 0o755);
    }
  });
});

test("blank lines at the end of a file do not shrink the newest-N result", async () => {
  await withStore(async ({ root, manager, now }) => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `f${String(i).padStart(4, "0")}`;
      const pad = 5300 - 1 - JSON.stringify(entry(id, 0, "")).length;
      lines.push(JSON.stringify(entry(id, now - 8 * HOUR + i * 2 * MIN, "p".repeat(pad))));
    }
    const file = path.join(root, "session/trailing", `${today(now)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n\n\n\n\n`, "utf-8");
    const got = await manager.readRecent(12, undefined, 50);
    assert.equal(got.length, 50);
    assert.deepEqual(ids(got), ids(await manager.readRecent(12)).slice(-50));
  });
});

test("a row with a null timestamp at a chunk boundary does not stop the tail scan early", async () => {
  await withStore(async ({ root, manager, now }) => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `f${String(i).padStart(4, "0")}`;
      const stamped = (content: string) => {
        const e = entry(id, now - 8 * HOUR + i * 2 * MIN, content);
        return i === 51 ? { ...e, timestamp: null } : e;
      };
      const pad = 5300 - 1 - JSON.stringify(stamped("")).length;
      lines.push(JSON.stringify(stamped("p".repeat(pad))));
    }
    const file = path.join(root, "session/nulls", `${today(now)}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
    const got = await manager.readRecent(12, undefined, 50);
    assert.equal(got.length, 50);
    assert.deepEqual(ids(got), ids(await manager.readRecent(12)).slice(-50));
  });
});
