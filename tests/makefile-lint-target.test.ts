import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("make lint delegates to an existing type-check script", () => {
  const dryRun = spawnSync("make", ["-n", "lint"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /\bnpm run check-types\b/);
  assert.doesNotMatch(dryRun.stdout, /\bnpm run lint\b/);

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(typeof pkg.scripts?.["check-types"], "string");
});
