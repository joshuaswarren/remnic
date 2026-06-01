import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PackageJson = {
  scripts?: Record<string, string>;
};

test("import-weclone test script runs explicit files against workspace source exports", async () => {
  const raw = await readFile(path.join(repoRoot, "packages", "import-weclone", "package.json"), "utf8");
  const pkg = JSON.parse(raw) as PackageJson;
  const testScript = pkg.scripts?.test ?? "";

  assert.match(testScript, /\bNODE_OPTIONS=/);
  assert.match(testScript, /--conditions=remnic-source\b/);
  assert.match(testScript, /\btsx --test\b/);
  const testScriptParts = testScript.split(/\s+/);
  for (const testFile of [
    "src/adapter.test.ts",
    "src/chunker.test.ts",
    "src/integration.test.ts",
    "src/parser.test.ts",
    "src/participant.test.ts",
    "src/progress.test.ts",
    "src/threader.test.ts",
  ]) {
    assert.ok(testScriptParts.includes(testFile), `${testFile} missing from import-weclone test script`);
  }
  assert.doesNotMatch(testScript, /src\/\*\*\/\*\.test\.ts/);
});
