import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Architecture boundary (issue #2045): `@remnic/core` must never statically
 * depend on an optional provider package. Provider implementations register
 * through the location registry at runtime; the connector package consumes
 * core, never the reverse. A static import here would break à-la-carte
 * installs (`npm install @remnic/core` alone must work) and drag a network
 * adapter into every base install.
 */
const FORBIDDEN_SPECIFIERS = ["@remnic/connector-reitti", "connector-reitti/src"];

// Production sources only: this test file itself names the banned specifier.
function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      collectSourceFiles(path, files);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test("core source never statically imports @remnic/connector-reitti", () => {
  // The whole core tree, not just src/location: a static import anywhere in
  // core would break a base install.
  const coreSrc = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  for (const file of collectSourceFiles(coreSrc)) {
    const content = readFileSync(file, "utf8");
    for (const specifier of FORBIDDEN_SPECIFIERS) {
      if (content.includes(specifier)) {
        offenders.push(`${file} references ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
