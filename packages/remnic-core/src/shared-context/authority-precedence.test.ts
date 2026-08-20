import assert from "node:assert/strict";
import { test } from "node:test";

import { SHARED_AUTHORITIES } from "./governance.js";
import {
  compareSharedAuthority,
  resolveSharedAuthority,
  SHARED_AUTHORITY_CLASSES,
} from "./authority-precedence.js";

test("SHARED_AUTHORITY_CLASSES is the canonical governance list, not a copy", () => {
  assert.equal(SHARED_AUTHORITY_CLASSES, SHARED_AUTHORITIES);
});

test("resolveSharedAuthority defaults absent authority to informational", () => {
  assert.equal(resolveSharedAuthority({}), "informational");
  assert.equal(resolveSharedAuthority({ authority: undefined }), "informational");
  assert.equal(resolveSharedAuthority({ authority: null }), "informational");
});

test("resolveSharedAuthority honors binding only with the explicit boolean flag", () => {
  assert.equal(resolveSharedAuthority({ authority: "binding", allowBinding: true }), "binding");
  assert.equal(resolveSharedAuthority({ authority: "binding" }), "advisory");
  assert.equal(resolveSharedAuthority({ authority: "binding", allowBinding: undefined }), "advisory");
  assert.equal(resolveSharedAuthority({ authority: "binding", allowBinding: false }), "advisory");
});

test("resolveSharedAuthority keeps advisory and informational regardless of the flag", () => {
  assert.equal(resolveSharedAuthority({ authority: "advisory" }), "advisory");
  assert.equal(resolveSharedAuthority({ authority: "advisory", allowBinding: true }), "advisory");
  assert.equal(resolveSharedAuthority({ authority: "informational" }), "informational");
  assert.equal(resolveSharedAuthority({ authority: "informational", allowBinding: true }), "informational");
});

test("resolveSharedAuthority maps unrecognized strings to informational without normalizing", () => {
  // Flag on proves these stay informational because of the exact-value
  // check, not because binding was denied.
  for (const authority of ["BINDING", "mandatory", " binding", "binding ", ""]) {
    assert.equal(resolveSharedAuthority({ authority, allowBinding: true }), "informational");
  }
});

test("resolveSharedAuthority maps non-string authority values to informational", () => {
  for (const authority of [3, 0, true, false, { authority: "binding" }, ["binding"], Number.NaN]) {
    assert.equal(resolveSharedAuthority({ authority }), "informational");
  }
});

test("resolveSharedAuthority rejects a non-boolean allowBinding", () => {
  for (const allowBinding of ["true", 1, null, "yes"] as unknown[]) {
    assert.throws(
      () => resolveSharedAuthority({ authority: "binding", allowBinding: allowBinding as never }),
      { name: "TypeError", message: /allowBinding/ },
    );
  }
});
test("compareSharedAuthority orders every class pair by ascending privilege", () => {
  const expected: Record<string, number> = { informational: 0, advisory: 1, binding: 2 };
  for (const a of SHARED_AUTHORITY_CLASSES) {
    for (const b of SHARED_AUTHORITY_CLASSES) {
      const forward = compareSharedAuthority(a, b);
      const backward = compareSharedAuthority(b, a);
      assert.equal(Math.sign(forward), Math.sign(expected[a] - expected[b]));
      assert.equal(Math.sign(backward) || 0, (-Math.sign(forward)) || 0);
    }
  }
  assert.equal(compareSharedAuthority("informational", "informational"), 0);
  assert.equal(compareSharedAuthority("advisory", "advisory"), 0);
  assert.equal(compareSharedAuthority("binding", "binding"), 0);
});

test("compareSharedAuthority sorts unknown classes as informational", () => {
  assert.equal(compareSharedAuthority("mandatory", "informational"), 0);
  assert.equal(compareSharedAuthority("informational", "mandatory"), 0);
  assert.equal(compareSharedAuthority("mandatory", "mandatory"), 0);
  assert.equal(compareSharedAuthority("mandatory", "advisory") < 0, true);
  assert.equal(compareSharedAuthority("advisory", "mandatory") > 0, true);
  assert.equal(compareSharedAuthority("mandatory", "binding") < 0, true);
  assert.equal(compareSharedAuthority("BINDING", "advisory") < 0, true);
});

test("sorting a shuffled mixed list is deterministic", () => {
  const shuffled = [
    "binding",
    "informational",
    "advisory",
    "mandatory",
    "advisory",
    "informational",
    "binding",
    "informational",
  ];
  const first = [...shuffled].sort(compareSharedAuthority);
  const second = [...shuffled].sort(compareSharedAuthority);
  assert.deepEqual(first, [
    "informational",
    "mandatory",
    "informational",
    "informational",
    "advisory",
    "advisory",
    "binding",
    "binding",
  ]);
  assert.deepEqual(first, second);
});
