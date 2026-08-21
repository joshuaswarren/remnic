import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function recipeForTarget(makefile, target) {
  const pattern = new RegExp(`^${target}:\\n((?:\\t.*\\n)+)`, "m");
  const match = makefile.match(pattern);
  assert.ok(match, `expected ${target} target in Makefile`);
  return match[1];
}

test("Makefile package-script quality gates use pnpm run", () => {
  const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");

  assert.match(recipeForTarget(makefile, "preflight"), /\tpnpm run preflight\n/);
  assert.match(recipeForTarget(makefile, "preflight-quick"), /\tpnpm run preflight:quick\n/);
});
