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

  assert.match(rootCheckTypes, /\bnode scripts\/pnpm\.mjs --filter @remnic\/core build\b/);
  assert.match(rootCheckTypes, /\btsc --noEmit\b/);
  assert.match(rootCheckTypes, /\bnode scripts\/check-type-packages\.mjs --run\b/);
  assert.doesNotMatch(rootCheckTypes, /\bnode scripts\/pnpm\.mjs --recursive\b/);

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

  assert.deepEqual(
    packagesMissingCheckTypes,
    [],
    packagesMissingCheckTypes.length ? `add scripts.check-types to: ${packagesMissingCheckTypes.join(", ")}` : "",
  );

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

  assert.deepEqual(
    packagesMissingCorePrecheck,
    [],
    packagesMissingCorePrecheck.length
      ? `add scripts.precheck-types (copy packages/connector-limitless) to: ${packagesMissingCorePrecheck.join(", ")}`
      : "",
  );
});
