import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "ensure-better-sqlite3.mjs",
);

test("better-sqlite3 postinstall rebuild never fetches node-gyp implicitly", () => {
  const script = readFileSync(scriptPath, "utf8");

  assert.doesNotMatch(script, /--yes/);
  assert.doesNotMatch(script, /npm["'],\s*\[\s*["']exec/);
  assert.match(script, /Refusing to fetch and execute an unpinned node-gyp/);
});
