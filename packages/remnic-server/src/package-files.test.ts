import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The `remnic-source` export points at src/index.ts, so a source-condition consumer resolves its relative imports
// from the published package. A module missing from `files` breaks them (review of #3258).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every relative import of src/index.ts is listed in the package files", () => {
  // SAFETY: package.json of this package always has a `files` array; the assertions below fail loudly if not.
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };
  const source = readFileSync(path.join(root, "src/index.ts"), "utf8");
  const imported = [...source.matchAll(/from\s+"\.\/([A-Za-z0-9_-]+)\.js"/g)].map((match) => `src/${match[1]}.ts`);
  assert.ok(imported.length > 0, "the entry imports at least one sibling module");
  for (const file of imported) assert.ok(pkg.files.includes(file), `${file} is imported by src/index.ts but missing from files`);
});
