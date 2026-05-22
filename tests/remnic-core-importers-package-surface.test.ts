import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
  exports?: Record<string, { types?: string; "remnic-source"?: string; import?: string }>;
};

test("@remnic/core exposes the importers public subpath", async () => {
  const packageJsonRaw = await readFile(
    path.join(repoRoot, "packages", "remnic-core", "package.json"),
    "utf8",
  );
  const pkg = JSON.parse(packageJsonRaw) as PackageJson;
  const expected = {
    types: "./src/importers/index.ts",
    "remnic-source": "./src/importers/index.ts",
    import: "./dist/importers/index.js",
  };

  assert.deepEqual(pkg.exports?.["./importers"], expected);
  assert.deepEqual(pkg.exports?.["./importers.js"], expected);
  assert.deepEqual(pkg.exports?.["./importers/index"], expected);
  assert.deepEqual(pkg.exports?.["./importers/index.js"], expected);
});
