import assert from "node:assert/strict";
import test from "node:test";

import { extractJournalSection } from "./journal-section.js";

test("extractJournalSection returns null when the heading is missing", () => {
  const markdown = ["# Day", "## Notes", "cards", ""].join("\n");
  assert.equal(extractJournalSection(markdown, "Journal"), null);
});

test("extractJournalSection returns the unique heading body until the next same-or-higher heading", () => {
  const markdown = [
    "# Day",
    "## Journal",
    "walked the dog",
    "### Nested",
    "still journal",
    "## Notes",
    "not journal",
    "",
  ].join("\n");
  assert.equal(
    extractJournalSection(markdown, "Journal"),
    ["walked the dog", "### Nested", "still journal"].join("\n"),
  );
});

test("extractJournalSection refuses a duplicate heading", () => {
  const markdown = ["# Day", "## Journal", "first", "## Notes", "## Journal", "second", ""].join("\n");
  assert.deepEqual(extractJournalSection(markdown, "Journal"), { error: "duplicate_heading" });
});

test("extractJournalSection rejects an empty heading", () => {
  const markdown = ["## Journal", "hi", ""].join("\n");
  assert.deepEqual(extractJournalSection(markdown, ""), { error: "empty_heading" });
  assert.deepEqual(extractJournalSection(markdown, "   "), { error: "empty_heading" });
});
