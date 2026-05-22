import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

const sourceGroupShims = ["qmd", "reconstruct"] as const;

test("root source-group shims are exported and built as package subpaths", async () => {
  const [packageJsonRaw, tsupConfigRaw] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  for (const name of sourceGroupShims) {
    const distPath = `./dist/${name}.js`;

    assert.equal(pkg.exports?.[`./${name}`]?.import, distPath);
    assert.equal(pkg.exports?.[`./${name}.js`]?.import, distPath);
    assert.match(tsupConfigRaw, new RegExp(`"src/${name}\\.ts"`));
  }
});
