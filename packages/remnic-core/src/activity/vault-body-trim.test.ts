import assert from "node:assert/strict";
import test from "node:test";

import { trimVaultRegionBody } from "./vault-body-trim.js";

test("trims leading and trailing blank lines", () => {
  assert.equal(trimVaultRegionBody("\n\nhello\n\n"), "hello");
});

test("preserves internal blank lines", () => {
  assert.equal(trimVaultRegionBody("line one\n\nline two\n"), "line one\n\nline two");
});

test("all blank becomes empty", () => {
  assert.equal(trimVaultRegionBody("\n\n"), "");
});
