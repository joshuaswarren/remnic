import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("root test script builds core before running package tests", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const testScript = pkg.scripts?.test ?? "";
  assert.match(testScript, /^pnpm --filter @remnic\/core build && /);
  assert.match(testScript, /node scripts\/run-root-tests\.mjs/);
  assert.doesNotMatch(
    testScript,
    /'[^']*\*[^']*'/,
    "npm scripts should not use POSIX-only single quotes around glob arguments",
  );
  assert.doesNotMatch(
    testScript,
    /(?:^|&&|\|\||;)\s*[A-Za-z_][A-Za-z0-9_]*=/,
    "root package scripts should not use POSIX-only inline environment assignment",
  );
});

test("root test runner applies remnic source conditions and test globs portably", () => {
  const helperCheck = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "import assert from 'node:assert/strict';",
        "import { appendNodeOption } from './scripts/root-test-runner-env.mjs';",
        "assert.equal(appendNodeOption(undefined, '--conditions=remnic-source'), '--conditions=remnic-source');",
        "assert.equal(appendNodeOption('--trace-warnings', '--conditions=remnic-source'), '--trace-warnings --conditions=remnic-source');",
      ].join("\n"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(helperCheck.status, 0, helperCheck.stderr);

  const script = readFileSync(join(repoRoot, "scripts", "run-root-tests.mjs"), "utf8");
  assert.match(script, /"tests\/\*\*\/\*\.test\.ts"/);
  assert.match(script, /"packages\/\*\/src\/\*\*\/\*\.test\.ts"/);
  assert.match(script, /"packages\/\*\/src\/\*\*\/\*\.test\.tsx"/);
  assert.match(script, /"dashboard\/lib\/\*\.test\.ts"/);
  assert.match(script, /"integrations\/amb\/\*\.test\.mjs"/);
  assert.match(script, /cwd: repoRoot/);
  assert.match(script, /process\.platform === "win32" \? "tsx\.cmd" : "tsx"/);
  assert.doesNotMatch(script, /shell:/);
});
