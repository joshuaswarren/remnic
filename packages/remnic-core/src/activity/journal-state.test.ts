import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempDirSync } from "../testing/tmp-dir.js";
import {
  hashJournalText,
  journalUnchanged,
  readTimelineState,
  setJournalHash,
  timelineStatePath,
  writeTimelineState,
} from "./journal-state.js";

test("missing state file reads as empty", () => {
  withTempDirSync((dir)  => {
    assert.deepEqual(readTimelineState(dir), { version: 1, journal: {} });
  });
});

test("corrupt state file reads as empty and never blocks extraction", () => {
  withTempDirSync((dir)  => {
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(timelineStatePath(dir), "{not json");
    assert.deepEqual(readTimelineState(dir), { version: 1, journal: {} });
  });
});

test("non-string or empty hash entries are dropped on read", () => {
  withTempDirSync((dir)  => {
    writeTimelineState(dir, {
      version: 1,
      journal: { "2026-08-20": "abc", "2026-08-21": "", bad: 5 } as unknown as Record<string, string>,
    });
    const state = readTimelineState(dir);
    assert.deepEqual(state.journal, { "2026-08-20": "abc" });
  });
});

test("write is a durable round-trip through JSON on disk", () => {
  withTempDirSync((dir)  => {
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
