import assert from "node:assert/strict";
import test from "node:test";

import {
  isMalformedEntityRecord,
  isPopulatedUnnamedEntityRecord,
  isShapedUnnamedEntityRecord,
  isUnnamedEntityRecord,
} from "./malformed-entity-record.js";

const NAMED = "# Alice\n\n**Type:** person\n\nNotes about Alice.\n";
const NAMED_NO_TYPE = "# Alice\n\nNotes about Alice.\n";
const TYPE_ONLY = "**Type:** person\n\nNo heading name.\n";
const TAB_HEADING = "#\tAlice\n\n**Type:** person\n";
const BLANK_HEADING = "#  \n\n**Type:** person\n";
const PROSE_ONLY = "just some content without structure\n";
const EMPTY_BODY = "---\nid: x\n---\n\n   \n";
const FRONTMATTER_NAMED = "---\nid: alice\n---\n\n# Alice\n\n**Type:** person\n";

test("isUnnamedEntityRecord requires a hash-space heading with a name", () => {
  assert.equal(isUnnamedEntityRecord(NAMED), false);
  assert.equal(isUnnamedEntityRecord(NAMED_NO_TYPE), false);
  assert.equal(isUnnamedEntityRecord(FRONTMATTER_NAMED), false);
  assert.equal(isUnnamedEntityRecord(TYPE_ONLY), true);
  assert.equal(isUnnamedEntityRecord(TAB_HEADING), true, "tab after # is not a heading");
  assert.equal(isUnnamedEntityRecord(BLANK_HEADING), true, "blank # heading is unnamed");
  assert.equal(isUnnamedEntityRecord(PROSE_ONLY), true);
  assert.equal(isUnnamedEntityRecord(""), true);
});

test("isPopulatedUnnamedEntityRecord needs body text without a name", () => {
  assert.equal(isPopulatedUnnamedEntityRecord(NAMED), false);
  assert.equal(isPopulatedUnnamedEntityRecord(TYPE_ONLY), true);
  assert.equal(isPopulatedUnnamedEntityRecord(TAB_HEADING), true);
  assert.equal(isPopulatedUnnamedEntityRecord(PROSE_ONLY), true);
  assert.equal(isPopulatedUnnamedEntityRecord(EMPTY_BODY), false, "whitespace-only body stays readable");
  assert.equal(isPopulatedUnnamedEntityRecord(""), false);
});

test("isShapedUnnamedEntityRecord keeps entity-like unnamed files only", () => {
  assert.equal(isShapedUnnamedEntityRecord(NAMED), false);
  assert.equal(isShapedUnnamedEntityRecord(TYPE_ONLY), true);
  assert.equal(isShapedUnnamedEntityRecord(TAB_HEADING), true, "any # line shapes the record");
  assert.equal(isShapedUnnamedEntityRecord(BLANK_HEADING), true);
  assert.equal(isShapedUnnamedEntityRecord(PROSE_ONLY), false, "unstructured placeholders stay for filename recall");
  assert.equal(isShapedUnnamedEntityRecord(EMPTY_BODY), false);
});

test("isMalformedEntityRecord requires both name and explicit type for migration", () => {
  assert.equal(isMalformedEntityRecord(NAMED), false);
  assert.equal(isMalformedEntityRecord(FRONTMATTER_NAMED), false);
  assert.equal(isMalformedEntityRecord(NAMED_NO_TYPE), true, "missing type is malformed for migration");
  assert.equal(isMalformedEntityRecord(TYPE_ONLY), true);
  assert.equal(isMalformedEntityRecord(TAB_HEADING), true);
  assert.equal(isMalformedEntityRecord(PROSE_ONLY), true);
  assert.equal(isMalformedEntityRecord("# Bob\n\n**Type:**   \n"), true, "blank type value is missing");
  assert.equal(isMalformedEntityRecord("# Bob\n\n**Type:** org\r\n"), false, "CRLF type lines count");
});

test("entity body ignores closed frontmatter and keeps unclosed frontmatter as body", () => {
  const unclosed = "---\nid: stuck\n# Not a real heading yet\n";
  // Unclosed frontmatter is not stripped, so the # line is not at body start of a closed block —
  // but it still appears in the full content scan as a named heading.
  assert.equal(isUnnamedEntityRecord(unclosed), false);
  assert.equal(isMalformedEntityRecord(unclosed), true, "no type line");

  const namedAfterFrontmatter = "---\na: 1\n---\r\n# Carol\r\n\r\n**Type:** place\r\n";
  assert.equal(isMalformedEntityRecord(namedAfterFrontmatter), false);
});
