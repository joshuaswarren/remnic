import assert from "node:assert/strict";
import test from "node:test";

import { stripVaultMdSuffix } from "./vault-suffix.js";

test("stripVaultMdSuffix drops a trailing .md", () => {
  assert.equal(stripVaultMdSuffix("Daily Notes/2026-08-18.md"), "Daily Notes/2026-08-18");
});

test("stripVaultMdSuffix leaves a path with no suffix unchanged", () => {
  assert.equal(stripVaultMdSuffix("Daily Notes/2026-08-18"), "Daily Notes/2026-08-18");
});

test("stripVaultMdSuffix throws on empty input", () => {
  assert.throws(() => stripVaultMdSuffix(""), /empty/i);
});

test("stripVaultMdSuffix does not strip .markdown", () => {
  assert.equal(stripVaultMdSuffix("Daily Notes/2026-08-18.markdown"), "Daily Notes/2026-08-18.markdown");
});
