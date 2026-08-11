import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  readCleanCommitSha,
  runCleanupSteps,
  validateOutputDirectory,
  waitForResult,
} from "./live-demo-runtime.mjs";

const execFileAsync = promisify(execFile);

test("validateOutputDirectory rejects an existing file before a demo run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await validateOutputDirectory(path.join(root, "missing"));
  await validateOutputDirectory(root);
  const filePath = path.join(root, "receipt-target");
  await writeFile(filePath, "not a directory\n");
  await assert.rejects(validateOutputDirectory(filePath), /output path must be a directory/);
});

test("waitForResult polls until an asynchronous result is durable", async () => {
  let clock = 0;
  let reads = 0;
  const result = await waitForResult(
    async () => {
      reads += 1;
      if (reads < 3) throw new Error("not durable yet");
      return "ready";
    },
    {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    }
  );

  assert.equal(result, "ready");
  assert.equal(reads, 3);
});

test("waitForResult returns the last error after its bounded deadline", async () => {
  let clock = 0;
  let reads = 0;
  await assert.rejects(
    waitForResult(
      async () => {
        reads += 1;
        throw new Error(`not ready ${reads}`);
      },
      {
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => clock,
        delay: async (milliseconds) => {
          clock += milliseconds;
        },
      }
    ),
    /not ready 3/
  );
});

test("runCleanupSteps completes every cleanup and returns the first error", async () => {
  const completed = [];
  const firstError = new Error("server stop failed");
  const result = await runCleanupSteps([
    async () => {
      completed.push("server");
      throw firstError;
    },
    async () => {
      completed.push("environment");
    },
    async () => {
      completed.push("temp");
      throw new Error("temp cleanup failed");
    },
    async () => {
      completed.push("receipt");
    },
  ]);

  assert.equal(result, firstError);
  assert.deepEqual(completed, ["server", "environment", "temp", "receipt"]);
});

test("readCleanCommitSha permits an untracked config but rejects tracked changes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-live-demo-git-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  const runGit = (args, options) => execFileAsync("git", args, options);
  await runGit(["init", "--quiet"], { cwd: repoRoot });
  await runGit(["config", "user.name", "Remnic test"], { cwd: repoRoot });
  await runGit(["config", "user.email", "test@example.invalid"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "tracked.txt"), "clean\n");
  await runGit(["add", "tracked.txt"], { cwd: repoRoot });
  await runGit(["commit", "--quiet", "-m", "test fixture"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "remnic.config.json"), "{}\n");

  assert.match(await readCleanCommitSha(repoRoot, runGit), /^[a-f0-9]{40}$/);

  await writeFile(path.join(repoRoot, "tracked.txt"), "changed\n");
  await assert.rejects(readCleanCommitSha(repoRoot, runGit), /Commit all tracked changes/);
});
