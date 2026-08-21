import assert from "node:assert/strict";
import test from "node:test";

import { parseAtxHeadingLevel } from "./heading-level.js";

test("h1 is level 1", () => {
  assert.deepEqual(parseAtxHeadingLevel("# Title"), { ok: true, level: 1 });
});

test("h6 is level 6", () => {
  assert.deepEqual(parseAtxHeadingLevel("###### Title"), { ok: true, level: 6 });
});

test("no hashes is not_heading", () => {
  assert.deepEqual(parseAtxHeadingLevel("Title"), { ok: false, error: "not_heading" });
});

test("seven hashes is invalid_level", () => {
  assert.deepEqual(parseAtxHeadingLevel("####### Title"), {
    ok: false,
    error: "invalid_level",
  });
});
