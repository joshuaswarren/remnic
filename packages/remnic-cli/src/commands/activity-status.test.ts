import assert from "node:assert/strict";
import test from "node:test";

import { runActivityStatusCommand } from "./activity-status.js";

function capture(rest: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runActivityStatusCommand(rest, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

function parsed(stdout: string[]): Record<string, unknown> {
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0]) as Record<string, unknown>;
}

test("defaults print the charter-off health snapshot", () => {
  const result = capture([]);
  assert.equal(result.code, 0);
  assert.deepEqual(parsed(result.stdout), {
    enabled: false,
    retentionDays: 30,
    sourceRevision: null,
    lastAnalysisStatus: "never",
    observationCount: 0,
    cardCount: 0,
  });
});

test("flags populate the snapshot without content fields", () => {
  const result = capture([
    "--enabled",
    "true",
    "--retention-days",
    "7",
    "--observations",
    "12",
    "--cards",
    "34",
    "--analysis",
    "ok",
    "--source-revision",
    "abc123",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(parsed(result.stdout), {
    enabled: true,
    retentionDays: 7,
    sourceRevision: "abc123",
    lastAnalysisStatus: "ok",
    observationCount: 12,
    cardCount: 34,
  });
});

test("blank source revision reports null", () => {
  const result = capture(["--source-revision", "   "]);
  assert.equal(result.code, 0);
  assert.equal(parsed(result.stdout).sourceRevision, null);
});

test("string booleans are rejected", () => {
  const result = capture(["--enabled", "yes"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /--enabled must be true or false/);
});

test("negative retention days are rejected", () => {
  const result = capture(["--retention-days", "-1"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.join("\n"), /retentionDays/);
});

test("float observation counts are rejected", () => {
  const result = capture(["--observations", "1.5"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.join("\n"), /observationCount/);
});

test("unknown analysis status is rejected", () => {
  const result = capture(["--analysis", "exploded"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.join("\n"), /unknown analysis status/);
});

test("help exits zero", () => {
  const result = capture(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout.join("\n"), /Usage: remnic activity-status/);
});
