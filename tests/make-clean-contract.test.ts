import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("make clean removes root and workspace package dist artifacts", () => {
  const makefile = readFileSync(join(repoRoot, "Makefile"), "utf8");

  assert.match(makefile, /^clean:\n\trm -rf dist\/ packages\/\*\/dist$/m);
});
