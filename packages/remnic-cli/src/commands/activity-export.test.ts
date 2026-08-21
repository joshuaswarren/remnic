import assert from "node:assert/strict";
import test from "node:test";

import { runActivityExportCommand, type ActivityExportItem } from "./activity-export.js";

function capture(
  rest: string[],
  items: readonly ActivityExportItem[] = [],
  nowMs?: number,
): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runActivityExportCommand(
    rest,
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    items,
    nowMs,
  );
  return { code, stdout, stderr };
}

const from = "2026-01-01T00:00:00.000Z";
const mid = "2026-01-02T00:00:00.000Z";
const to = "2026-01-03T00:00:00.000Z";
const items: ActivityExportItem[] = [
  { id: "before", capturedAt: "2025-12-31T23:59:59.000Z" },
  { id: "start", capturedAt: from },
  { id: "inside", capturedAt: mid },
  { id: "end", capturedAt: to },
];

test("missing --from exits 1", () => {
  const result = capture(["--to", to, "--format", "json"], items);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /--from/);
});

test("enabled false denies with an empty array", () => {
  const result = capture(
    ["--from", from, "--to", to, "--format", "json", "--enabled", "false"],
    items,
  );
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ["[]"]);
});

test("half-open window prints id and capturedAt", () => {
  const result = capture(["--from", from, "--to", to, "--format", "json"], items);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.join("")), [
    { id: "start", capturedAt: from },
    { id: "inside", capturedAt: mid },
  ]);
});

test("omitted --to uses now", () => {
  const nowMs = Date.parse(to);
  const result = capture(["--from", from, "--format", "json"], items, nowMs);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.join("")), [
    { id: "start", capturedAt: from },
    { id: "inside", capturedAt: mid },
  ]);
});
