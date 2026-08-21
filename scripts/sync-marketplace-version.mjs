/**
 * sync-marketplace-version.mjs
 *
 * Reads the version from the root package.json and updates the version field
 * in the root marketplace.json to keep them in sync during releases.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const pkgPath = path.resolve(repoRoot, "package.json");
const marketplacePath = path.resolve(repoRoot, "marketplace.json");

const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
const marketplace = JSON.parse(await readFile(marketplacePath, "utf-8"));

if (Array.isArray(marketplace.plugins)) {
  for (const plugin of marketplace.plugins) {
    if (plugin.name === "remnic") {
      plugin.version = pkg.version;
    }
  }
}

await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
console.log(`marketplace.json updated to version ${pkg.version}`);
