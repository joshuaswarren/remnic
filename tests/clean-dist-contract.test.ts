import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("clean-dist removes root and workspace package dist artifacts", () => {
  const tempRoot = mkdtempSync(join(os.tmpdir(), "remnic-clean-dist-"));
  const externalPackage = join(tempRoot, "external-package");
  const fixture = join(tempRoot, "repo");

  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "dist"), { recursive: true });
    mkdirSync(join(fixture, "packages", "real", "dist"), { recursive: true });
    mkdirSync(join(externalPackage, "dist"), { recursive: true });
    writeFileSync(join(fixture, "dist", "root.txt"), "root");
    writeFileSync(join(fixture, "packages", "real", "dist", "real.txt"), "real");
    writeFileSync(join(externalPackage, "dist", "external.txt"), "external");
    symlinkSync(externalPackage, join(fixture, "packages", "linked"), "dir");
    cpSync(join(repoRoot, "scripts", "clean-dist.mjs"), join(fixture, "scripts", "clean-dist.mjs"));

    execFileSync(process.execPath, ["scripts/clean-dist.mjs"], { cwd: fixture, stdio: "pipe" });

    assert.equal(existsSync(join(fixture, "dist")), false);
    assert.equal(existsSync(join(fixture, "packages", "real", "dist")), false);
    assert.equal(existsSync(join(externalPackage, "dist", "external.txt")), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

