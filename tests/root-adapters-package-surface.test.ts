import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

async function adapterShimNames(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, "src", "adapters"), {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name.replace(/\.ts$/, ""))
    .sort();
}

test("root adapter shims are exported and built as package subpaths", async () => {
  const [packageJsonRaw, tsupConfigRaw, names] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
    adapterShimNames(),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  assert.ok(names.length > 0, "expected root adapter shims");
  assert.equal(pkg.exports?.["./adapters"]?.import, "./dist/adapters/index.js");
  assert.equal(pkg.exports?.["./adapters.js"]?.import, "./dist/adapters/index.js");

  for (const name of names) {
    const subpath = `./adapters/${name}`;
    const jsSubpath = `${subpath}.js`;
    const distPath = `./dist/adapters/${name}.js`;

    assert.equal(pkg.exports?.[subpath]?.import, distPath);
    assert.equal(pkg.exports?.[jsSubpath]?.import, distPath);
    assert.match(tsupConfigRaw, new RegExp(`"src/adapters/${name}\\.ts"`));
  }
});
