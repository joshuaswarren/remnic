import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(pkgRoot, "bin", "remnic-capture-screen.js");
const distCli = path.join(pkgRoot, "dist", "cli.js");

// The bin runs as an end user runs it: plain `node`, so @remnic/core resolves
// to its built dist. The root test runner exports NODE_OPTIONS=--conditions=
// remnic-source, which would instead point core at its .ts source and make the
// plain-node child throw ERR_UNKNOWN_FILE_EXTENSION. Strip it for the child.
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "")
    .replace(/--conditions[=\s]+remnic-source/g, "")
    .replace(/\s+/g, " ")
    .trim(),
};

function envWithToken(token: string): NodeJS.ProcessEnv {
  return { ...baseEnv, REMNIC_CAPTURE_TOKEN: token };
}

function envWithoutToken(): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.REMNIC_CAPTURE_TOKEN;
  delete env.ENGRAM_CAPTURE_TOKEN;
  return env;
}

// The bin wrapper imports the compiled ../dist/cli.js, so a fresh checkout that
// has not built the package yet must build it before these child-process tests
// run. Idempotent: skips when dist already exists.
before(() => {
  if (existsSync(distCli)) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const built = spawnSync(npm, ["run", "build"], { cwd: pkgRoot, stdio: "inherit", env: process.env });
  if (built.status !== 0) throw new Error("failed to build @remnic/capture-screen for bin tests");
});

test("bin sanitizes startup errors on stderr instead of leaking raw messages", () => {
  const result = spawnSync(process.execPath, [binPath], { encoding: "utf8", env: envWithoutToken() });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "TypeError");
  // The raw error text ("--spool is required") could embed absolute paths on
  // filesystem/native failures; displayErrorDetail() must strip it.
  assert.doesNotMatch(result.stderr, /--spool is required/);
});

test("bin sanitizes a module-load failure (missing dist) without leaking a stack", async () => {
  // Copy the bin into a scratch dir with no sibling dist/, so its relative
  // import("../dist/cli.js") fails at load time — the path the top-level catch
  // must still sanitize.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-bin-"));
  try {
    const stubDir = path.join(dir, "bin");
    await mkdir(stubDir, { recursive: true });
    const stubBin = path.join(stubDir, "remnic-capture-screen.js");
    await copyFile(binPath, stubBin);
    const result = spawnSync(process.execPath, [stubBin], { encoding: "utf8", env: envWithoutToken() });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "Error (ERR_MODULE_NOT_FOUND)");
    assert.doesNotMatch(result.stderr, /at |node:internal|\/dist\/cli\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bin terminates the process on SIGTERM after a clean shutdown", { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [binPath, "--spool", ":memory:"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envWithToken("sigterm-token"),
  });
  const stdout = child.stdout;
  if (stdout === null) throw new Error("child stdout was not piped");
  try {
    // Await the real "url reported" signal — the daemon is listening once it
    // prints its URL. The node:test timeout bounds a hang; no wall-clock sleep.
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const onData = (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("http://")) {
          stdout.off("data", onData);
          resolve();
        }
      };
      stdout.on("data", onData);
      child.once("error", reject);
    });

    child.kill("SIGTERM");
    const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("bin takes the bearer token from the env, keeps it out of argv, and still authenticates", { timeout: 20000 }, async () => {
  const token = "argv-should-never-hold-this-secret";
  const child = spawn(process.execPath, [binPath, "--spool", ":memory:"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envWithToken(token),
  });
  const stdout = child.stdout;
  if (stdout === null) throw new Error("child stdout was not piped");
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const onData = (chunk: Buffer) => {
        out += chunk.toString("utf8");
        const match = out.match(/http:\/\/\S+/);
        if (match) {
          stdout.off("data", onData);
          resolve(match[0].trim());
        }
      };
      stdout.on("data", onData);
      child.once("error", reject);
    });

    // The token must never reach the process command line (ps / /proc leak).
    if (process.platform === "linux" && child.pid !== undefined && existsSync(`/proc/${child.pid}/cmdline`)) {
      const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
      assert.ok(cmdline.includes("remnic-capture-screen"), "read the daemon's own cmdline");
      assert.ok(!cmdline.includes(token), "bearer token must not appear in argv");
    }

    const ok = await fetch(`${url}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    const denied = await fetch(`${url}/v1/health`);
    assert.equal(denied.status, 401);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit").catch(() => undefined);
    }
  }
});
