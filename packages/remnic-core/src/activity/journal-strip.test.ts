import assert from "node:assert/strict";
import test from "node:test";

import { stripRemnicOwnedRegions } from "./journal-strip.js";

test("stripRemnicOwnedRegions removes a marker pair and keeps user text", () => {
  const text = [
    "Morning standup.",
    "<!-- remnic:timeline:start -->",
    "9:00 deep work",
    "<!-- remnic:timeline:end -->",
    "Wrote the parser.",
  ].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, []), "Morning standup.\nWrote the parser.");
});

test("stripRemnicOwnedRegions keeps one blank line where a removal doubled it", () => {
  const text = [
    "Before.",
    "",
    "<!-- remnic:timeline:start -->",
    "generated",
    "<!-- remnic:timeline:end -->",
    "",
    "After.",
  ].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, []), "Before.\n\nAfter.");
});

test("stripRemnicOwnedRegions removes two distinct marker pairs", () => {
  const text = [
    "head",
    "<!-- remnic:timeline:start -->",
    "timeline body",
    "<!-- remnic:timeline:end -->",
    "middle",
    "<!-- remnic:digest:start -->",
    "digest body",
    "<!-- remnic:digest:end -->",
    "tail",
  ].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, []), "head\nmiddle\ntail");
});

test("stripRemnicOwnedRegions strips an unterminated start marker to the end of input", () => {
  const text = ["kept", "<!-- remnic:timeline:start -->", "generated", "later user text"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, []), "kept");
});

test("stripRemnicOwnedRegions removes an orphan end marker and keeps surrounding text", () => {
  const text = ["Before.", "<!-- remnic:timeline:end -->", "After."].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, []), "Before.\nAfter.");
});

test("stripRemnicOwnedRegions removes an owned heading section up to the next same-level heading", () => {
  const text = ["## Journal", "intro", "## Timeline", "card one", "## Notes", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]), "## Journal\nintro\n## Notes\nkept");
});

test("stripRemnicOwnedRegions does not end an owned section at a deeper heading", () => {
  const text = [
    "## Journal",
    "## Timeline",
    "card one",
    "### Deep",
    "deep card",
    "## Notes",
    "kept",
  ].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]), "## Journal\n## Notes\nkept");
});

test("stripRemnicOwnedRegions preserves a non-owned heading section", () => {
  const text = ["## Journal", "## Timeline", "card one", "## Notes", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Digest"]), text);
});

test("stripRemnicOwnedRegions ignores blank and whitespace owned heading entries", () => {
  const text = ["## Timeline", "card one", ""].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["", "   ", "\t"]), text);
});

test("stripRemnicOwnedRegions trims configured owned heading entries", () => {
  const text = ["## Timeline", "card", "## Notes", "kept"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["  Timeline  "]), "## Notes\nkept");
});

test("stripRemnicOwnedRegions returns empty string for empty input", () => {
  assert.equal(stripRemnicOwnedRegions("", ["Timeline"]), "");
});

test("stripRemnicOwnedRegions returns unchanged text when nothing is owned", () => {
  const text = ["first", "", "second", "", "third"].join("\n");
  assert.equal(stripRemnicOwnedRegions(text, ["Timeline"]), text);
});
