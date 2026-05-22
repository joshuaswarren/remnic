import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

test("root shared-context manager shim is exported and built as a package subpath", async () => {
  const [packageJsonRaw, tsupConfigRaw] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  assert.equal(pkg.exports?.["./shared-context/manager"]?.import, "./dist/shared-context/manager.js");
  assert.equal(pkg.exports?.["./shared-context/manager.js"]?.import, "./dist/shared-context/manager.js");
  assert.match(tsupConfigRaw, /"src\/shared-context\/manager\.ts"/);
});
