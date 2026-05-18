import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("root typecheck covers package tsconfigs", () => {
  const rootPkg = readJson<PackageJson>(join(repoRoot, "package.json"));
  const rootCheckTypes = rootPkg.scripts?.["check-types"] ?? "";

  assert.match(rootCheckTypes, /\bpnpm --filter @remnic\/core build\b/);
  assert.match(rootCheckTypes, /\btsc --noEmit\b/);
  assert.match(rootCheckTypes, /\bpnpm --recursive\b/);
  assert.match(rootCheckTypes, /--if-present/);
  assert.match(rootCheckTypes, /--filter="\.\/packages\/\*"/);
  assert.doesNotMatch(rootCheckTypes, /--filter '\.\/packages\/\*'/);
  assert.match(rootCheckTypes, /\brun check-types\b/);

  const packagesDir = join(repoRoot, "packages");
  const packageNamesWithTsconfig = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesDir, name, "tsconfig.json")))
    .sort();

  const packagesMissingCheckTypes = packageNamesWithTsconfig
    .filter((name) => {
      const pkg = readJson<PackageJson>(join(packagesDir, name, "package.json"));
      return !pkg.scripts?.["check-types"];
    })
    .sort();

  assert.deepEqual(packagesMissingCheckTypes, []);

  const packagesMissingCorePrecheck = packageNamesWithTsconfig
    .filter((name) => {
      const pkg = readJson<PackageJson>(join(packagesDir, name, "package.json"));
      const usesCore =
        Boolean(pkg.dependencies?.["@remnic/core"]) ||
        Boolean(pkg.devDependencies?.["@remnic/core"]) ||
        Boolean(pkg.peerDependencies?.["@remnic/core"]);
      return (
        usesCore &&
        pkg.name !== "@remnic/plugin-openclaw" &&
        !pkg.scripts?.["precheck-types"]
      );
    })
    .sort();

  assert.deepEqual(packagesMissingCorePrecheck, []);
});
