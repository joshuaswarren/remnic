import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RootPackageJson = {
  exports?: Record<string, { import?: string }>;
};

const SESSION_OBSERVER_SHIMS = [
  "session-observer-bands",
  "session-observer-state",
] as const;

test("root session observer shims are exported and built as package subpaths", async () => {
  const [packageJsonRaw, tsupConfigRaw] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "tsup.config.ts"), "utf8"),
  ]);
  const pkg = JSON.parse(packageJsonRaw) as RootPackageJson;

  for (const name of SESSION_OBSERVER_SHIMS) {
    const subpath = `./${name}`;
    const jsSubpath = `${subpath}.js`;
    const distPath = `./dist/${name}.js`;

    assert.equal(pkg.exports?.[subpath]?.import, distPath);
    assert.equal(pkg.exports?.[jsSubpath]?.import, distPath);
    assert.match(tsupConfigRaw, new RegExp(`"src/${name}\\.ts"`));
  }
});
