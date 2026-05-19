import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(testScript, /"packages\/\*\/src\/\*\*\/\*\.test\.ts"/);
  assert.doesNotMatch(
    testScript,
    /'[^']*\*[^']*'/,
    "npm scripts should not use POSIX-only single quotes around glob arguments",
  );
});
