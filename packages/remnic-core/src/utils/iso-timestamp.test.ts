import assert from "node:assert/strict";
import test from "node:test";

import { parseFlexibleIsoTimestamp } from "./iso-timestamp.js";

test("parseFlexibleIsoTimestamp accepts date-only values without time or offset validation", () => {
  const parsed = parseFlexibleIsoTimestamp("2025-01-01");
  assert.notEqual(parsed, null);
  assert.equal(new Date(parsed!).toISOString(), "2025-01-01T00:00:00.000Z");
});

test("parseFlexibleIsoTimestamp accepts reduced time precision with timezone", () => {
  const parsed = parseFlexibleIsoTimestamp("2025-01-01T12:34Z");
  assert.notEqual(parsed, null);
  assert.equal(new Date(parsed!).toISOString(), "2025-01-01T12:34:00.000Z");
});

test("parseFlexibleIsoTimestamp accepts coloned timezone offsets", () => {
  const parsed = parseFlexibleIsoTimestamp("2025-01-01T12:00:00+05:30");
  assert.notEqual(parsed, null);
  assert.equal(new Date(parsed!).toISOString(), "2025-01-01T06:30:00.000Z");
});

test("parseFlexibleIsoTimestamp rejects colons-free timezone offsets", () => {
  assert.equal(parseFlexibleIsoTimestamp("2025-01-01T12:00:00+0530"), null);
});

test("parseFlexibleIsoTimestamp rejects out-of-range timezone offsets only when an offset is present", () => {
  assert.notEqual(parseFlexibleIsoTimestamp("2025-01-01T12:00:00+14:00"), null);
  assert.notEqual(parseFlexibleIsoTimestamp("2025-01-01T12:00:00-12:00"), null);
  assert.notEqual(parseFlexibleIsoTimestamp("2025-01-01T12:00:00-13:00"), null);
  assert.notEqual(parseFlexibleIsoTimestamp("2025-01-01T12:00:00-14:00"), null);
  assert.equal(parseFlexibleIsoTimestamp("2025-01-01T12:00:00+14:30"), null);
  assert.equal(parseFlexibleIsoTimestamp("2025-01-01T12:00:00+15:00"), null);
  assert.equal(parseFlexibleIsoTimestamp("2025-01-01T12:00:00-14:30"), null);
  assert.equal(parseFlexibleIsoTimestamp("2025-01-01T12:00:00-15:00"), null);
});
