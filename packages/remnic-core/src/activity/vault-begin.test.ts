import assert from "node:assert/strict";
import test from "node:test";

import { isRegionBeginLine } from "./vault-begin.js";

test("isRegionBeginLine matches a trimmed begin comment", () => {
  assert.equal(isRegionBeginLine("<!-- remnic:begin timeline -->", "timeline"), true);
  assert.equal(isRegionBeginLine("  <!-- remnic:begin timeline -->\t", "timeline"), true);
});

test("isRegionBeginLine rejects a mismatch", () => {
  assert.equal(isRegionBeginLine("<!-- remnic:end timeline -->", "timeline"), false);
  assert.equal(isRegionBeginLine("<!-- remnic:begin weekly -->", "timeline"), false);
  assert.equal(isRegionBeginLine("<!-- remnic:timeline:start -->", "timeline"), false);
  assert.equal(isRegionBeginLine("<!-- remnic:begin timeline --> extra", "timeline"), false);
});

test("isRegionBeginLine throws on an empty name", () => {
  assert.throws(() => isRegionBeginLine("<!-- remnic:begin  -->", ""), /empty/i);
});
