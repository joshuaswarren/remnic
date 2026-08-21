import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCompatChecks } from "../src/compat/checks.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(testDir, "compat-fixtures");

function fixturePath(name: string): string {
  return path.join(fixturesRoot, name);
}

test("compat fixture healthy reports no errors", async () => {
  const report = await runCompatChecks({
    repoRoot: fixturePath("healthy"),
    runner: { commandExists: async () => true },
  });

  assert.equal(report.summary.error, 0);
});

test("compat fixture missing-manifest reports manifest error", async () => {
  const report = await runCompatChecks({
    repoRoot: fixturePath("missing-manifest"),
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("plugin-manifest-present")?.level, "error");
});

test("compat fixture empty-package reports package parse error", async () => {
  const report = await runCompatChecks({
    repoRoot: fixturePath("empty-package"),
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("package-json-parse")?.level, "error");
});
