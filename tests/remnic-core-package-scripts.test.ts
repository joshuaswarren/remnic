import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("remnic-core package-local test script declares its runner", async () => {
  const raw = await readFile(path.join(repoRoot, "packages", "remnic-core", "package.json"), "utf8");
  const pkg = JSON.parse(raw) as PackageJson;
  const testScript = pkg.scripts?.test ?? "";

  assert.match(testScript, /\btsx\b/);
  assert.ok(
    pkg.dependencies?.tsx || pkg.devDependencies?.tsx,
    "packages/remnic-core must declare tsx because its local test script invokes it",
  );
});
