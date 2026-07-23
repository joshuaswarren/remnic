import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureInputError } from "./errors.js";
import { assertValidTimezone, decodeCursor, encodeCursor, parseLimit, parseSnapshotDate } from "./validate.js";

test("parseSnapshotDate accepts real days and rejects impossible/malformed ones", () => {
  assert.equal(parseSnapshotDate("2026-07-20"), "2026-07-20");
  assert.throws(() => parseSnapshotDate("2026-02-30"), CaptureInputError);
  assert.throws(() => parseSnapshotDate("2026-13-01"), CaptureInputError);
  assert.throws(() => parseSnapshotDate("07/20/2026"), CaptureInputError);
  assert.throws(() => parseSnapshotDate(null), CaptureInputError);
});

test("assertValidTimezone accepts IANA zones and rejects junk", () => {
  assert.equal(assertValidTimezone("America/New_York"), "America/New_York");
  assert.throws(() => assertValidTimezone("Not/AZone"), CaptureInputError);
  assert.throws(() => assertValidTimezone(""), CaptureInputError);
});

test("parseLimit defaults when absent and rejects out-of-range", () => {
  assert.equal(parseLimit(null), 100);
  assert.equal(parseLimit("250"), 250);
  assert.throws(() => parseLimit("0"), CaptureInputError);
  assert.throws(() => parseLimit("501"), CaptureInputError);
  assert.throws(() => parseLimit("abc"), CaptureInputError);
});

test("cursor round-trips over (capturedAtUtc, id) and rejects malformed tokens", () => {
  const token = encodeCursor("2026-07-20T10:00:00.000Z", 42);
  assert.deepEqual(decodeCursor(token), { capturedAtUtc: "2026-07-20T10:00:00.000Z", id: 42 });
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(""), null);
  assert.throws(() => decodeCursor("!!!not-base64!!!"), CaptureInputError);
  // A non-integer / non-instant tuple is rejected.
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify(["x", 1]), "utf8").toString("base64url")), CaptureInputError);
  assert.throws(
    () => decodeCursor(Buffer.from(JSON.stringify(["2026-07-20T10:00:00.000Z", "1"]), "utf8").toString("base64url")),
    CaptureInputError,
  );
});

test("decodeCursor rejects non-canonical timestamps (offset or missing ms)", () => {
  const offset = Buffer.from(JSON.stringify(["2026-07-20T10:00:00+00:00", 1]), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(offset), CaptureInputError);
  const noMs = Buffer.from(JSON.stringify(["2026-07-20T10:00:00Z", 1]), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(noMs), CaptureInputError);
});
