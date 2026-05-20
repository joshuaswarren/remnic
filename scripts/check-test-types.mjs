#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const baselinePath = resolve(scriptDir, "test-typecheck-baseline.txt");

const diagnosticHeaderPattern =
  /^(?<path>.+?\.(?:cts|mts|ts|tsx))\((?<line>\d+),(?<column>\d+)\): (?:error )?(?<code>TS\d+)(?::|$)/;

const normalizeOutputLines = (value, root = repoRoot) =>
  value
    .replaceAll(root, "<repo>")
    .replace(/\r\n/g, "\n")
    .split("\n");

const normalizeLines = (value, root = repoRoot) =>
  normalizeOutputLines(value, root).map((line) => line.trim());

const diagnosticContinuationPattern =
  /^(?:A spread|An argument|Argument|Call signature|Cannot assign|Cannot find|Cannot invoke|Construct signature|Conversion of type|Did you mean|Element implicitly|Index signature|No overload|Object literal|Overload \d+|Property|Source has|Target signature|The |This condition|Type |Types |Value of type)/;

const isTypeScriptContinuationLine = (line) =>
  /^[ \t]/.test(line) && diagnosticContinuationPattern.test(line.trim());

export const normalizeDiagnostics = (value, root = repoRoot) =>
  normalizeLines(value, root)
    .map((line) => line.match(diagnosticHeaderPattern))
    .filter((match) => match?.groups)
    .map((match) => {
      const { path, line, column, code } = match.groups;
      return `${path}(${line},${column}): ${code}`;
    })
    .join("\n")
    .trim();

export function nonDiagnosticFailureLines(value, root = repoRoot) {
  const lines = [];
  let sawDiagnostic = false;
  for (const rawLine of normalizeOutputLines(value, root)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (diagnosticHeaderPattern.test(line)) {
      sawDiagnostic = true;
      continue;
    }
    if (sawDiagnostic && isTypeScriptContinuationLine(rawLine)) continue;
    lines.push(line);
  }
  return lines;
}

export function evaluateTestTypecheckResult({
  status,
  stdout = "",
  stderr = "",
  expectedText = "",
  root = repoRoot,
}) {
  const rawOutput = `${stdout}${stderr}`;
  const actual = normalizeDiagnostics(rawOutput, root);
  const expected = normalizeDiagnostics(expectedText, root);
  const actualNonDiagnosticText = nonDiagnosticFailureLines(rawOutput, root)
    .join("\n")
    .trim();
  const expectedNonDiagnosticText = nonDiagnosticFailureLines(expectedText, root)
    .join("\n")
    .trim();

  if (status === 0) {
    if (expected.length > 0) {
      return {
        ok: false,
        message:
          "[test-typecheck] tests now typecheck cleanly; clear scripts/test-typecheck-baseline.txt.",
      };
    }
    return { ok: true, message: "[test-typecheck] OK" };
  }

  if (actualNonDiagnosticText !== expectedNonDiagnosticText) {
    return {
      ok: false,
      message:
        "[test-typecheck] tsc failed with non-diagnostic output; investigate the wrapper/tooling failure before accepting the baseline.",
      details: actualNonDiagnosticText,
    };
  }

  if (actual.length === 0) {
    return {
      ok: false,
      message:
        "[test-typecheck] tsc failed without TypeScript diagnostics; investigate the wrapper/tooling failure before accepting the baseline.",
    };
  }

  if (actual === expected) {
    return {
      ok: true,
      message: "[test-typecheck] OK (matches existing baseline)",
    };
  }

  return {
    ok: false,
    message:
      "[test-typecheck] test type errors changed. Update the tests or refresh scripts/test-typecheck-baseline.txt intentionally.",
    details: actual,
  };
}

export function isDirectRunPath(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

function main() {
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

  const expectedText = existsSync(baselinePath)
    ? readFileSync(baselinePath, "utf8")
    : "";
  const evaluation = evaluateTestTypecheckResult({
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    expectedText,
  });

  if (evaluation.ok) {
    console.log(evaluation.message);
    process.exit(0);
  }

  console.error(evaluation.message);
  if (evaluation.details) {
    console.error(evaluation.details);
  }
  process.exit(1);
}

if (isDirectRunPath(process.argv[1])) {
  main();
}
