import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { journalPath } from "../journal.js";
import { persistDeterministicJournal } from "./journal-recap-persist.js";
import { renderDeterministicJournal } from "./journal-recap.js";
import type { TimelineCard } from "./types.js";

const DATE = "2026-08-17";
const TZ = "UTC";

function card(
  overrides: Partial<TimelineCard> & Pick<TimelineCard, "id" | "startUtc" | "endUtc">,
): TimelineCard {
  return {
    kind: "activity",
    title: "Untitled",
    summary: "none",
    categoryId: "development",
    confidence: 1,
    dayKey: DATE,
    timezone: TZ,
    machine: "ws-a",
    evidenceIds: [],
    evidenceRange: null,
    ...overrides,
  };
}

function activityCards(): TimelineCard[] {
  return [
    card({
      id: "act-1",
      title: "Terminal",
      startUtc: "2026-08-17T14:00:00.000Z",
      endUtc: "2026-08-17T15:30:00.000Z",
    }),
  ];
}

function otherCards(): TimelineCard[] {
  return [
    card({
      id: "act-2",
      title: "Browser",
      startUtc: "2026-08-17T16:00:00.000Z",
      endUtc: "2026-08-17T17:00:00.000Z",
    }),
  ];
}

function withMemoryDir(fn: (memoryDir: string) => void): void {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-recap-persist-"));
  try {
    fn(memoryDir);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

test("persist is a hard no-op without force", () => {
  withMemoryDir((memoryDir) => {
    const first = persistDeterministicJournal({
      memoryDir,
      date: DATE,
      cards: activityCards(),
      timezone: TZ,
    });
    assert.equal(first.wrote, true);
    assert.equal(first.path, journalPath(memoryDir, DATE));
    const original = readFileSync(first.path);
    assert.equal(
      original.toString("utf8"),
      renderDeterministicJournal(activityCards(), { date: DATE, timezone: TZ }),
    );

    const second = persistDeterministicJournal({
      memoryDir,
      date: DATE,
      cards: otherCards(),
      timezone: TZ,
    });
    assert.equal(second.wrote, false);
    assert.equal(second.path, first.path);
    assert.deepEqual(readFileSync(second.path), original);
  });
});

test("persist with force overwrites the existing file", () => {
  withMemoryDir((memoryDir) => {
    persistDeterministicJournal({
      memoryDir,
      date: DATE,
      cards: activityCards(),
      timezone: TZ,
    });
    const original = readFileSync(journalPath(memoryDir, DATE), "utf8");
    const forced = persistDeterministicJournal({
      memoryDir,
      date: DATE,
      cards: otherCards(),
      timezone: TZ,
      force: true,
    });
    assert.equal(forced.wrote, true);
    const next = readFileSync(forced.path, "utf8");
    assert.notEqual(next, original);
    assert.equal(next, renderDeterministicJournal(otherCards(), { date: DATE, timezone: TZ }));
  });
});

test("empty day still writes a valid journal file", () => {
  withMemoryDir((memoryDir) => {
    const result = persistDeterministicJournal({
      memoryDir,
      date: DATE,
      cards: [],
      timezone: TZ,
    });
    assert.equal(result.wrote, true);
    const relative = path.relative(memoryDir, result.path).replace(/\\/g, "/");
    assert.equal(relative, "journal/2026-08-17.md");
    assert.equal(
      readFileSync(result.path, "utf8"),
      renderDeterministicJournal([], { date: DATE, timezone: TZ }),
    );
  });
});

test("existing foreign file without force stays byte-identical", () => {
  withMemoryDir((memoryDir) => {
    const filePath = journalPath(memoryDir, DATE);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "user notes\n");
    const original = readFileSync(filePath);
    const result = persistDeterministicJournal({
      memoryDir,
      date: DATE,
      cards: activityCards(),
      timezone: TZ,
    });
    assert.equal(result.wrote, false);
    assert.deepEqual(readFileSync(filePath), original);
  });
});
