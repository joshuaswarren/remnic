import assert from "node:assert/strict";
import test from "node:test";

import { parseAtxHeading } from "./journal-section.js";
import { applyLegacyJournalHeading, normalizeJournalHeading, validateJournalSectionName } from "./journal-heading.js";

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

test("validateJournalSectionName accepts heading names the shared parser can match exactly", () => {
  for (const name of ["Journal", "Tagebuch 📝", "C#", "# Notes", "Notes ```", "What I did - 2026"]) {
    assert.deepEqual(validateJournalSectionName(name), { ok: true });
  }
});

test("validateJournalSectionName rejects empty and whitespace-only names", () => {
  assert.deepEqual(validateJournalSectionName(""), { ok: false, error: "empty_heading" });
  assert.deepEqual(validateJournalSectionName("   "), { ok: false, error: "empty_heading" });
  assert.deepEqual(validateJournalSectionName("\t"), { ok: false, error: "empty_heading" });
});

test("validateJournalSectionName rejects leading or trailing whitespace the parser would trim", () => {
  assert.deepEqual(validateJournalSectionName(" Journal"), { ok: false, error: "untrimmed_heading" });
  assert.deepEqual(validateJournalSectionName("Journal "), { ok: false, error: "untrimmed_heading" });
  assert.deepEqual(validateJournalSectionName("\tJournal"), { ok: false, error: "untrimmed_heading" });
  // A trailing line break is whitespace first: trim() removes it, so the
  // untrimmed branch fires before the control-character branch.
  assert.deepEqual(validateJournalSectionName("Journal\n"), { ok: false, error: "untrimmed_heading" });
});

test("validateJournalSectionName rejects line breaks and control characters inside the name", () => {
  assert.deepEqual(validateJournalSectionName("Jour\nnal"), { ok: false, error: "control_character" });
  assert.deepEqual(validateJournalSectionName("Jour\rnal"), { ok: false, error: "control_character" });
  assert.deepEqual(validateJournalSectionName("Dia\u0000ry"), { ok: false, error: "control_character" });
  assert.deepEqual(validateJournalSectionName("Dia\u0007ry"), { ok: false, error: "control_character" });
  assert.deepEqual(validateJournalSectionName("Dia\u0085ry"), { ok: false, error: "control_character" });
});

test("validateJournalSectionName rejects trailing '#' runs the parser strips as a closing sequence", () => {
  assert.deepEqual(validateJournalSectionName("Notes #"), { ok: false, error: "unmatchable_heading" });
  assert.deepEqual(validateJournalSectionName("Notes ###"), { ok: false, error: "unmatchable_heading" });
  // "C#" is fine: the run is not preceded by whitespace, so it is title
  // text, not a closing sequence.
  assert.deepEqual(validateJournalSectionName("C#"), { ok: true });
});

test("every accepted journal section name round-trips through the shared heading parser", () => {
  for (const name of ["Journal", "C#", "# Notes", "Tagebuch 📝", "Notes ```"]) {
    assert.deepEqual(validateJournalSectionName(name), { ok: true });
    assert.equal(parseAtxHeading(`## ${name}`)?.text, name);
  }
});
