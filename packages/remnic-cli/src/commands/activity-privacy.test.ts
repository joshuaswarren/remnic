import assert from "node:assert/strict";
import test from "node:test";

import { runActivityPrivacyCommand } from "./activity-privacy.js";

function capture(rest: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runActivityPrivacyCommand(rest, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

const captured = "2026-01-01T00:00:00.000Z";
const now = "2026-01-15T00:00:00.000Z";

test("days 0 always retains", () => {
  const result = capture(["retain", "--captured", captured, "--now", now, "--days", "0"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ["retain=true"]);
  assert.equal(result.stderr.length, 0);
});

test("negative days are rejected", () => {
  const result = capture(["retain", "--captured", captured, "--now", now, "--days", "-1"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /non-negative integer/);
});

test("master disabled via --enabled false denies retain", () => {
  const result = capture([
    "retain",
    "--captured",
    captured,
    "--now",
    now,
    "--days",
    "0",
    "--enabled",
    "false",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ["retain=false"]);
});

test("age inside the half-open window retains", () => {
  const result = capture(["retain", "--captured", captured, "--now", now, "--days", "30"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ["retain=true"]);
});

test("exact expiry boundary does not retain", () => {
  const result = capture([
    "retain",
    "--captured",
    "2026-01-01T00:00:00.000Z",
    "--now",
    "2026-01-31T00:00:00.000Z",
    "--days",
    "30",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ["retain=false"]);
});
