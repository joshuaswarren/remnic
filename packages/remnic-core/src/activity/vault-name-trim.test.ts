import assert from "node:assert/strict";
import test from "node:test";

import { trimRegionName } from "./vault-name-trim.js";

test("trimRegionName accepts a name", () => {
  assert.equal(trimRegionName("timeline"), "timeline");
});

test("trimRegionName rejects an empty name", () => {
  assert.throws(() => trimRegionName(""), /empty/i);
  assert.throws(() => trimRegionName("   "), /empty/i);
});

test("trimRegionName rejects a newline in the name", () => {
  assert.throws(() => trimRegionName("time\nline"), /newline/i);
  assert.throws(() => trimRegionName("time\rline"), /newline/i);
});

test("trimRegionName trims surrounding whitespace", () => {
  assert.equal(trimRegionName("  timeline  "), "timeline");
});
