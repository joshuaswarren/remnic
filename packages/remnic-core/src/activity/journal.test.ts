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

test("activity.timeline.journal source defaults to memoryDir with extraction off", () => {
  const journal = parseActivityConfig(undefined).timeline.journal;
  assert.deepEqual(journal, { enabled: false, source: "memoryDir", extractionMode: "off" });
});

const VAULT_OK = {
  enabled: true,
  vaultPath: "/vault",
  readback: { journalSection: "Journal" },
};

test("activity.timeline.journal vault mode parses with prerequisites satisfied", () => {
  const journal = parseActivityConfig({
    timeline: { journal: { enabled: true, source: "vault" }, vault: VAULT_OK },
  }).timeline.journal;
  assert.deepEqual(journal, { enabled: true, source: "vault", extractionMode: "off" });
});

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected parseActivityConfig to throw");
}

test("activity.timeline.journal vault mode names every missing prerequisite", () => {
  const err = captureError(() => parseActivityConfig({ timeline: { journal: { source: "vault" } } }));
  assert.ok(err instanceof RangeError);
  assert.match(err.message, /vault\.readback\.journalSection/);
});

test("activity.timeline.journal vault mode with only the section set still names vault.enabled and dailyNotePath", () => {
  const err = captureError(() =>
    parseActivityConfig({
      timeline: { journal: { source: "vault" }, vault: { readback: { journalSection: "Diary" } } },
    }),
  );
  assert.ok(err instanceof RangeError);
  assert.doesNotMatch(err.message, /journalSection/);
  assert.match(err.message, /vault\.enabled/);
});

test("activity.timeline.journal aliases source file to memoryDir", () => {
  const journal = parseActivityConfig({ timeline: { journal: { source: "file" } } }).timeline.journal;
  assert.equal(journal.source, "memoryDir");
});

test("activity.timeline.journal rejects an unknown source", () => {
  assert.throws(
    () => parseActivityConfig({ timeline: { journal: { source: "disk" } } }),
    /activity\.timeline\.journal\.source must be one of "memoryDir", "vault"/,
  );
});

test("activity.timeline.journal.heading fills vault.readback.journalSection when the new key is absent", () => {
  const vault = parseActivityConfig({
    timeline: { journal: { heading: "  Diary  " }, vault: { readback: { journalSection: "" } } },
  }).timeline.vault;
  assert.equal(vault.readback.journalSection, "Diary");
});

test("activity.timeline.vault.readback.journalSection wins over journal.heading", () => {
  const vault = parseActivityConfig({
    timeline: {
      journal: { heading: "Diary" },
      vault: { readback: { journalSection: "Journal" } },
    },
  }).timeline.vault;
  assert.equal(vault.readback.journalSection, "Journal");
});


test("activity.timeline.journal extractionMode allows off and review only", () => {
  for (const extractionMode of ["off", "review"]) {
    const journal = parseActivityConfig({
      timeline: { journal: { extractionMode } },
    }).timeline.journal;
    assert.equal(journal.extractionMode, extractionMode);
  }
  assert.throws(
    () => parseActivityConfig({ timeline: { journal: { extractionMode: "auto" } } }),
    /activity\.timeline\.journal\.extractionMode must be one of "off", "review"/,
  );
  assert.throws(
    () => parseActivityConfig({ timeline: { journal: { extractionMode: "smart" } } }),
    /activity\.timeline\.journal\.extractionMode must be one of "off", "review"/,
  );
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
