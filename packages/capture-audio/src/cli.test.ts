import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import { test } from "node:test";

import { runCapture } from "./cli.js";
import { defaultDaemonConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { Spool } from "./spool.js";
import { writePidFile } from "./control.js";
import { capturePaths, expandTilde } from "./paths.js";

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

/** Reserve then release a loopback port so a fetch to it is refused. */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
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
      const code = await runCapture({ argv: ["stop", "--force", "--base-dir", baseDir], stdout: () => undefined });
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

test("an unknown flag is rejected with a usage error", async () => {
  const errs: string[] = [];
  const code = await runCapture({ argv: ["start", "--bogus"], stdout: () => undefined, stderr: (l) => errs.push(l) });
  assert.equal(code, 2);
  assert.ok(errs.some((l) => l.includes("unknown flag --bogus")), errs.join("|"));
});

test("start --host/--port persists the effective binding so status reaches that daemon", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const spool = new Spool(":memory:");
    // A live daemon on an ephemeral port that differs from the default config port (4340).
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
      // Simulate what `start --port <ephemeral>` writes: pid record carries the effective binding.
      writePidFile(paths.pidPath, process.pid, {
        instanceId: spool.meta("instance_id"),
        host: handle.host,
        port: handle.port,
      });
      const out: string[] = [];
      const code = await runCapture({ argv: ["status", "--base-dir", baseDir], stdout: (l) => out.push(l) });
      assert.equal(code, 0);
      const line = out.join("\n");
      assert.match(line, /HTTP 200/); // reached the daemon at the recorded port, not the config default
      assert.ok(line.includes(spool.meta("instance_id")!), line);
    } finally {
      await handle.close();
      spool.close();
    }
  });
});

test("stop probes the persisted binding (detects instance mismatch, does not kill the wrong pid)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const spool = new Spool(":memory:");
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
      // Record points at the live daemon's port but carries a STALE instanceId.
      writePidFile(paths.pidPath, process.pid, { instanceId: "stale-instance", host: handle.host, port: handle.port });
      const out: string[] = [];
      const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: (l) => out.push(l), stderr: () => undefined });
      assert.equal(code, 0);
      // Only reachable via the recorded port: probe returned the real instanceId != "stale-instance".
      assert.match(out.join("\n"), /instance mismatch/);
      assert.equal(existsSync(paths.pidPath), false);
    } finally {
      await handle.close();
      spool.close();
    }
  });
});

test("start refuses a non-loopback bind host before forking a daemon", async () => {
  await withBaseDir(async (baseDir) => {
    const errs: string[] = [];
    const code = await runCapture({
      argv: ["start", "--host", "0.0.0.0", "--base-dir", baseDir],
      stdout: () => undefined,
      stderr: (l) => errs.push(l),
    });
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes("refusing to bind non-loopback")), errs.join("|"));
  });
});

test("start refuses to double-start only after confirming pid identity", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const spool = new Spool(":memory:");
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
      // Alive pid whose recorded instanceId matches the live daemon at the recorded port.
      writePidFile(paths.pidPath, process.pid, { instanceId: spool.meta("instance_id"), host: handle.host, port: handle.port });
      const out: string[] = [];
      const code = await runCapture({ argv: ["start", "--base-dir", baseDir], stdout: (l) => out.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(out, [`daemon already running (pid ${process.pid})`]);
    } finally {
      await handle.close();
      spool.close();
    }
  });
});

test("--help after a subcommand shows usage without side effects", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const out: string[] = [];
    const code = await runCapture({ argv: ["start", "--help", "--base-dir", baseDir], stdout: (l) => out.push(l) });
    assert.equal(code, 0);
    assert.ok(out.join("\n").includes("usage: remnic-capture-audio"));
    assert.equal(existsSync(paths.pidPath), false); // no daemon started
  });
});

test("stop refuses to signal when identity is unconfirmable (health unreachable) without --force", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const port = await closedPort();
    // Alive pid (this test process), recorded instanceId, but health is unreachable.
    writePidFile(paths.pidPath, process.pid, { instanceId: "ghost-instance", host: "127.0.0.1", port });
    const errs: string[] = [];
    const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined, stderr: (l) => errs.push(l) });
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes("cannot confirm daemon identity")), errs.join("|"));
    assert.equal(existsSync(paths.pidPath), true); // not removed, not signalled
  });
});

test("status reports a sanitized health-check failure (no raw error text)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const port = await closedPort();
    writePidFile(paths.pidPath, process.pid, { instanceId: "x", host: "127.0.0.1", port });
    const out: string[] = [];
    const code = await runCapture({ argv: ["status", "--base-dir", baseDir], stdout: (l) => out.push(l) });
    assert.equal(code, 0);
    const line = out.join("\n");
    assert.match(line, /health check failed \(/);
    assert.doesNotMatch(line, /https?:\/\//); // no URL / foreign text leaked
  });
});

test("expandTilde expands a leading ~ and passes other paths through", () => {
  const home = os.homedir();
  assert.equal(expandTilde("~"), home);
  assert.equal(expandTilde("~/x/y"), path.join(home, "x/y"));
  assert.equal(expandTilde("/abs/path"), "/abs/path");
  assert.equal(expandTilde("rel/path"), "rel/path");
});

test("stop refuses a bare-pid record (no instance id) without --force", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writePidFile(paths.pidPath, process.pid); // bare pid, no instanceId
    const errs: string[] = [];
    const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined, stderr: (l) => errs.push(l) });
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.includes("cannot verify daemon identity")), errs.join("|"));
    assert.equal(existsSync(paths.pidPath), true); // not signalled, not removed
  });
});
