import assert from "node:assert/strict";
import test from "node:test";

import { isRegionEndLine } from "./vault-end.js";

test("isRegionEndLine matches a trimmed end comment", () => {
  assert.equal(isRegionEndLine("<!-- remnic:end timeline -->", "timeline"), true);
  assert.equal(isRegionEndLine("  <!-- remnic:end timeline -->\t", "timeline"), true);
});

test("isRegionEndLine rejects a mismatch", () => {
  assert.equal(isRegionEndLine("<!-- remnic:begin timeline -->", "timeline"), false);
  assert.equal(isRegionEndLine("<!-- remnic:end weekly -->", "timeline"), false);
  assert.equal(isRegionEndLine("<!-- remnic:timeline:end -->", "timeline"), false);
  assert.equal(isRegionEndLine("<!-- remnic:end timeline --> extra", "timeline"), false);
});

test("isRegionEndLine throws on an empty name", () => {
  assert.throws(() => isRegionEndLine("<!-- remnic:end  -->", ""), /empty/i);
});
