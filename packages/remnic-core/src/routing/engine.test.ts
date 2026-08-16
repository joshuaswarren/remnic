import assert from "node:assert/strict";
import test from "node:test";

import { isSafeRouteNamespace, validateRouteTarget } from "./engine.js";

test("isSafeRouteNamespace accepts Unicode letters and NFC-normalizes before validation", () => {
  assert.equal(isSafeRouteNamespace("项目"), true);
  assert.equal(isSafeRouteNamespace("Cafe\u0301"), true);
  assert.equal(isSafeRouteNamespace("a1._-"), true);
  assert.equal(isSafeRouteNamespace("a".repeat(64)), true);
  assert.equal(isSafeRouteNamespace("a".repeat(65)), false);
  assert.equal(isSafeRouteNamespace("界".repeat(42)), true);
  assert.equal(isSafeRouteNamespace("界".repeat(43)), false);

  const target = validateRouteTarget(
    { namespace: "Cafe\u0301" },
    { allowedNamespaces: ["Café"] },
  );
  assert.deepEqual(target, {
    ok: true,
    target: { namespace: "Café" },
  });
});

test("isSafeRouteNamespace rejects traversal, controls, bidi overrides, and edge whitespace", () => {
  for (const unsafe of [
    "../escape",
    "a/b",
    "a\\b",
    "a\u0000b",
    "a\u202Eb",
    " name",
    "name ",
    "..",
  ]) {
    assert.equal(isSafeRouteNamespace(unsafe), false, JSON.stringify(unsafe));
  }
});
