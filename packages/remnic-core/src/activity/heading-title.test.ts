import assert from "node:assert/strict";
import test from "node:test";

import { parseAtxHeadingTitle } from "./heading-title.js";

test("parseAtxHeadingTitle returns the title", () => {
  assert.deepEqual(parseAtxHeadingTitle("## Journal"), { ok: true, title: "Journal" });
  assert.deepEqual(parseAtxHeadingTitle("  # Title  "), { ok: true, title: "Title" });
  assert.deepEqual(parseAtxHeadingTitle("###### Deep"), { ok: true, title: "Deep" });
});

test("parseAtxHeadingTitle rejects an empty title", () => {
  assert.deepEqual(parseAtxHeadingTitle("#"), { ok: false, error: "empty_title" });
  assert.deepEqual(parseAtxHeadingTitle("##   "), { ok: false, error: "empty_title" });
});

test("parseAtxHeadingTitle rejects a non-heading", () => {
  assert.deepEqual(parseAtxHeadingTitle("Journal"), { ok: false, error: "not_heading" });
  assert.deepEqual(parseAtxHeadingTitle("#Title"), { ok: false, error: "not_heading" });
  assert.deepEqual(parseAtxHeadingTitle("####### Too many"), { ok: false, error: "not_heading" });
});
