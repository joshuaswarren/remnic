import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

const maintenanceDir = path.resolve(import.meta.dirname, "../src/maintenance");
const publicCoreMaintenanceExport = /from\s+["']@remnic\/core\/maintenance\/[^"']+["'];?/;
const privatePackageSourceReference = /["'][^"']*(?:packages\/[^"']*\/src\/|@remnic\/[^"']*\/src\/)[^"']*["']/;

test("root maintenance shims only re-export public core maintenance entrypoints", async () => {
  const entries = await readdir(maintenanceDir, { withFileTypes: true });
  const shimFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();

  assert.notEqual(shimFiles.length, 0, "expected maintenance shims to be present");

  for (const fileName of shimFiles) {
    const source = await readFile(path.join(maintenanceDir, fileName), "utf-8");

    assert.match(
      source,
      publicCoreMaintenanceExport,
      `${fileName} must use the public @remnic/core maintenance package export`,
    );
    assert.doesNotMatch(
      source,
      privatePackageSourceReference,
      `${fileName} must not import or export private package source files`,
    );
  }
});
