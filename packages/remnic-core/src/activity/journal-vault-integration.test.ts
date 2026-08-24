/**
 * Integration: vault journal → review-only extraction → review queue
 * (issue #1987 acceptance criteria).
 *
 * Full round trip in a temp memoryDir + fixture vault against the REAL
 * StorageManager: pending_review candidates only, hash-skip on unchanged
 * days, exactly one re-extraction per edit, publisher coexistence on the
 * same note, and no journal-derived memory reaching active without
 * approval.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../index.js";
import { createJournalMemoryWriter, runJournalReviewExtraction } from "../activity/journal-extract.js";
import { readJournalForDate } from "../activity/journal-read.js";
import {
  journalUnchanged,
  readTimelineState,
  setJournalHash,
  hashJournalText,
  writeTimelineState,
} from "../activity/journal-state.js";
import { publishVaultNote } from "../activity/vault-publisher.js";
import type { ActivityTimelineVaultConfig } from "../activity/types.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

function vaultConfig(vaultPath: string): ActivityTimelineVaultConfig {
  return {
    enabled: true,
    vaultPath,
    dailyNotePath: "{yyyy}-{MM}-{dd}.md",
    weeklyNotePath: "",
    createMissingNotes: true,
    noteTemplate: "",
    sectionStrategy: "markers",
    publish: {
      timeline: { enabled: true, target: "daily", section: "timeline" },
      standup: { enabled: false, target: "daily", section: "Standup" },
      weekly: { enabled: false, target: "weekly", section: "Weekly Review" },
      locations: { enabled: false, target: "daily", section: "Locations" },
    },
    insertUnderHeading: "",
    readback: { journalSection: "Journal" },
    wikilinks: { places: false, placesFolder: "Places" },
    properties: { mode: "off", prefix: "remnic_" },
    autoPublish: true,
  };
}

interface Fixture {
  vault: string;
  memoryDir: string;
  storage: StorageManager;
  config: ActivityTimelineVaultConfig;
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const vault = mkdtempSync(path.join(tmpdir(), "remnic-journal-it-vault-"));
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-journal-it-mem-"));
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  try {
    await fn({ vault, memoryDir, storage, config: vaultConfig(vault) });
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

function notePath(fx: Fixture, date: string): string {
  return path.join(fx.vault, `${date}.md`);
}

function writeNote(fx: Fixture, date: string, lines: string[]): void {
  writeFileSync(notePath(fx, date), lines.join("\n"));
}

function mockExtract(facts: string[]) {
  return async () => ({
    facts: facts.map((content) => ({
      content,
      category: "decision" as const,
      confidence: 0.9,
      tags: [],
      entityRef: undefined,
    })),
    profileUpdates: [],
    entities: [],
    questions: [],
  });
}

test("vault journal round trip: pending_review only, journalSource=vault, hash-skip, re-extract once", async () => {
  await withFixture(async (fx) => {
    writeNote(fx, "2026-08-20", [
      "---",
      "date: 2026-08-20",
      "---",
      "## Journal",
      "I decided to move the parser to its own module.",
      START,
      "- 09:00 published card",
      END,
      "## Timeline",
      START,
      "sibling published",
      END,
      "",
    ]);
    const read = readJournalForDate({ vault: fx.config, date: "2026-08-20" });
    assert.ok(read.ok && read.exists);
    assert.match(read.text, /I decided to move the parser/);
    assert.doesNotMatch(read.text, /published card/);
    assert.doesNotMatch(read.text, /sibling published/);

    // First extraction: exactly one pending_review candidate.
    const first = await runJournalReviewExtraction({
      date: "2026-08-20",
      journalText: read.text,
      source: "vault",
      journalConfig: { extractionMode: "review" },
      deps: {
        extract: mockExtract(["I decided to move the parser to its own module."]),
        writer: createJournalMemoryWriter(fx.storage),
      },
    });
    assert.equal(first.pendingReview, 1);
    assert.equal(first.completed, true);

    const memories = await fx.storage.readAllMemories();
    assert.equal(memories.length, 1);
    const memory = memories[0]!;
    assert.equal(memory.frontmatter.status, "pending_review");
    assert.deepEqual(memory.frontmatter.tags, ["journal", "journal-day:2026-08-20"]);
    assert.equal(memory.frontmatter.valid_at, "2026-08-20T00:00:00.000Z");
    assert.equal(memory.frontmatter.structuredAttributes?.journalSource, "vault");

    // Hash-skip: unchanged note + stored hash → zero new candidates.
    const state = setJournalHash(readTimelineState(fx.memoryDir), "2026-08-20", hashJournalText(read.text));
    writeTimelineState(fx.memoryDir, state);
    assert.equal(journalUnchanged(readTimelineState(fx.memoryDir), "2026-08-20", read.text), true);
    const second = await runJournalReviewExtraction({
      date: "2026-08-20",
      journalText: read.text,
      source: "vault",
      journalConfig: { extractionMode: "review" },
      deps: {
        extract: mockExtract(["I decided to move the parser to its own module."]),
        writer: createJournalMemoryWriter(fx.storage),
      },
    });
    assert.equal(second.pendingReview, 0);
    assert.equal(second.skipped, 1);
    assert.equal((await fx.storage.readAllMemories()).length, 1);

    // Note edited: the changed hash re-runs the pass; the new fact lands
    // pending_review, the old one is untouched (not active, not duplicated).
    writeNote(fx, "2026-08-20", [
      "## Journal",
      "I decided to move the parser to its own module.",
      "I also committed to a weekly review pass.",
      "",
    ]);
    const reread = readJournalForDate({ vault: fx.config, date: "2026-08-20" });
    assert.ok(reread.ok && reread.exists);
    const third = await runJournalReviewExtraction({
      date: "2026-08-20",
      journalText: reread.text,
      source: "vault",
      journalConfig: { extractionMode: "review" },
      deps: {
        extract: mockExtract([
          "I decided to move the parser to its own module.",
          "I also committed to a weekly review pass.",
        ]),
        writer: createJournalMemoryWriter(fx.storage),
      },
    });
    assert.equal(third.pendingReview, 1);
    assert.equal(third.skipped, 1);
    const after = await fx.storage.readAllMemories();
    assert.equal(after.length, 2);
    for (const m of after) {
      assert.equal(m.frontmatter.status, "pending_review", "no journal memory reaches active without approval");
    }
  });
});

test("publisher and readback coexist byte-safely on the same note", async () => {
  await withFixture(async (fx) => {
    mkdirSync(path.join(fx.vault, "templates"), { recursive: true });
    writeNote(fx, "2026-08-21", [
      "---",
      "date: 2026-08-21",
      "---",
      "## Journal",
      "user line one",
      "user line two",
      "## Timeline",
      "",
    ]);
    const before = readFileSync(notePath(fx, "2026-08-21"), "utf8");

    // Publish a timeline region into the note (markers strategy).
    const status = publishVaultNote({
      vaultPath: fx.vault,
      notePathTemplate: "{yyyy}-{MM}-{dd}.md",
      date: "2026-08-21",
      sections: [{ name: "timeline", content: "- published card" }],
      strategy: "markers",
      insertUnderHeading: "Timeline",
    });
    assert.equal(status.results[0]?.outcome, "updated");
    const afterPublish = readFileSync(notePath(fx, "2026-08-21"), "utf8");
    assert.notEqual(afterPublish, before);
    assert.match(afterPublish, /remnic:timeline:start/);

    // Readback returns the user text byte-identically; only Remnic's own
    // region was added by the publish.
    const read = readJournalForDate({ vault: fx.config, date: "2026-08-21" });
    assert.ok(read.ok && read.exists);
    assert.equal(read.text, "user line one\nuser line two");
  });
});
