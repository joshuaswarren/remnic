import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveContainedPath, sanitizeFilenameSegment } from "../packages/bench/src/filename-safety.js";

test("artifact filename segments preserve safe characters and replace path separators", () => {
  const cases: Array<[string, string]> = [
    ["  model-v2.1_run  ", "model-v2.1_run"],
    ["provider/model", "provider_model"],
    ["provider\\model:2", "provider_model_2"],
    ["résumé", "r_sum_"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeFilenameSegment(input), expected, input);
  }
});

test("blank artifact labels receive a non-empty filename segment", () => {
  assert.equal(sanitizeFilenameSegment(""), "unknown");
  assert.equal(sanitizeFilenameSegment(" \t\n"), "unknown");
});

test("artifact paths allow nested files and normalization within their root", () => {
  const root = path.join(os.tmpdir(), "remnic-artifacts");
  assert.equal(resolveContainedPath(root, "run-1", "report.json"), path.join(root, "run-1", "report.json"));
  assert.equal(resolveContainedPath(root, "run-1", "..", "report.json"), path.join(root, "report.json"));
});

test("artifact paths reject parent traversal and same-prefix sibling directories", () => {
  const root = path.join(os.tmpdir(), "remnic-artifacts");
  for (const segments of [
    [".."],
    ["..", "report.json"],
    ["..", "remnic-artifacts-copy", "report.json"],
    ["run-1", "..", "..", "report.json"],
  ]) {
    assert.throws(() => resolveContainedPath(root, ...segments), /Refusing to write benchmark artifact outside/);
  }
});

test("absolute paths cannot redirect artifacts outside their root", () => {
  const root = path.join(os.tmpdir(), "remnic-artifacts");
  const outside = path.join(os.tmpdir(), "remnic-other", "report.json");
  assert.throws(() => resolveContainedPath(root, outside), /Refusing to write benchmark artifact outside/);
});
