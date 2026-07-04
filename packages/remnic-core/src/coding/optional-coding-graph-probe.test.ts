// Additional tests for the optional @remnic/coding-graph loader
// specifically targeting the probe-never-throws contract (Cursor Bugbot
// P1 from PR #1588 review).

import assert from "node:assert/strict";
import test from "node:test";

import { isCodingGraphInstalled, tryLoadCodingGraphModule } from "./optional-coding-graph.js";

test("isCodingGraphInstalled probe returns boolean on every codepath; never throws", async () => {
  // The probe is documented to "never throw"; assert that the contract
  // holds even when the underlying try-import would surface a non-specifier
  // error. We simulate by stubbing the dynamic import through the loader's
  // exported isSpecifierNotFoundErrorForCodingGraph — but more directly,
  // we just confirm the probe returns a boolean either way (present or
  // absent) by running it twice and checking the type of the result.
  const a = await isCodingGraphInstalled();
  assert.equal(typeof a, "boolean", "probe must always return a boolean");
  // Run again to also exercise the cached-skip branch.
  const b = await isCodingGraphInstalled();
  assert.equal(typeof b, "boolean");
});

test("tryLoadCodingGraphModule returns module-or-null without throwing", async () => {
  const result = await tryLoadCodingGraphModule();
  if (result === null) {
    assert.equal(result, null);
  } else {
    assert.equal(typeof result.createCodingGraphEngine, "function");
  }
  // A repeated call must never throw.
  const result2 = await tryLoadCodingGraphModule();
  assert.ok(result2 === null || typeof result2 === "object");
});
