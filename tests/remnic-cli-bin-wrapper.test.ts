import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants as osConstants, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageBinDir = join(repoRoot, "packages", "remnic-cli", "bin");
const remnicCliPackageJson = join(repoRoot, "packages", "remnic-cli", "package.json");
const remnicBin = join(packageBinDir, "remnic.cjs");
const engramBin = join(packageBinDir, "engram.cjs");

test("@remnic/cli package test script includes linked root tests", async () => {
  const raw = await readFile(remnicCliPackageJson, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);

  const scripts = (parsed as Record<string, unknown>).scripts;
  assert.equal(typeof scripts, "object");
  assert.notEqual(scripts, null);
  assert.equal(Array.isArray(scripts), false);

  const testScript = (scripts as Record<string, unknown>).test;
  assert.equal(typeof testScript, "string");
  const testScriptText = testScript as string;
  assert.match(testScriptText, /tests\/evals-engram-adapter-buffering\.test\.ts/);
  assert.match(testScriptText, /tests\/shim-openclaw-engram-package\.test\.ts/);
  assert.match(testScriptText, /tests\/engram-access-bin-errors\.test\.ts/);
  assert.match(testScriptText, /tests\/remnic-cli-bench-surface\.test\.ts/);
  assert.match(testScriptText, /tests\/remnic-cli-bench-ui-surface\.test\.ts/);
  assert.match(testScriptText, /tests\/bench-remnic-deterministic-runners\.test\.ts/);
  assert.match(testScriptText, /tests\/bench-remnic-stateful-runners\.test\.ts/);
});

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

test("package bin wrappers report a clear missing build artifact error", async () => {
  for (const sourceBin of [remnicBin, engramBin]) {
    const tempRoot = await mkdtemp(join(tmpdir(), "remnic-cli-bin-wrapper-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      await mkdir(tempBinDir, { recursive: true });

      const tempBin = join(tempBinDir, "wrapper.cjs");
      await copyFile(sourceBin, tempBin);
      await chmod(tempBin, 0o755);

      const result = spawnSync(process.execPath, [tempBin], { encoding: "utf8" });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /built CLI entrypoint is missing:/);
      assert.match(result.stderr, /Rebuild or reinstall @remnic\/cli/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("package bin wrappers report a clear missing tsx runtime error", async () => {
  for (const sourceBin of [remnicBin, engramBin]) {
    const tempRoot = await mkdtemp(join(tmpdir(), "remnic-cli-bin-wrapper-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      const tempSrcDir = join(tempRoot, "src");
      await mkdir(tempBinDir, { recursive: true });
      await mkdir(tempSrcDir, { recursive: true });

      const tempBin = join(tempBinDir, "wrapper.cjs");
      await copyFile(sourceBin, tempBin);
      await chmod(tempBin, 0o755);
      await writeFile(join(tempSrcDir, "index.ts"), "process.exit(0);\n");

      const result = spawnSync(process.execPath, [tempBin], { encoding: "utf8" });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /tsx runtime is missing for source CLI entrypoint:/);
      assert.match(result.stderr, /Install dependencies or rebuild @remnic\/cli/);
      assert.doesNotMatch(result.stderr, /built CLI entrypoint is missing:/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("package bin wrappers do not inject FORCE_COLOR", async () => {
  for (const sourceBin of [remnicBin, engramBin]) {
    const tempRoot = await mkdtemp(join(tmpdir(), "remnic-cli-bin-wrapper-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      const tempDistDir = join(tempRoot, "dist");
      await mkdir(tempBinDir, { recursive: true });
      await mkdir(tempDistDir, { recursive: true });

      const tempBin = join(tempBinDir, "wrapper.cjs");
      const preload = join(tempRoot, "capture-env.cjs");
      await copyFile(sourceBin, tempBin);
      await chmod(tempBin, 0o755);
      await writeFile(join(tempDistDir, "index.js"), "process.exit(0);\n");
      await writeFile(
        preload,
        [
          'const childProcess = require("node:child_process");',
          "childProcess.execFileSync = (_cmd, _args, options) => {",
          '  if (Object.prototype.hasOwnProperty.call(options.env, "FORCE_COLOR")) {',
          '    const err = new Error("FORCE_COLOR was injected");',
          "    err.status = 42;",
          "    throw err;",
          "  }",
          "};",
          "",
        ].join("\n"),
      );

      const env = { ...process.env };
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      const result = spawnSync(process.execPath, ["--require", preload, tempBin], {
        encoding: "utf8",
        env,
      });

      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stderr, /FORCE_COLOR was injected/);
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
      const tempDistDir = join(tempRoot, "dist");
      await mkdir(tempBinDir, { recursive: true });
      await mkdir(tempDistDir, { recursive: true });

      const tempBin = join(tempBinDir, "wrapper.cjs");
      const preload = join(tempRoot, "throw-sigpipe.cjs");
      await copyFile(sourceBin, tempBin);
      await chmod(tempBin, 0o755);
      await writeFile(join(tempDistDir, "index.js"), "process.exit(0);\n");
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
