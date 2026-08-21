import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseStrictCliDate } from "../cli.js";

describe("parseStrictCliDate", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    const d = parseStrictCliDate("2026-01-15", "--since");
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 0); // January = 0
    assert.equal(d.getUTCDate(), 15);
  });

  it("accepts valid ISO 8601 datetime strings", () => {
    const d = parseStrictCliDate("2026-03-10T14:30:00.000Z", "--until");
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 2); // March = 2
    assert.equal(d.getUTCDate(), 10);
    assert.equal(d.getUTCHours(), 14);
    assert.equal(d.getUTCMinutes(), 30);
  });

  it("accepts leap-year Feb 29", () => {
    const d = parseStrictCliDate("2024-02-29", "--since");
    assert.equal(d.getUTCMonth(), 1); // February = 1
    assert.equal(d.getUTCDate(), 29);
  });

  it("rejects Feb 31 (overflowed day)", () => {
    assert.throws(
      () => parseStrictCliDate("2026-02-31", "--since"),
      /date components overflow/,
    );
  });

  it("rejects Feb 30 in non-leap year", () => {
    assert.throws(
      () => parseStrictCliDate("2025-02-30", "--until"),
      /date components overflow/,
    );
  });

  it("rejects Feb 29 in non-leap year", () => {
    assert.throws(
      () => parseStrictCliDate("2025-02-29", "--since"),
      /date components overflow/,
    );
  });

  it("rejects Apr 31 (overflowed 30-day month)", () => {
    assert.throws(
      () => parseStrictCliDate("2026-04-31", "--until"),
      /date components overflow/,
    );
  });

  it("rejects month 13", () => {
    // Month 13 produces NaN from Date constructor, caught by the first check
    assert.throws(
      () => parseStrictCliDate("2026-13-01", "--since"),
      /Invalid --since/,
    );
  });

  it("rejects month 00", () => {
    assert.throws(
      () => parseStrictCliDate("2026-00-15", "--since"),
      /Invalid --since/,
    );
  });

  it("rejects completely invalid date strings", () => {
    assert.throws(
      () => parseStrictCliDate("not-a-date", "--since"),
      /Invalid --since/,
    );
  });

  it("rejects empty string", () => {
    assert.throws(
      () => parseStrictCliDate("", "--until"),
      /Invalid --until/,
    );
  });

  it("includes flag name in error message", () => {
    assert.throws(
      () => parseStrictCliDate("garbage", "--since"),
      /--since/,
    );
    assert.throws(
      () => parseStrictCliDate("garbage", "--until"),
      /--until/,
    );
  });

  // --- Issue 1: Timezone-offset dates must not be falsely rejected ---

  it("accepts ISO datetime with positive timezone offset", () => {
    const d = parseStrictCliDate("2026-01-15T23:00:00+05:30", "--since");
    // 2026-01-15T23:00:00+05:30 => 2026-01-15T17:30:00Z
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 0);
    assert.equal(d.getUTCDate(), 15);
    assert.equal(d.getUTCHours(), 17);
    assert.equal(d.getUTCMinutes(), 30);
  });

  it("accepts ISO datetime where offset shifts UTC date backward", () => {
    // Input date is the 16th, but UTC date becomes the 15th
    const d = parseStrictCliDate("2026-01-16T01:00:00+05:30", "--since");
    // 2026-01-16T01:00:00+05:30 => 2026-01-15T19:30:00Z
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 0);
    assert.equal(d.getUTCDate(), 15);
    assert.equal(d.getUTCHours(), 19);
    assert.equal(d.getUTCMinutes(), 30);
  });

  it("accepts ISO datetime where negative offset shifts UTC date forward", () => {
    // Input date is the 15th, but UTC date becomes the 16th
    const d = parseStrictCliDate("2026-01-15T23:00:00-05:00", "--until");
    // 2026-01-15T23:00:00-05:00 => 2026-01-16T04:00:00Z
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 0);
    assert.equal(d.getUTCDate(), 16);
    assert.equal(d.getUTCHours(), 4);
  });

  it("accepts ISO datetime with large positive offset (UTC+14)", () => {
    const d = parseStrictCliDate("2026-01-15T23:00:00+14:00", "--since");
    // 2026-01-15T23:00:00+14:00 => 2026-01-15T09:00:00Z
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCDate(), 15);
    assert.equal(d.getUTCHours(), 9);
  });

  it("accepts ISO datetime with ordinary negative timezone offset", () => {
    const d = parseStrictCliDate("2026-01-15T23:00:00-08:00", "--since");
    // 2026-01-15T23:00:00-08:00 => 2026-01-16T07:00:00Z
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCDate(), 16);
    assert.equal(d.getUTCHours(), 7);
  });

  it("rejects timezone offset hour beyond UTC+14", () => {
    assert.throws(
      () => parseStrictCliDate("2024-01-15T10:00:00+15:00", "--since"),
      /timezone offset out of range/,
    );
  });

  it("rejects timezone offset minute beyond 59", () => {
    assert.throws(
      () => parseStrictCliDate("2024-01-15T10:00:00+05:61", "--since"),
      /timezone offset out of range/,
    );
  });

  it("rejects timezone offset minutes at the UTC+14 boundary", () => {
    assert.throws(
      () => parseStrictCliDate("2024-01-15T10:00:00+14:01", "--until"),
      /timezone offset out of range/,
    );
  });

  it("rejects timezone offset minutes at the UTC-14 boundary", () => {
    assert.throws(
      () => parseStrictCliDate("2024-01-15T10:00:00-14:01", "--until"),
      /timezone offset out of range/,
    );
  });

  it("still rejects overflow dates in UTC form (Z suffix)", () => {
    assert.throws(
      () => parseStrictCliDate("2026-02-31T00:00:00Z", "--since"),
      /date components overflow/,
    );
  });

  it("still rejects overflow dates with no time component", () => {
    assert.throws(
      () => parseStrictCliDate("2026-02-30", "--until"),
      /date components overflow/,
    );
  });

  // --- Issue 2: Non-ISO strings must be rejected ---

  it("rejects natural-language date string", () => {
    assert.throws(
      () => parseStrictCliDate("December 25, 2026", "--since"),
      /expected ISO 8601 format/,
    );
  });

  it("rejects US-format date string", () => {
    assert.throws(
      () => parseStrictCliDate("01/15/2026", "--until"),
      /expected ISO 8601 format/,
    );
  });

  it("rejects day-month-year string", () => {
    assert.throws(
      () => parseStrictCliDate("15-Jan-2026", "--since"),
      /expected ISO 8601 format/,
    );
  });

  it("rejects RFC 2822 date string", () => {
    assert.throws(
      () => parseStrictCliDate("Thu, 15 Jan 2026 00:00:00 GMT", "--since"),
      /expected ISO 8601 format/,
    );
  });

  // --- Issue 3: overflow must be rejected regardless of timezone ---

  it("rejects overflow date even with positive timezone offset", () => {
    // Previously skipped when a timezone offset was present.
    assert.throws(
      () => parseStrictCliDate("2026-02-31T00:00:00+05:30", "--since"),
      /date components overflow/,
    );
  });

  it("rejects overflow date with negative timezone offset", () => {
    assert.throws(
      () => parseStrictCliDate("2026-04-31T12:00:00-05:00", "--until"),
      /date components overflow/,
    );
  });

  it("rejects overflow date with naive (local) datetime form", () => {
    assert.throws(
      () => parseStrictCliDate("2025-02-29T10:00:00", "--since"),
      /date components overflow/,
    );
  });

  // --- Issue 4: naive datetime must not be rejected due to local-tz drift ---

  it("accepts naive datetime near UTC day boundary regardless of host timezone", () => {
    // "2026-01-15T23:30:00" (no Z, no offset) parses as local time. The
    // overflow check must NOT compare against UTC components, which would
    // misreport an overflow in non-UTC host timezones.
    const d = parseStrictCliDate("2026-01-15T23:30:00", "--since");
    assert.equal(Number.isFinite(d.getTime()), true);
  });

  it("accepts naive datetime at start of day", () => {
    const d = parseStrictCliDate("2026-01-01T00:00:00", "--since");
    assert.equal(Number.isFinite(d.getTime()), true);
  });

  it("accepts full-precision ISO 8601 with fractional seconds and offset", () => {
    const d = parseStrictCliDate("2026-03-10T14:30:00.123+02:00", "--until");
    assert.equal(Number.isFinite(d.getTime()), true);
  });

  // --- Time-component out-of-range ---

  it("rejects hour 24", () => {
    assert.throws(
      () => parseStrictCliDate("2026-01-15T24:00:00", "--since"),
      /time components out of range/,
    );
  });

  it("rejects minute 60", () => {
    assert.throws(
      () => parseStrictCliDate("2026-01-15T12:60:00", "--since"),
      /time components out of range/,
    );
  });

  it("rejects second 60 (leap second — Date cannot represent it)", () => {
    // JavaScript's Date silently normalises :60 to :00 of the next minute,
    // which would make a "strict" parser return a different timestamp than
    // the user specified. Reject it up front.
    assert.throws(
      () => parseStrictCliDate("2026-01-15T12:00:60", "--since"),
      /time components out of range/,
    );
  });

  it("rejects second 61", () => {
    assert.throws(
      () => parseStrictCliDate("2026-01-15T12:00:61", "--until"),
      /time components out of range/,
    );
  });
});
