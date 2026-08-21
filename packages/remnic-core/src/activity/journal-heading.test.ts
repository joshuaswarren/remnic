import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJournalHeading } from "./journal-heading.js";

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
