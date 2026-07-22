import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

test("download-model downloads a named model beneath the capture directory", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "cap-cli-"));
  const output: string[] = [];

  const code = await runCapture({
    argv: ["download-model", "--model", "small", "--base-dir", baseDir],
    stdout: (line) => output.push(line),
    downloadModel: async (input) => {
      assert.equal(input.model, "small");
      assert.equal(input.directory, path.join(baseDir, "models"));
      return { path: path.join(input.directory, "ggml-small.bin"), downloaded: true };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(output, [`downloaded small to ${path.join(baseDir, "models", "ggml-small.bin")}`]);
});

test("janitor applies configured raw-audio retention", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "cap-cli-"));
  const rawDirectory = path.join(baseDir, "raw");
  await mkdir(rawDirectory);
  await writeFile(path.join(rawDirectory, "expired.wav"), "audio");
  const output: string[] = [];

  const code = await runCapture({ argv: ["janitor", "--base-dir", baseDir], stdout: (line) => output.push(line) });

  assert.equal(code, 0);
  assert.deepEqual(output, ["janitor: removed 1 expired raw audio file(s)"]);
  assert.equal(existsSync(path.join(rawDirectory, "expired.wav")), false);
});
