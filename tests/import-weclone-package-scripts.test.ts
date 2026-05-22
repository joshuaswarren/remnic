import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
  scripts?: Record<string, string>;
};

test("import-weclone test script avoids POSIX-only quoted globs", async () => {
  const raw = await readFile(path.join(repoRoot, "packages", "import-weclone", "package.json"), "utf8");
  const pkg = JSON.parse(raw) as PackageJson;
  const testScript = pkg.scripts?.test ?? "";

  assert.match(testScript, /\btsx --test\b/);
  assert.match(testScript, /src\/\*\*\/\*\.test\.ts/);
  assert.doesNotMatch(testScript, /['"]src\/\*\*\/\*\.test\.ts['"]/);
});
