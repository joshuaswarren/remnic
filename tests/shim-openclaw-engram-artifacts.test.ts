import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHIM_DIR = path.join(ROOT, "packages", "shim-openclaw-engram");

test("shim package build emits declarations for package exports", async () => {
  const result = spawnSync("pnpm", ["--filter", "@joshuaswarren/openclaw-engram", "run", "build"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  assert.equal(existsSync(path.join(SHIM_DIR, "dist", "index.d.ts")), true);
  assert.equal(existsSync(path.join(SHIM_DIR, "dist", "access-cli.d.ts")), true);

  const pkg = JSON.parse(await readFile(path.join(SHIM_DIR, "package.json"), "utf8")) as {
    types?: string;
    exports?: Record<string, { types?: string }>;
  };
  assert.equal(pkg.types, "dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts");
  assert.equal(pkg.exports?.["./access-cli"]?.types, "./dist/access-cli.d.ts");
});
