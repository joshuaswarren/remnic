import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Biome lint gate is wired into local preflight and CI", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const preflight = await readFile("scripts/pr-preflight.sh", "utf8");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(packageJson.devDependencies?.["@biomejs/biome"] ?? "", /\d+\.\d+\.\d+/);
  assert.match(packageJson.scripts?.lint ?? "", /biome check/);
  assert.match(preflight, /run npm run lint/);
  assert.match(ci, /run: pnpm run lint/);
});
