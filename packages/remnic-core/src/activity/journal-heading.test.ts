import assert from "node:assert/strict";
import test from "node:test";

import { applyLegacyJournalHeading, normalizeJournalHeading } from "./journal-heading.js";

test("normalizeJournalHeading accepts a heading", () => {
  assert.deepEqual(normalizeJournalHeading("Journal"), { ok: true, heading: "Journal" });
});

test("normalizeJournalHeading rejects an empty heading", () => {
  assert.deepEqual(normalizeJournalHeading(""), { ok: false, error: "empty_heading" });
  assert.deepEqual(normalizeJournalHeading("   "), { ok: false, error: "empty_heading" });
});

test("normalizeJournalHeading rejects a heading with a newline", () => {
  assert.deepEqual(normalizeJournalHeading("Jour\nnal"), { ok: false, error: "invalid_heading" });
  assert.deepEqual(normalizeJournalHeading("Jour\rnal"), { ok: false, error: "invalid_heading" });
});

test("normalizeJournalHeading trims surrounding whitespace", () => {
  assert.deepEqual(normalizeJournalHeading("  Journal  "), { ok: true, heading: "Journal" });
});

test("applyLegacyJournalHeading copies heading when journalSection is empty", () => {
  assert.deepEqual(applyLegacyJournalHeading({ journalSection: "", heading: "  Diary  " }), {
    journalSection: "Diary",
    usedLegacyHeading: true,
    ignoredLegacyHeading: false,
  });
});

test("applyLegacyJournalHeading keeps journalSection when both keys are set", () => {
  assert.deepEqual(applyLegacyJournalHeading({ journalSection: "Journal", heading: "Diary" }), {
    journalSection: "Journal",
    usedLegacyHeading: false,
    ignoredLegacyHeading: true,
  });
});

test("applyLegacyJournalHeading rejects an empty legacy heading", () => {
  assert.throws(
    () => applyLegacyJournalHeading({ journalSection: "", heading: "   " }),
    /activity\.timeline\.journal\.heading must be a non-empty string/,
  );
});
