import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

async function transferShimNames(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, "src", "transfer"), {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name.replace(/\.ts$/, ""))
    .sort();
}

test("root transfer shims are exported and built as package subpaths", async () => {
  const [packageJsonRaw, tsupConfigRaw, names] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
    transferShimNames(),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  assert.ok(names.length > 0, "expected root transfer shims");

  for (const name of names) {
    const subpath = `./transfer/${name}`;
    const jsSubpath = `${subpath}.js`;
    const distPath = `./dist/transfer/${name}.js`;

    assert.equal(pkg.exports?.[subpath]?.import, distPath);
    assert.equal(pkg.exports?.[jsSubpath]?.import, distPath);
    assert.match(tsupConfigRaw, new RegExp(`"src/transfer/${name}\\.ts"`));
  }
});

test("root migration shim is exported and built as a package subpath", async () => {
  const [packageJsonRaw, tsupConfigRaw] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  assert.equal(pkg.exports?.["./migrate/from-engram"]?.import, "./dist/migrate/from-engram.js");
  assert.equal(pkg.exports?.["./migrate/from-engram.js"]?.import, "./dist/migrate/from-engram.js");
  assert.match(tsupConfigRaw, /"src\/migrate\/from-engram\.ts"/);
});
