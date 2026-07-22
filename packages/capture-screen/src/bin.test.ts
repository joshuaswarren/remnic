import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
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
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "")
    .replace(/--conditions[=\s]+remnic-source/g, "")
    .replace(/\s+/g, " ")
    .trim(),
};

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
  const result = spawnSync(process.execPath, [binPath, "--auth-token", "token"], { encoding: "utf8", env: childEnv });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "TypeError");
  // The raw error text ("--spool is required") could embed absolute paths on
  // filesystem/native failures; displayErrorDetail() must strip it.
  assert.doesNotMatch(result.stderr, /--spool is required/);
});

test("bin terminates the process on SIGTERM after a clean shutdown", { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [binPath, "--auth-token", "token", "--spool", ":memory:"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
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
