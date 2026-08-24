import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVaultFrontmatter,
  renderVaultPropertyValue,
  validateVaultProperties,
  VAULT_PROPERTY_LIST_MAX_ITEMS,
  VAULT_PROPERTY_SCALAR_MAX_CHARS,
  VAULT_PROPERTY_TOTAL_MAX_CHARS,
} from "./vault-frontmatter.js";

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

test("accepts a plain scalar and renders it verbatim (#2917)", () => {
  assert.deepEqual(validateVaultProperties([{ key: "remnic_focus", value: "220" }]), { ok: true });
  assert.equal(renderVaultPropertyValue("220"), "220");
});

test("accepts a list of plain scalars and renders a flow list (#2917)", () => {
  assert.deepEqual(validateVaultProperties([{ key: "remnic_cards", value: ["a", "b"] }]), { ok: true });
  assert.equal(renderVaultPropertyValue(["a", "b"]), "[a, b]");
});

test("rejects newline and control characters — the injection primitives (#2917)", () => {
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: "v\ninjected: yes" }]).ok, false);
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: "v\rinjected: yes" }]).ok, false);
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: "v\ttab" }]).ok, false);
});

test("rejects values whose YAML shape would change on re-read (#2917)", () => {
  for (const value of [" padded", "padded ", "[seq]", "{map}", "#comment", "- item", "a #c", "ends:", "a: b"]) {
    assert.equal(
      validateVaultProperties([{ key: "remnic_x", value }]).ok,
      false,
      `value ${JSON.stringify(value)} must be rejected`,
    );
  }
});

test("a negative number stays a plain scalar (#2917)", () => {
  assert.deepEqual(validateVaultProperties([{ key: "remnic_delta", value: "-5" }]), { ok: true });
});

test("rejects unsupported value shapes (#2917)", () => {
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: 42 as unknown as string }]).ok, false);
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: null as unknown as string }]).ok, false);
  assert.equal(
    validateVaultProperties([{ key: "remnic_x", value: { nested: true } as unknown as string }]).ok,
    false,
  );
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: [] as unknown as string[] }]).ok, false);
});

test("rejects oversize scalars, lists, keys, and totals (#2917)", () => {
  assert.equal(
    validateVaultProperties([{ key: "remnic_x", value: "v".repeat(VAULT_PROPERTY_SCALAR_MAX_CHARS + 1) }]).ok,
    false,
  );
  assert.equal(validateVaultProperties([{ key: "x".repeat(65), value: "v" }]).ok, false);
  const tooMany = Array.from({ length: VAULT_PROPERTY_LIST_MAX_ITEMS + 1 }, (_, i) => `item-${i}`);
  assert.equal(validateVaultProperties([{ key: "remnic_x", value: tooMany }]).ok, false);
  const entries = Array.from({ length: 30 }, (_, i) => ({
    key: `remnic_k${i}`,
    value: "v".repeat(100),
  }));
  assert.equal(
    validateVaultProperties(entries).ok,
    false,
    `30 × 100+ chars must exceed the ${VAULT_PROPERTY_TOTAL_MAX_CHARS}-char total`,
  );
});

test("rejects malformed keys (#2917)", () => {
  assert.equal(validateVaultProperties([{ key: "remnic x:", value: "v" }]).ok, false);
  assert.equal(validateVaultProperties([{ key: " padded", value: "v" }]).ok, false);
  assert.equal(validateVaultProperties([{ key: "remnic#x", value: "v" }]).ok, false);
  assert.equal(validateVaultProperties([{ key: "", value: "v" }]).ok, false);
});
