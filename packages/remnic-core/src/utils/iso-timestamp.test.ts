import assert from "node:assert/strict";
import test from "node:test";

import { parseFlexibleIsoTimestamp } from "./iso-timestamp.js";

test("parseFlexibleIsoTimestamp accepts coloned timezone offsets", () => {
  const parsed = parseFlexibleIsoTimestamp("2025-01-01T12:00:00+05:30");
  assert.notEqual(parsed, null);
  assert.equal(new Date(parsed!).toISOString(), "2025-01-01T06:30:00.000Z");
});

test("parseFlexibleIsoTimestamp rejects colons-free timezone offsets", () => {
  assert.equal(parseFlexibleIsoTimestamp("2025-01-01T12:00:00+0530"), null);
});
