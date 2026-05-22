import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(repoRoot, "packages");

type PackageJson = {
  name?: string;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

test("published package peer dependencies never use workspace protocol", () => {
  const failures: string[] = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(packagePath)) continue;
    const pkg = readPackageJson(packagePath);
    if (pkg.private === true) continue;

    for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
      if (spec.startsWith("workspace:")) {
        failures.push(`${pkg.name ?? entry.name} peer ${name} uses ${spec}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("@remnic/import-mem0 publishes a semver @remnic/core peer range", () => {
  const pkg = readPackageJson(join(packagesDir, "import-mem0", "package.json"));
  const corePkg = readPackageJson(join(packagesDir, "remnic-core", "package.json"));
  const peerSpec = pkg.peerDependencies?.["@remnic/core"];

  assert.equal(pkg.name, "@remnic/import-mem0");
  assert.equal(peerSpec, `^${corePkg.version}`);
  assert.doesNotMatch(peerSpec ?? "", /^workspace:/);
  assert.match(peerSpec ?? "", /^\^\d+\.\d+\.\d+$/);
});

test("@remnic/import-gemini publishes @remnic/core as a peer dependency", () => {
  const pkg = readPackageJson(join(packagesDir, "import-gemini", "package.json")) as PackageJson & {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const corePkg = readPackageJson(join(packagesDir, "remnic-core", "package.json"));
  const peerSpec = pkg.peerDependencies?.["@remnic/core"];

  assert.equal(pkg.name, "@remnic/import-gemini");
  assert.equal(peerSpec, `^${corePkg.version}`);
  assert.equal(pkg.dependencies?.["@remnic/core"], undefined);
  assert.equal(pkg.devDependencies?.["@remnic/core"], "workspace:*");
});
