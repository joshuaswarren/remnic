import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { runCapture } from "./cli.js";
import { writePidFile } from "./control.js";
import { capturePaths } from "./paths.js";

async function withBaseDir(fn: (baseDir: string) => Promise<void>): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "cap-cli-"));
  try {
    await fn(baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

/** Spawn a throwaway process, wait for it to exit, and return its (now-dead) pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  await once(child, "exit");
  return child.pid;
}

test("start preserves an alive daemon pid without spawning another daemon", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writePidFile(paths.pidPath, process.pid);
    const output: string[] = [];
    const code = await runCapture({ argv: ["start", "--base-dir", baseDir], stdout: (line) => output.push(line) });
    assert.equal(code, 0);
    assert.deepEqual(output, [`daemon already running (pid ${process.pid})`]);
    assert.equal(existsSync(paths.pidPath), true);
  });
});

test("stop retains the pid file until the daemon exits", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
    assert.ok(child.pid);
    try {
      writePidFile(paths.pidPath, child.pid);
      const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined });
      assert.equal(code, 0);
      assert.equal(existsSync(paths.pidPath), true);
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
});

test("stop with no pid file reports not running", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const output: string[] = [];
    const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: (l) => output.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(output, ["daemon not running"]);
    assert.equal(existsSync(paths.pidPath), false);
  });
});

test("stop with a stale pid file reports not running and clears the file", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writePidFile(paths.pidPath, await deadPid());
    const output: string[] = [];
    const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: (l) => output.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(output, ["daemon not running"]);
    assert.equal(existsSync(paths.pidPath), false);
  });
});

test("status with a malformed pid file reports not running", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(paths.pidPath), { recursive: true });
    writeFileSync(paths.pidPath, "not-json", "utf8");
    const output: string[] = [];
    const code = await runCapture({ argv: ["status", "--base-dir", baseDir], stdout: (l) => output.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(output, ["status: not running"]);
  });
});
