import assert from "node:assert/strict";
import test from "node:test";

import { assertIsoRecordedAt, recordStoreDay } from "./store-contract.js";

test("assertIsoRecordedAt accepts valid complete ISO timestamps with timezones", () => {
  assert.equal(
    assertIsoRecordedAt("2026-05-21T12:34:56.789Z"),
    "2026-05-21T12:34:56.789Z",
  );
  assert.equal(
    assertIsoRecordedAt("2026-05-21T12:34:56-05:00"),
    "2026-05-21T12:34:56-05:00",
  );
});

test("assertIsoRecordedAt rejects impossible, incomplete, and overflow timestamps", () => {
  for (const value of [
    "2026-99-99Tnot-a-date",
    "2026-02-30T00:00:00Z",
    "2026-05-21",
    "2026-05-21T12:34:56",
    "2026-05-21T24:00:00Z",
    "2026-05-21T12:60:00Z",
    "2026-05-21T12:34:60Z",
    "999999999999-01-01T00:00:00Z",
  ]) {
    assert.throws(() => assertIsoRecordedAt(value), /recordedAt must be an ISO timestamp/);
    assert.throws(() => recordStoreDay(value), /recordedAt must be an ISO timestamp/);
  }
});

test("recordStoreDay returns the validated source date prefix", () => {
  assert.equal(recordStoreDay("2026-05-21T23:30:00-05:00"), "2026-05-21");
});
