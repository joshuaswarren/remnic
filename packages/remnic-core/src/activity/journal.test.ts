import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isSearchExcludedPath } from "../orchestration/generic-recall-paths.js";
import { ALL_CATEGORY_DIRS, RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { parseActivityConfig } from "./config.js";
import { isJournalDayPath, journalPath, seedJournal } from "./journal.js";

const DATE = "2026-08-17";

function withMemoryDir(fn: (memoryDir: string) => void): void {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-"));
  try {
    fn(memoryDir);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

test("activity.timeline.journal.enabled defaults off", () => {
  assert.equal(parseActivityConfig(undefined).timeline.journal.enabled, false);
  assert.equal(
    parseActivityConfig({ timeline: { journal: { enabled: true } } }).timeline.journal.enabled,
    true,
  );
  assert.throws(
    () => parseActivityConfig({ timeline: { journal: "on" } }),
    /activity\.timeline\.journal must be an object/,
  );
});

test("activity.timeline.journal source defaults to file with no heading", () => {
  const journal = parseActivityConfig(undefined).timeline.journal;
  assert.equal(journal.source, "file");
  assert.equal(journal.heading, undefined);
});

test("activity.timeline.journal vault mode trims and stores the heading", () => {
  const journal = parseActivityConfig({ timeline: { journal: { enabled: true, source: "vault", heading: " Journal " } } }).timeline.journal;
  assert.deepEqual(journal, { enabled: true, source: "vault", heading: "Journal" });
});

test("activity.timeline.journal vault mode requires a non-empty heading", () => {
  for (const heading of [undefined, "", "   "]) {
    assert.throws(
      () => parseActivityConfig({ timeline: { journal: { source: "vault", heading } } }),
      RangeError,
    );
  }
});

test("activity.timeline.journal rejects an unknown source", () => {
  assert.throws(
    () => parseActivityConfig({ timeline: { journal: { source: "memoryDir" } } }),
    /activity\.timeline\.journal\.source must be one of "file", "vault"/,
  );
});

test("activity.timeline.journal rejects a non-string heading", () => {
  assert.throws(
    () => parseActivityConfig({ timeline: { journal: { heading: 5 } } }),
    /activity\.timeline\.journal\.heading must be a string/,
  );
});

test("activity.timeline.journal file mode ignores a provided heading", () => {
  const journal = parseActivityConfig({ timeline: { journal: { source: "file", heading: "Ignored" } } }).timeline.journal;
  assert.deepEqual(journal, { enabled: false, source: "file" });
  assert.equal("heading" in journal, false);
});

test("seed is a hard no-op without force", () => {
  withMemoryDir((memoryDir) => {
    const first = seedJournal({
      memoryDir,
      date: DATE,
      cards: [{ title: "Write seed", startUtc: "2026-08-17T14:00:00.000Z", endUtc: "2026-08-17T14:45:00.000Z" }],
    });
    assert.equal(first.wrote, true);
    assert.equal(first.path, journalPath(memoryDir, DATE));
    const original = readFileSync(first.path);
    const second = seedJournal({
      memoryDir,
      date: DATE,
      cards: [{ title: "Different card", startUtc: "2026-08-17T15:00:00.000Z", endUtc: "2026-08-17T16:00:00.000Z" }],
    });
    assert.equal(second.wrote, false);
    assert.deepEqual(readFileSync(second.path), original);
  });
});

test("seed with force overwrites the existing file", () => {
  withMemoryDir((memoryDir) => {
    seedJournal({ memoryDir, date: DATE });
    const original = readFileSync(journalPath(memoryDir, DATE), "utf8");
    const forced = seedJournal({
      memoryDir,
      date: DATE,
      force: true,
      cards: [{ title: "Forced rewrite", startUtc: "2026-08-17T10:00:00.000Z", endUtc: "2026-08-17T11:30:00.000Z" }],
    });
    assert.equal(forced.wrote, true);
    const next = readFileSync(forced.path, "utf8");
    assert.notEqual(next, original);
    assert.match(next, /# Journal — 2026-08-17/);
    assert.match(next, /## Day at a glance/);
    assert.match(next, /- 90m Forced rewrite/);
    assert.match(next, /## Notes/);
  });
});

test("journal day files sit outside scan roots and generic search", () => {
  assert.equal(ALL_CATEGORY_DIRS.includes("journal"), false);
  assert.equal(RECALL_FALLBACK_DIRS.includes("journal"), false);
  assert.equal(isJournalDayPath("journal/2026-08-17.md"), true);
  assert.equal(
    isJournalDayPath("facts/journal/2026-08-17.md", "/tmp/remnic-fixture-memory"),
    false,
    "nested stays recallable",
  );
  assert.equal(isSearchExcludedPath("journal/2026-08-17.md"), true);
  assert.equal(
    isSearchExcludedPath("facts/journal/2026-08-17.md", { memoryDir: "/tmp/remnic-fixture-memory" }),
    false,
  );

  withMemoryDir((memoryDir) => {
    const result = seedJournal({ memoryDir, date: DATE });
    const relative = path.relative(memoryDir, result.path).replace(/\\/g, "/");
    assert.equal(relative, "journal/2026-08-17.md");
    assert.equal(isSearchExcludedPath(relative), true);
    assert.equal(isSearchExcludedPath(result.path, { memoryDir }), true);
  });
});
