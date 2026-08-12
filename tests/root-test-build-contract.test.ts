import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

test("root build creates the OpenClaw adapter before bundling its public route", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const buildScript = pkg.scripts?.build ?? "";
  assert.match(
    buildScript,
    /^pnpm --filter @remnic\/core build && pnpm --filter @remnic\/plugin-openclaw build && /,
  );
});

test("root development creates the OpenClaw adapter before watching its public route", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const devScript = pkg.scripts?.dev ?? "";
  assert.match(devScript, /^pnpm --filter @remnic\/plugin-openclaw build && tsup --watch$/);
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

  // Pattern coverage now lives in root-test-runner-lib.mjs as structured
  // entries (#1538); the runner consumes them via expandTestPatterns and
  // must keep the probe + vacuous-pattern guards wired.
  const lib = readFileSync(join(repoRoot, "scripts", "root-test-runner-lib.mjs"), "utf8");
  assert.match(lib, /id: "tests\/\*\*\/\*\.test\.ts"/);
  assert.match(lib, /id: "tests\/\*\*\/\*\.test\.mjs"/);
  assert.match(lib, /id: "packages\/\*\/src\/\*\*\/\*\.test\.ts"/);
  assert.match(lib, /id: "packages\/\*\/src\/\*\*\/\*\.test\.tsx"/);
  assert.match(lib, /id: "dashboard\/lib\/\*\.test\.ts"/);
  assert.match(lib, /id: "integrations\/amb\/\*\.test\.mjs"/);

  const script = readFileSync(join(repoRoot, "scripts", "run-root-tests.mjs"), "utf8");
  assert.match(script, /expandTestPatterns/);
  assert.match(script, /probeBetterSqlite3/);
  assert.match(script, /REMNIC_REQUIRE_NATIVE_TESTS/);
  assert.match(script, /emptyPatterns/);
  assert.match(script, /cwd: repoRoot/);
  assert.match(script, /process\.platform === "win32" \? "tsx\.cmd" : "tsx"/);
  assert.doesNotMatch(script, /shell:/);
});

test("root test runner ensures @remnic/bench dist before running tests (#1609)", () => {
  // Regression guard for the fresh-clone failure: the runner MUST ensure
  // @remnic/bench dist exists before spawning tsx --test, otherwise
  // tests/remnic-cli-dataset-resolution.test.ts triggers the optional-bench
  // tsImport fallback which poisons subsequent dynamic .ts imports.
  // See issue #1609 and scripts/run-root-tests.mjs.
  const script = readFileSync(join(repoRoot, "scripts", "run-root-tests.mjs"), "utf8");
  assert.match(
    script,
    /ensurePackageBuild/,
    "run-root-tests.mjs must call ensurePackageBuild so a fresh clone without a prior build still passes",
  );
  assert.match(
    script,
    /"@remnic\/bench"/,
    "run-root-tests.mjs must ensure the @remnic/bench package specifically",
  );
  assert.match(
    script,
    /join\(repoRoot,\s*"packages",\s*"bench",\s*"dist",\s*"index\.js"\)/,
    "run-root-tests.mjs must target the bench dist entry (packages/bench/dist/index.js) as the build artifact",
  );
});
