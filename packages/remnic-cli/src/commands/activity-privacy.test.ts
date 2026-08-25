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

// ---- delete (dry-run plan over stdin JSON-lines candidates) ----

const NOW_MS = Date.parse("2026-02-01T00:00:00.000Z");
const EXPIRED_MS = Date.parse("2026-01-01T00:00:00.000Z"); // 31 days old

function captureDelete(
  rest: string[],
  lines: readonly string[],
): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runActivityPrivacyCommand(
    rest,
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    lines,
  );
  return { code, stdout, stderr };
}

function deletePlan(stdout: string[]): { deletePaths: string[]; keptCount: number; refused: string[] } {
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0]) as { deletePaths: string[]; keptCount: number; refused: string[] };
}

const DELETE_BASE = ["delete", "--scope", "cards", "--now", "2026-02-01T00:00:00.000Z", "--retention-days", "30"];

test("delete plans an expired owned candidate", () => {
  const result = captureDelete(DELETE_BASE, [
    JSON.stringify({ scope: "cards", relPath: "activity/timeline/2026-01-01.json", capturedAtMs: EXPIRED_MS }),
  ]);
  assert.equal(result.code, 0);
  const plan = deletePlan(result.stdout);
  assert.deepEqual(plan.deletePaths, ["activity/timeline/2026-01-01.json"]);
  assert.equal(plan.keptCount, 0);
  assert.deepEqual(plan.refused, []);
});

test("delete keeps a fresh candidate and refuses non-owned paths", () => {
  const result = captureDelete(DELETE_BASE, [
    JSON.stringify({ scope: "cards", relPath: "activity/timeline/2026-02-01.json", capturedAtMs: NOW_MS }),
    JSON.stringify({ scope: "cards", relPath: "memories/foo.md", capturedAtMs: EXPIRED_MS }),
  ]);
  assert.equal(result.code, 0);
  const plan = deletePlan(result.stdout);
  assert.deepEqual(plan.deletePaths, []);
  assert.equal(plan.keptCount, 1);
  assert.deepEqual(plan.refused, ["memories/foo.md"]);
});

test("delete with master disabled refuses outright", () => {
  const result = captureDelete([...DELETE_BASE, "--enabled", "false"], [
    JSON.stringify({ scope: "cards", relPath: "activity/timeline/2026-01-01.json", capturedAtMs: EXPIRED_MS }),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /disabled/);
});

test("delete requires --now and at least one --scope", () => {
  const noNow = captureDelete(["delete", "--scope", "cards"], []);
  assert.equal(noNow.code, 1);
  assert.match(noNow.stderr.join("\n"), /--now/);
  const noScope = captureDelete(["delete", "--now", "2026-02-01T00:00:00.000Z"], []);
  assert.equal(noScope.code, 1);
  assert.match(noScope.stderr.join("\n"), /--scope/);
});

test("delete rejects malformed candidate lines with the line number", () => {
  const result = captureDelete(DELETE_BASE, ["{not json"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /candidate line 1/);
});

test("delete rejects an unknown scope", () => {
  const result = captureDelete(
    ["delete", "--scope", "bogus", "--now", "2026-02-01T00:00:00.000Z"],
    [],
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr.join("\n"), /unknown activity delete scope/);
});

// ---- redact (drop keys from one JSON item on stdin) ----

function captureRedact(rest: string[], itemJson: string): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runActivityPrivacyCommand(
    rest,
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    [itemJson],
  );
  return { code, stdout, stderr };
}

test("redact drops listed keys, trimmed and deduplicated", () => {
  const result = captureRedact(
    ["redact", "--keys", "url, url ,text"],
    JSON.stringify({ id: 1, url: "https://example.com", text: "secret", app: "Safari" }),
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout[0]), { id: 1, app: "Safari" });
});

test("redact requires --keys and a JSON object item", () => {
  const noKeys = captureRedact(["redact"], JSON.stringify({ id: 1 }));
  assert.equal(noKeys.code, 1);
  assert.match(noKeys.stderr.join("\n"), /--keys/);
  const notObject = captureRedact(["redact", "--keys", "url"], "[1,2]");
  assert.equal(notObject.code, 1);
  assert.match(notObject.stderr.join("\n"), /must be a JSON object/);
});

// ---- gates (master-off opt-out resolution) ----

function captureGates(rest: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runActivityPrivacyCommand(rest, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

test("gates default every gate off", () => {
  const result = captureGates(["gates"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout[0]), {
    analysis: false,
    journal: false,
    weekly: false,
    export: false,
    memoryCreation: false,
  });
});

test("gates resolve set gates while the master is enabled", () => {
  const result = captureGates(["gates", "--enabled", "true", "--analysis", "true", "--weekly", "true"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout[0]), {
    analysis: true,
    journal: false,
    weekly: true,
    export: false,
    memoryCreation: false,
  });
});

test("gates master off overrides every gate to false (opt-out)", () => {
  const result = captureGates(["gates", "--enabled", "false", "--analysis", "true"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout[0]), {
    analysis: false,
    journal: false,
    weekly: false,
    export: false,
    memoryCreation: false,
  });
});

test("gates reject invalid tokens and unknown gate flags", () => {
  const badToken = captureGates(["gates", "--enabled", "true", "--journal", "yes"]);
  assert.equal(badToken.code, 1);
  assert.match(badToken.stderr.join("\n"), /must be true or false/);
  const unknownGate = captureGates(["gates", "--bogus", "true"]);
  assert.equal(unknownGate.code, 1);
  assert.match(unknownGate.stderr.join("\n"), /unknown gate flag/);
});
