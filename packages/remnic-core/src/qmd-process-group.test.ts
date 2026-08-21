import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommandWithTimeoutForTest } from "./qmd.js";

// Regression for issue #2456: on timeout/abort the bounded qmd subprocess
// launcher must be killed together with its descendants. The launcher runs
// detached (own process group) so a negative-pid signal reaches grandchildren
// the old child.kill("SIGKILL") left behind. POSIX only — Windows falls back
// to a direct child kill by design.
//
// Real timers by design: this suite kills real OS processes, so the timeout
// trigger and the exit polls run against the platform clock. Fake timers
// cannot deliver signals to a spawned `sleep`. Every poll awaits a condition
// (pid file exists, process gone), never a fixed sleep.
const isPosix = process.platform !== "win32";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, deadlineMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

async function setupFakeLauncher(): Promise<{ script: string; pidFile: string; dir: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remnic-qmd-kill-"));
  const script = path.join(dir, "fake-qmd");
  const pidFile = path.join(dir, "grandchild.pid");
  // Launcher spawns a grandchild that outlives it, then hangs until killed.
  await fs.promises.writeFile(
    script,
    `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nsleep 30\n`,
    { mode: 0o755 },
  );
  return { script, pidFile, dir };
}

async function readPidFile(pidFile: string, deadlineMs = 5_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const text = await fs.promises.readFile(pidFile, "utf8");
      const pid = Number.parseInt(text.trim(), 10);
      assert.ok(Number.isInteger(pid) && pid > 0, `bad grandchild pid: ${text}`);
      return pid;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function cleanupSurvivors(pids: Array<number | undefined>, dir?: string): Promise<void> {
  for (const pid of pids) {
    if (pid === undefined || !isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
}

test(
  "timeout kills qmd launcher process group including grandchildren",
  { skip: isPosix ? false : "POSIX process groups do not exist on Windows" },
  async () => {
    const { script, pidFile, dir } = await setupFakeLauncher();
    let grandchildPid: number | undefined;
    try {
      await assert.rejects(
        runCommandWithTimeoutForTest(script, [], { timeoutMs: 500, label: "qmd fake" }),
        (err: Error & { timedOut?: boolean }) => err.timedOut === true,
      );
      grandchildPid = await readPidFile(pidFile);
      assert.ok(
        await waitForExit(grandchildPid),
        `grandchild ${grandchildPid} survived the group kill`,
      );
    } finally {
      await cleanupSurvivors([grandchildPid], dir);
    }
  },
);

test(
  "abort kills qmd launcher process group including grandchildren",
  { skip: isPosix ? false : "POSIX process groups do not exist on Windows" },
  async () => {
    const { script, pidFile, dir } = await setupFakeLauncher();
    let grandchildPid: number | undefined;
    const controller = new AbortController();
    try {
      const run = runCommandWithTimeoutForTest(script, [], {
        timeoutMs: 60_000,
        signal: controller.signal,
        label: "qmd fake",
      });
      setTimeout(() => controller.abort(), 300);
      await assert.rejects(run, /aborted/);
      grandchildPid = await readPidFile(pidFile);
      assert.ok(
        await waitForExit(grandchildPid),
        `grandchild ${grandchildPid} survived the group kill`,
      );
    } finally {
      await cleanupSurvivors([grandchildPid], dir);
    }
  },
);
