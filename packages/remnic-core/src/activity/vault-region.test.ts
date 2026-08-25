import assert from "node:assert/strict";
import test from "node:test";

import { validateRegionName } from "./vault-region.js";

test("validateRegionName accepts a valid name unchanged", () => {
  assert.deepEqual(validateRegionName("timeline"), { ok: true, name: "timeline" });
});

test("validateRegionName rejects whitespace-padded names instead of trimming them (#2917)", () => {
  assert.deepEqual(validateRegionName("  weekly"), { ok: false, error: "invalid_name" });
  assert.deepEqual(validateRegionName("weekly  "), { ok: false, error: "invalid_name" });
  assert.deepEqual(validateRegionName("  weekly  "), { ok: false, error: "invalid_name" });
});

test("validateRegionName rejects empty and whitespace-only names", () => {
  assert.deepEqual(validateRegionName(""), { ok: false, error: "invalid_name" });
  assert.deepEqual(validateRegionName("   "), { ok: false, error: "invalid_name" });
});

test("validateRegionName rejects names with newlines", () => {
  assert.deepEqual(validateRegionName("time\nline"), { ok: false, error: "invalid_name" });
  assert.deepEqual(validateRegionName("time\rline"), { ok: false, error: "invalid_name" });
});

test("validateRegionName rejects the HTML comment closer", () => {
  assert.deepEqual(validateRegionName("foo-->bar"), { ok: false, error: "invalid_name" });
  assert.deepEqual(validateRegionName("timeline-->"), { ok: false, error: "invalid_name" });
});

test("validateRegionName rejects a colon, which the marker grammar delimits with", () => {
  assert.deepEqual(validateRegionName("Work:Timeline"), { ok: false, error: "invalid_name" });
  assert.deepEqual(validateRegionName("timeline:start"), { ok: false, error: "invalid_name" });
});
