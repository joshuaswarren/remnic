import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  if (process.platform === "win32") {
    copyFileSync(process.execPath, path.join(bin, "node.exe"));
    writeFileSync(path.join(bin, "npm.cmd"), '@echo off\r\necho %*>>"%REMNIC_PNPM_TEST_LOG%"\r\n');
  } else {
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
  }
  return { root, bin, log };
}

test("routes a root pnpm script through the pinned wrapper without pnpm on PATH", () => {
  const fixture = createFakeNpm();
  const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const wrapperArgs = /^node scripts\/pnpm\.mjs (.+)$/.exec(scripts["plugin:inspect"])?.[1]?.split(" ");

  try {
    assert.deepEqual(wrapperArgs, ["--filter", "@remnic/plugin-openclaw", "run", "plugin:inspect"]);
    const result = spawnSync(process.execPath, ["scripts/pnpm.mjs", ...wrapperArgs], {
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

test("runs source-condition root pnpm scripts without shell-specific environment syntax", () => {
  const fixture = createFakeNpm();
  const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const scriptNames = ["test:openclaw-scenarios", "test:openclaw-privacy"];

  try {
    for (const scriptName of scriptNames) {
      const scriptParts = scripts[scriptName].split(" ");
      assert.equal(scriptParts[0], "node");
      assert.equal(scriptParts[1], "scripts/with-source-conditions.mjs");
      const result = spawnSync(process.execPath, scriptParts.slice(1), {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: fixture.bin,
          REMNIC_PNPM_TEST_LOG: fixture.log,
        },
      });
      assert.equal(result.status, 0, `${scriptName}: ${result.stderr}`);
    }

    const calls = readFileSync(fixture.log, "utf8");
    assert.match(
      calls,
      /exec --yes pnpm@10\.32\.1 -- exec tsx --test tests\/openclaw-adapter-scenarios\.test\.ts/,
    );
    assert.match(
      calls,
      /exec --yes pnpm@10\.32\.1 -- exec tsx --test tests\/openclaw-hook-privacy\.test\.ts/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
