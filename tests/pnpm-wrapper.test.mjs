import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFakeNpm() {
  const root = mkdtempSync(path.join(os.tmpdir(), "remnic-pnpm-wrapper-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "npm.log");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "npm"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$REMNIC_PNPM_TEST_LOG"\n',
  );
  chmodSync(path.join(bin, "npm"), 0o755);
  symlinkSync(process.execPath, path.join(bin, "node"));
  symlinkSync(
    spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(),
    path.join(bin, "bash"),
  );
  return { root, bin, log };
}

test("routes a root pnpm script through the pinned wrapper without pnpm on PATH", () => {
  const fixture = createFakeNpm();
  const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  try {
    const result = spawnSync("bash", ["-c", scripts["plugin:inspect"]], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: fixture.bin,
        REMNIC_PNPM_TEST_LOG: fixture.log,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(fixture.log, "utf8").trim(),
      "exec --yes pnpm@10.32.1 -- --filter @remnic/plugin-openclaw run plugin:inspect",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
