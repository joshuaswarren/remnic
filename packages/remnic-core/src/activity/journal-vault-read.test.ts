import assert from "node:assert/strict";
import test from "node:test";

import { readVaultJournal, stripRemnicOwnedRegions } from "./journal-vault-read.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

test("missing file is exists false, not an error", () => {
  assert.deepEqual(readVaultJournal({ fileText: null, journalSection: "Journal" }), {
    ok: true,
    exists: false,
    reason: "missing_file",
  });
  assert.deepEqual(readVaultJournal({ fileText: undefined, journalSection: "Journal" }), {
    ok: true,
    exists: false,
    reason: "missing_file",
  });
});

test("missing heading is exists false, not an error", () => {
  const fileText = ["---", "date: 2026-08-17", "---", "", "## Timeline", "cards", ""].join("\n");
  assert.deepEqual(readVaultJournal({ fileText, journalSection: "Journal" }), {
    ok: true,
    exists: false,
    reason: "missing_heading",
  });
});

test("empty day returns exists true with empty text", () => {
  const fileText = ["## Journal", "## Next", ""].join("\n");
  const result = readVaultJournal({ fileText, journalSection: "Journal" });
  assert.deepEqual(result, {
    ok: true,
    exists: true,
    text: "",
    heading: "Journal",
    warnings: [],
  });
});

test("duplicate heading refuses with line numbers", () => {
  const fileText = ["# Day", "## Journal", "first", "## Notes", "## Journal", "second", ""].join("\n");
  const result = readVaultJournal({ fileText, journalSection: "Journal" });
  assert.deepEqual(result, { ok: false, reason: "duplicate_heading", lines: [2, 5] });
});

test("strips remnic marker regions and publish section headings", () => {
  const fileText = [
    "---",
    "date: 2026-08-17",
    "---",
    "",
    "## Journal",
    "I walked the dog.",
    START,
    "- 09:00 standup",
    END,
    "Still thinking about the meeting.",
    "### Timeline",
    "nested publish",
    "### Notes",
    "more user text",
    "",
    "## Timeline",
    START,
    "sibling publish",
    END,
    "",
  ].join("\n");

  const result = readVaultJournal({
    fileText,
    journalSection: "Journal",
    publishSectionNames: ["Timeline"],
  });
  assert.equal(result.ok, true);
  if (!result.ok || !result.exists) {
    assert.fail("expected journal text");
    return;
  }
  assert.equal(result.heading, "Journal");
  assert.equal(result.warnings.length, 0);
  assert.match(result.text, /I walked the dog\./);
  assert.match(result.text, /Still thinking about the meeting\./);
  assert.match(result.text, /more user text/);
  assert.doesNotMatch(result.text, /standup/);
  assert.doesNotMatch(result.text, /nested publish/);
  assert.doesNotMatch(result.text, /sibling publish/);
  assert.doesNotMatch(result.text, /remnic:/);
  assert.doesNotMatch(result.text, /### Timeline/);
});

test("non-ASCII journal heading matches exactly", () => {
  const fileText = ["## Tagebuch 📝", "Heute ruhig.", "## Andere", ""].join("\n");
  const result = readVaultJournal({ fileText, journalSection: "Tagebuch 📝" });
  assert.deepEqual(result, {
    ok: true,
    exists: true,
    text: "Heute ruhig.",
    heading: "Tagebuch 📝",
    warnings: [],
  });
});

test("unclosed start marker strips to end of section and warns", () => {
  const fileText = ["## Journal", "keep me", START, "leaked publish", "## Next", "outside", ""].join(
    "\n",
  );
  const result = readVaultJournal({ fileText, journalSection: "Journal" });
  assert.equal(result.ok, true);
  if (!result.ok || !result.exists) {
    assert.fail("expected journal text");
    return;
  }
  assert.equal(result.text, "keep me");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /timeline/);
});

test("marker pair split across the section boundary does not leak", () => {
  const fileText = [
    START,
    "before journal",
    "## Journal",
    "leaked into journal",
    END,
    "user after",
    "## Next",
    "",
  ].join("\n");
  const result = readVaultJournal({ fileText, journalSection: "Journal" });
  assert.equal(result.ok, true);
  if (!result.ok || !result.exists) {
    assert.fail("expected journal text");
    return;
  }
  assert.equal(result.text, "user after");
  assert.doesNotMatch(result.text, /leaked/);
});

test("stripRemnicOwnedRegions returns only user text after injected regions", () => {
  const user = "Day was quiet.\nSecond line.\n";
  const names = ["timeline", "weekly", "digest"] as const;
  for (const name of names) {
    const region = `<!-- remnic:${name}:start -->\nOWNED ${name}\n<!-- remnic:${name}:end -->\n`;
    const mixed = `${region}${user}${region}${user}`;
    const stripped = stripRemnicOwnedRegions(mixed);
    assert.equal(stripped.text, `${user}${user}`);
    assert.deepEqual(stripped.warnings, []);
  }
});
