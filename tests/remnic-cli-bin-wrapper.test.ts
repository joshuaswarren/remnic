import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants as osConstants, tmpdir } from "node:os";

const packageBinDir = join(process.cwd(), "packages", "remnic-cli", "bin");
const remnicBin = join(packageBinDir, "remnic.cjs");
const engramBin = join(packageBinDir, "engram.cjs");

test("remnic package bins are executable on POSIX checkouts", async () => {
  if (process.platform === "win32") {
    return;
  }

  for (const binPath of [remnicBin, engramBin]) {
    const mode = (await stat(binPath)).mode;
    assert.notEqual(mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH), 0);
  }
});

test("package bin wrappers preserve child signal termination", async () => {
  if (process.platform === "win32") {
    return;
  }

  for (const sourceBin of [remnicBin, engramBin]) {
    const tempRoot = await mkdtemp(join(tmpdir(), "remnic-cli-bin-wrapper-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      const tempDistDir = join(tempRoot, "dist");
      await mkdir(tempBinDir, { recursive: true });
      await mkdir(tempDistDir, { recursive: true });

      const tempBin = join(tempBinDir, "wrapper.cjs");
      await copyFile(sourceBin, tempBin);
      await chmod(tempBin, 0o755);
      await writeFile(
        join(tempDistDir, "index.js"),
        'process.kill(process.pid, "SIGTERM");\n',
      );

      const result = spawnSync(process.execPath, [tempBin], { encoding: "utf8" });

      assert.equal(result.status, null);
      assert.equal(result.signal, "SIGTERM");
      assert.doesNotMatch(result.stderr, /Fatal:/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("package bin wrappers keep a failing exit code when a self-signal is ignored", async () => {
  if (process.platform === "win32") {
    return;
  }

  const sigpipeExitCode = 128 + osConstants.signals.SIGPIPE;

  for (const sourceBin of [remnicBin, engramBin]) {
    const tempRoot = await mkdtemp(join(tmpdir(), "remnic-cli-bin-wrapper-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      await mkdir(tempBinDir, { recursive: true });

      const tempBin = join(tempBinDir, "wrapper.cjs");
      const preload = join(tempRoot, "throw-sigpipe.cjs");
      await copyFile(sourceBin, tempBin);
      await chmod(tempBin, 0o755);
      await writeFile(
        preload,
        [
          'const childProcess = require("node:child_process");',
          "childProcess.execFileSync = () => {",
          '  const err = new Error("child terminated by SIGPIPE");',
          '  err.signal = "SIGPIPE";',
          "  throw err;",
          "};",
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        ["--require", preload, tempBin],
        { encoding: "utf8" },
      );

      assert.equal(result.status, sigpipeExitCode);
      assert.equal(result.signal, null);
      assert.doesNotMatch(result.stderr, /Fatal:/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});
