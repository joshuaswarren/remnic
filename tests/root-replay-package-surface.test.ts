import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

async function replayShimNames(directory = path.join(repoRoot, "src", "replay")): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return replayShimNames(absolutePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return [];
      }

      const relativePath = path.relative(path.join(repoRoot, "src", "replay"), absolutePath);
      return [relativePath.replace(/\.ts$/, "").split(path.sep).join("/")];
    }),
  );

  return names.flat().sort();
}

test("root replay shims are exported and built as package subpaths", async () => {
  const [packageJsonRaw, tsupConfigRaw, names] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
    replayShimNames(),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  assert.ok(names.length > 0, "expected root replay shims");

  for (const name of names) {
    const subpath = `./replay/${name}`;
    const jsSubpath = `${subpath}.js`;
    const distPath = `./dist/replay/${name}.js`;

    assert.equal(pkg.exports?.[subpath]?.import, distPath);
    assert.equal(pkg.exports?.[jsSubpath]?.import, distPath);
    assert.match(tsupConfigRaw, new RegExp(`"src/replay/${name}\\.ts"`));
  }
});
