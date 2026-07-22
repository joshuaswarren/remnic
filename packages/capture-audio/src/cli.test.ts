import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { runCapture } from "./cli.js";
import { writePidFile } from "./control.js";
import { capturePaths } from "./paths.js";

test("start preserves an alive daemon pid without spawning another daemon", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "cap-cli-"));
  const paths = capturePaths(baseDir);
  writePidFile(paths.pidPath, process.pid);
  const output: string[] = [];

  const code = await runCapture({ argv: ["start", "--base-dir", baseDir], stdout: (line) => output.push(line) });

  assert.equal(code, 0);
  assert.deepEqual(output, [`daemon already running (pid ${process.pid})`]);
  assert.equal(existsSync(paths.pidPath), true);
});

test("stop retains the pid file until the daemon exits", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "cap-cli-"));
  const paths = capturePaths(baseDir);
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
  assert.ok(child.pid);
  writePidFile(paths.pidPath, child.pid);

  const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined });

  assert.equal(code, 0);
  assert.equal(existsSync(paths.pidPath), true);
  await once(child, "exit");
});
