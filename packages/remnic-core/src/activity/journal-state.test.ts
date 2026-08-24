import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withTempDir, withTempDirSync } from "../testing/tmp-dir.js";
import {
  hashJournalText,
  journalUnchanged,
  readTimelineState,
  setJournalHash,
  timelineStatePath,
  writeTimelineState,
} from "./journal-state.js";

const require = createRequire(import.meta.url);

test("missing state file reads as empty", () => {
  withTempDirSync((dir) => {
    assert.deepEqual(readTimelineState(dir), { version: 1, journal: {} });
  });
});

test("corrupt state file reads as empty and never blocks extraction", () => {
  withTempDirSync((dir) => {
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(timelineStatePath(dir), "{not json");
    assert.deepEqual(readTimelineState(dir), { version: 1, journal: {} });
  });
});

test("non-string or empty hash entries are dropped on read", () => {
  withTempDirSync((dir) => {
    writeTimelineState(dir, {
      version: 1,
      journal: { "2026-08-20": "abc", "2026-08-21": "", bad: 5 } as unknown as Record<string, string>,
    });
    const state = readTimelineState(dir);
    assert.deepEqual(state.journal, { "2026-08-20": "abc" });
  });
});

test("write is a durable round-trip through JSON on disk", () => {
  withTempDirSync((dir) => {
    const state = setJournalHash({ version: 1, journal: {} }, "2026-08-20", hashJournalText("day one"));
    writeTimelineState(dir, state);
    assert.equal(readFileSync(timelineStatePath(dir), "utf8"), `${JSON.stringify(state, null, 2)}\n`);
    assert.deepEqual(readTimelineState(dir), state);
  });
});

test("journalUnchanged is true only for identical post-strip text", () => {
  const state = setJournalHash({ version: 1, journal: {} }, "2026-08-20", hashJournalText("text"));
  assert.equal(journalUnchanged(state, "2026-08-20", "text"), true);
  assert.equal(journalUnchanged(state, "2026-08-20", "text "), false);
  assert.equal(journalUnchanged(state, "2026-08-20", "edited"), false);
  assert.equal(journalUnchanged(state, "2026-08-21", "text"), false);
  assert.equal(journalUnchanged({ version: 1, journal: {} }, "2026-08-20", "text"), false);
});

test("setJournalHash is pure — the input state object is not mutated", () => {
  const original = { version: 1, journal: {} } as const;
  const next = setJournalHash(original, "2026-08-20", "h");
  assert.deepEqual(original.journal, {});
  assert.deepEqual(next.journal, { "2026-08-20": "h" });
});

test("hashJournalText is deterministic and content-sensitive", () => {
  assert.equal(hashJournalText("a"), hashJournalText("a"));
  assert.notEqual(hashJournalText("a"), hashJournalText("b"));
  assert.match(hashJournalText("a"), /^[0-9a-f]{64}$/);
});

test("writeTimelineState uses a unique temp path then rename", () => {
  withTempDirSync((dir) => {
    const first = setJournalHash({ version: 1, journal: {} }, "2026-08-20", hashJournalText("a"));
    writeTimelineState(dir, first);
    const second = setJournalHash(first, "2026-08-21", hashJournalText("b"));
    writeTimelineState(dir, second);
    assert.deepEqual(readTimelineState(dir), second);
    assert.match(readFileSync(timelineStatePath(dir), "utf8"), /2026-08-21/);
  });
});

function runLockWorker(env: Record<string, string>): Promise<void> {
  const tsxCli = require.resolve("tsx/cli");
  const worker = fileURLToPath(new URL("./journal-state.lock-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, worker], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lock worker exited ${code}: ${stderr}`));
    });
  });
}

test("two processes extracting the same date produce one candidate", async () => {
  await withTempDir(async (dir) => {
    const marker = path.join(dir, "candidates");
    writeFileSync(marker, "");
    const env = {
      JOURNAL_LOCK_DIR: dir,
      JOURNAL_LOCK_DATE: "2026-08-20",
      JOURNAL_LOCK_TEXT: "same day body",
      JOURNAL_LOCK_MARKER: marker,
    };
    await Promise.all([runLockWorker(env), runLockWorker(env)]);
    assert.equal(readFileSync(marker, "utf8"), "1");
  });
});

test("different dates extract concurrently without sharing a lock", async () => {
  await withTempDir(async (dir) => {
    const marker = path.join(dir, "candidates");
    writeFileSync(marker, "");
    await Promise.all([
      runLockWorker({
        JOURNAL_LOCK_DIR: dir,
        JOURNAL_LOCK_DATE: "2026-08-20",
        JOURNAL_LOCK_TEXT: "day a",
        JOURNAL_LOCK_MARKER: marker,
      }),
      runLockWorker({
        JOURNAL_LOCK_DIR: dir,
        JOURNAL_LOCK_DATE: "2026-08-21",
        JOURNAL_LOCK_TEXT: "day b",
        JOURNAL_LOCK_MARKER: marker,
      }),
    ]);
    assert.equal(readFileSync(marker, "utf8"), "11");
  });
});
