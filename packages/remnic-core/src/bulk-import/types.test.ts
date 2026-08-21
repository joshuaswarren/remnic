import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isImportRole,
  parseIsoTimestamp,
  validateImportTurn,
  type ImportTurn,
} from "./types.js";

// ---------------------------------------------------------------------------
// isImportRole
// ---------------------------------------------------------------------------

describe("isImportRole", () => {
  it("accepts 'user'", () => {
    assert.equal(isImportRole("user"), true);
  });

  it("accepts 'assistant'", () => {
    assert.equal(isImportRole("assistant"), true);
  });

  it("accepts 'other'", () => {
    assert.equal(isImportRole("other"), true);
  });

  it("rejects unknown string", () => {
    assert.equal(isImportRole("system"), false);
  });

  it("rejects non-string", () => {
    assert.equal(isImportRole(42), false);
  });
});

// ---------------------------------------------------------------------------
// parseIsoTimestamp
// ---------------------------------------------------------------------------

describe("parseIsoTimestamp", () => {
  it("parses a valid ISO timestamp with millis", () => {
    const ts = parseIsoTimestamp("2024-06-15T10:30:00.000Z");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("parses a valid ISO timestamp without millis", () => {
    const ts = parseIsoTimestamp("2024-06-15T10:30:00Z");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("parses a valid ISO timestamp with positive timezone offset", () => {
    const ts = parseIsoTimestamp("2024-01-15T10:30:00+05:30");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("parses a valid ISO timestamp with negative timezone offset", () => {
    const ts = parseIsoTimestamp("2024-01-15T10:30:00-08:00");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("parses a valid ISO timestamp with millis and timezone offset", () => {
    const ts = parseIsoTimestamp("2024-01-15T10:30:00.000+05:30");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("rejects overflowed offset timestamp (Feb 31)", () => {
    assert.equal(parseIsoTimestamp("2024-02-31T10:00:00+00:00"), null);
  });

  it("rejects overflowed UTC timestamp (Feb 30)", () => {
    assert.equal(parseIsoTimestamp("2024-02-30T10:00:00Z"), null);
  });

  it("rejects offset hour exceeding 14", () => {
    assert.equal(parseIsoTimestamp("2024-01-15T10:00:00+25:00"), null);
  });

  it("rejects offset hour of 15", () => {
    assert.equal(parseIsoTimestamp("2024-01-15T10:00:00+15:00"), null);
  });

  it("rejects offset minute exceeding 59", () => {
    assert.equal(parseIsoTimestamp("2024-01-15T10:00:00+05:61"), null);
  });

  it("rejects overflowed month (month 13)", () => {
    assert.equal(parseIsoTimestamp("2024-13-15T10:00:00+00:00"), null);
  });

  it("rejects overflowed day for April (Apr 31)", () => {
    assert.equal(parseIsoTimestamp("2024-04-31T10:00:00+05:30"), null);
  });

  it("accepts valid Feb 29 in leap year with offset", () => {
    const ts = parseIsoTimestamp("2024-02-29T10:00:00+05:30");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("accepts two-digit fractional seconds", () => {
    const ts = parseIsoTimestamp("2024-01-15T10:30:00.12Z");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("accepts six-digit fractional seconds with offset", () => {
    const ts = parseIsoTimestamp("2024-01-15T10:30:00.123456+00:00");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("accepts single-digit fractional seconds", () => {
    const ts = parseIsoTimestamp("2024-01-15T10:30:00.5Z");
    assert.equal(typeof ts, "number");
    assert.ok(ts! > 0);
  });

  it("rejects Feb 29 in non-leap year with offset", () => {
    assert.equal(parseIsoTimestamp("2023-02-29T10:00:00+05:30"), null);
  });

  it("returns null for non-ISO string", () => {
    assert.equal(parseIsoTimestamp("June 15, 2024"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseIsoTimestamp(""), null);
  });

  it("returns null for non-string input", () => {
    assert.equal(parseIsoTimestamp(123 as unknown as string), null);
  });
});

// ---------------------------------------------------------------------------
// validateImportTurn
// ---------------------------------------------------------------------------

function makeValidTurn(overrides?: Partial<ImportTurn>): ImportTurn {
  return {
    role: "user",
    content: "Hello, world!",
    timestamp: "2024-06-15T10:30:00.000Z",
    ...overrides,
  };
}

describe("validateImportTurn", () => {
  it("returns no issues for a valid turn", () => {
    const issues = validateImportTurn(makeValidTurn());
    assert.equal(issues.length, 0);
  });

  it("returns no issues for a valid turn with 'other' role", () => {
    const issues = validateImportTurn(makeValidTurn({ role: "other" }));
    assert.equal(issues.length, 0);
  });

  it("returns no issues for a valid turn with 'assistant' role", () => {
    const issues = validateImportTurn(
      makeValidTurn({ role: "assistant" }),
    );
    assert.equal(issues.length, 0);
  });

  it("reports invalid role", () => {
    const turn = makeValidTurn({
      role: "system" as unknown as ImportTurn["role"],
    });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "turn.role.invalid");
    assert.ok(issues[0].message.includes("system"));
  });

  it("reports empty content", () => {
    const turn = makeValidTurn({ content: "" });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "turn.content.invalid");
  });

  it("reports whitespace-only content", () => {
    const turn = makeValidTurn({ content: "   " });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "turn.content.invalid");
  });

  it("reports invalid timestamp", () => {
    const turn = makeValidTurn({ timestamp: "not-a-date" });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "turn.timestamp.invalid");
    assert.ok(issues[0].message.includes("not-a-date"));
  });

  it("reports empty timestamp", () => {
    const turn = makeValidTurn({ timestamp: "" });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "turn.timestamp.invalid");
  });

  it("reports multiple issues at once", () => {
    const turn = makeValidTurn({
      role: "invalid" as unknown as ImportTurn["role"],
      content: "",
      timestamp: "bad",
    });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 3);
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("turn.role.invalid"));
    assert.ok(codes.includes("turn.content.invalid"));
    assert.ok(codes.includes("turn.timestamp.invalid"));
  });

  it("returns turn.invalid for null input", () => {
    const issues = validateImportTurn(
      null as unknown as ImportTurn,
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "turn.invalid");
  });

  it("includes index when provided", () => {
    const turn = makeValidTurn({ content: "" });
    const issues = validateImportTurn(turn, 5);
    assert.equal(issues[0].index, 5);
  });

  it("accepts timestamp without millis", () => {
    const turn = makeValidTurn({
      timestamp: "2024-06-15T10:30:00Z",
    });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 0);
  });

  it("accepts timestamp with positive timezone offset", () => {
    const turn = makeValidTurn({
      timestamp: "2024-01-15T10:30:00+05:30",
    });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 0);
  });

  it("accepts timestamp with negative timezone offset", () => {
    const turn = makeValidTurn({
      timestamp: "2024-01-15T10:30:00-08:00",
    });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 0);
  });

  it("includes optional fields without issue", () => {
    const turn = makeValidTurn({
      participantId: "p1",
      participantName: "Alice",
      replyToId: "msg-42",
    });
    const issues = validateImportTurn(turn);
    assert.equal(issues.length, 0);
  });
});
