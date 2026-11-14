import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Node has no `sqlite` module without the `node:` prefix, so a bundle that drops the prefix
// fails with ERR_MODULE_NOT_FOUND the moment a daemon starts.
test("the built daemon keeps the node: prefix on node:sqlite", { timeout: 120_000 }, () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "capture-dist-"));
  const tsupBin = path.join(path.dirname(createRequire(import.meta.url).resolve("tsup/package.json")), "dist", "cli-default.js");
  execFileSync(process.execPath, [tsupBin, "--config", "tsup.config.ts", "--out-dir", outDir], { cwd: pkgDir, stdio: "pipe" });
  const bundle = readdirSync(outDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(path.join(outDir, name), "utf8"))
    .join("\n");
  rmSync(outDir, { recursive: true, force: true });
  assert.ok(bundle.includes('from "node:sqlite"'), "node:sqlite is imported with its prefix");
  assert.ok(!bundle.includes('from "sqlite"'), "no bare sqlite import");
});
