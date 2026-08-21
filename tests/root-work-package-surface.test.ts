import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

async function workShimNames(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, "src", "work"), {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name.replace(/\.ts$/, ""))
    .sort();
}

test("root work shims are exported and built as package subpaths", async () => {
  const [packageJsonRaw, tsupConfigRaw, names] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
    workShimNames(),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  assert.ok(names.length > 0, "expected root work shims");

  for (const name of names) {
    const subpath = `./work/${name}`;
    const jsSubpath = `${subpath}.js`;
    const distPath = `./dist/work/${name}.js`;

    assert.equal(pkg.exports?.[subpath]?.import, distPath);
    assert.equal(pkg.exports?.[jsSubpath]?.import, distPath);
    assert.match(tsupConfigRaw, new RegExp(`"src/work/${name}\\.ts"`));
  }
});
