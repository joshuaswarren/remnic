import assert from "node:assert/strict";
import test from "node:test";

import { insertMarkersUnderHeading } from "./vault-insert.js";

const START = "<!-- remnic:daily:start -->";
const END = "<!-- remnic:daily:end -->";

test("inserts markers under a unique heading before existing body", () => {
  const fileText = ["# Notes", "", "## Journal", "", "Existing entry.", ""].join("\n");
  const result = insertMarkersUnderHeading(fileText, {
    heading: "Journal",
    name: "daily",
    content: "Line one.\nLine two.",
  });
  assert.ok(result.ok && result.inserted);
  assert.equal(
    result.text,
    ["# Notes", "", "## Journal", START, "Line one.", "Line two.", END, "", "Existing entry.", ""].join("\n"),
  );
});

test("returns text unchanged when both markers already exist", () => {
  const fileText = ["## Journal", START, "old", END, "tail", ""].join("\n");
  const result = insertMarkersUnderHeading(fileText, { heading: "Journal", name: "daily", content: "new" });
  assert.deepEqual(result, { ok: true, text: fileText, inserted: false });
});

test("fails with no_heading when no heading matches exactly", () => {
  const fileText = ["## Journal entry", "body", ""].join("\n");
  const result = insertMarkersUnderHeading(fileText, { heading: "Journal", name: "daily", content: "new" });
  assert.deepEqual(result, { ok: false, reason: "no_heading", text: fileText });
});

test("fails with duplicate_heading and both 1-based line numbers", () => {
  const fileText = ["# Top", "## Journal", "a", "## Journal", "b", ""].join("\n");
  const result = insertMarkersUnderHeading(fileText, { heading: "Journal", name: "daily", content: "new" });
  assert.ok(!result.ok && result.reason === "duplicate_heading");
  assert.deepEqual(result.lines, [2, 4]);
  assert.equal(result.text, fileText);
});

test("inserts before a later same-level heading and leaves that section intact", () => {
  const fileText = ["## Journal", "existing", "## Other", "other body", ""].join("\n");
  const result = insertMarkersUnderHeading(fileText, { heading: "Journal", name: "daily", content: "cards" });
  assert.ok(result.ok && result.inserted);
  assert.equal(
    result.text,
    ["## Journal", START, "cards", END, "existing", "## Other", "other body", ""].join("\n"),
  );
});

test("deeper headings do not end the section", () => {
  const fileText = ["## Journal", "### Nested", "nested body", "## Other", ""].join("\n");
  const result = insertMarkersUnderHeading(fileText, { heading: "Journal", name: "daily", content: "cards" });
  assert.ok(result.ok && result.inserted);
  assert.equal(
    result.text,
    ["## Journal", START, "cards", END, "### Nested", "nested body", "## Other", ""].join("\n"),
  );
});

test("inserts under a heading at EOF without trailing newline", () => {
  const result = insertMarkersUnderHeading("## Journal", { heading: "Journal", name: "daily", content: "cards" });
  assert.ok(result.ok && result.inserted);
  assert.equal(result.text, `## Journal\n${START}\ncards\n${END}\n`);
});

test("keeps content ending in a newline without doubling it", () => {
  const result = insertMarkersUnderHeading("## Journal\nbody\n", {
    heading: "Journal",
    name: "daily",
    content: "cards\n",
  });
  assert.ok(result.ok && result.inserted);
  assert.equal(result.text, `## Journal\n${START}\ncards\n${END}\nbody\n`);
});

test("empty content inserts adjacent markers", () => {
  const result = insertMarkersUnderHeading("## Journal\n", { heading: "Journal", name: "daily", content: "" });
  assert.ok(result.ok && result.inserted);
  assert.equal(result.text, `## Journal\n${START}\n${END}\n`);
});

test("preserves CRLF as the dominant EOL", () => {
  const fileText = ["## Journal", "body", ""].join("\r\n");
  const result = insertMarkersUnderHeading(fileText, {
    heading: "Journal",
    name: "daily",
    content: "line a\r\nline b",
  });
  assert.ok(result.ok && result.inserted);
  assert.equal(result.text, `## Journal\r\n${START}\r\nline a\r\nline b\r\n${END}\r\nbody\r\n`);
});

test("empty heading or name throws RangeError", () => {
  assert.throws(
    () => insertMarkersUnderHeading("## Journal\n", { heading: "", name: "daily", content: "" }),
    (err) => err instanceof RangeError && /empty/i.test(err.message),
  );
  assert.throws(
    () => insertMarkersUnderHeading("## Journal\n", { heading: "Journal", name: "", content: "" }),
    (err) => err instanceof RangeError && /empty/i.test(err.message),
  );
});
