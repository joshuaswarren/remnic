#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const baselinePath = resolve(scriptDir, "test-typecheck-baseline.txt");

const result = spawnSync(
  "pnpm",
  ["exec", "tsc", "--noEmit", "--project", "tsconfig.tests.json", "--pretty", "false"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (result.error) {
  console.error(`[test-typecheck] failed to start tsc: ${result.error.message}`);
  process.exit(1);
}

const diagnosticHeaderPattern =
  /^(?<path>.+?\.ts)\((?<line>\d+),(?<column>\d+)\): (?:error )?(?<code>TS\d+)(?::|$)/;

const normalize = (value) =>
  value
    .replaceAll(repoRoot, "<repo>")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(diagnosticHeaderPattern))
    .filter((match) => match?.groups)
    .map((match) => {
      const { path, line, column, code } = match.groups;
      return `${path}(${line},${column}): ${code}`;
    })
    .join("\n")
    .trim();

const actual = normalize(`${result.stdout ?? ""}${result.stderr ?? ""}`);
const expected = existsSync(baselinePath)
  ? normalize(readFileSync(baselinePath, "utf8"))
  : "";

if (result.status === 0) {
  if (expected.length > 0) {
    console.error(
      "[test-typecheck] tests now typecheck cleanly; clear scripts/test-typecheck-baseline.txt.",
    );
    process.exit(1);
  }
  console.log("[test-typecheck] OK");
  process.exit(0);
}

if (actual === expected) {
  console.log("[test-typecheck] OK (matches existing baseline)");
  process.exit(0);
}

console.error(
  "[test-typecheck] test type errors changed. Update the tests or refresh scripts/test-typecheck-baseline.txt intentionally.",
);
console.error(actual);
process.exit(1);
