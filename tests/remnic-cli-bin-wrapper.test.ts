import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
