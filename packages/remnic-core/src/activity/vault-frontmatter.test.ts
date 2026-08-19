import assert from "node:assert/strict";
import test from "node:test";

import { applyVaultFrontmatter } from "./vault-frontmatter.js";

test("applyVaultFrontmatter merges listed keys and sorts", () => {
  const merged = applyVaultFrontmatter("zeta: old\nalpha: keep\n", {
    zeta: "new",
    remnic_cards: "3",
  });
  assert.equal(merged, "alpha: keep\nremnic_cards: 3\nzeta: new");
});

test("applyVaultFrontmatter rejects keys with newlines", () => {
  assert.throws(
    () => applyVaultFrontmatter("alpha: keep", { "bad\nkey": "1" }),
    /newline/i,
  );
  assert.throws(
    () => applyVaultFrontmatter("alpha: keep", { "bad\rkey": "1" }),
    /newline/i,
  );
});

test("applyVaultFrontmatter leaves the original body unchanged when updates are empty", () => {
  const existing = "zeta: 1\n# comment stays\nalpha: 2\n";
  assert.equal(applyVaultFrontmatter(existing, {}), existing);
});
