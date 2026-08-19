import assert from "node:assert/strict";
import test from "node:test";

import { validateRegionName } from "./vault-region.js";

test("validateRegionName trims a valid name", () => {
  assert.deepEqual(validateRegionName("timeline"), { ok: true, name: "timeline" });
  assert.deepEqual(validateRegionName("  weekly  "), { ok: true, name: "weekly" });
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
