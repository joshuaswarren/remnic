import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { test } from "node:test";

import { recordChildPidOrTerminate, recordedDaemonIsRunning, runCapture, superviseReplay } from "./cli.js";
import { defaultDaemonConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { Spool } from "./spool.js";
import { isProcessAlive, readPidRecord, writePidFile } from "./control.js";
import { capturePaths, expandTilde } from "./paths.js";
import { isLoopbackHost, stripIpv6Brackets } from "./util.js";

async function withBaseDir(fn: (baseDir: string) => Promise<void>): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "cap-cli-"));
  try {
    await fn(baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

/** Await a child's exit, but return immediately if it has already exited — a
 *  daemon-style `stop` now blocks until the process is gone, so the child is
 *  frequently already reaped by the time cleanup runs. */
async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

/** Spawn a throwaway process, wait for it to exit, and return its (now-dead) pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  await waitExit(child);
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

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

test("start refuses when a DIFFERENT live pid holds a bare record", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
    assert.ok(child.pid);
    try {
      writePidFile(paths.pidPath, child.pid);
      const output: string[] = [];
      const code = await runCapture({ argv: ["start", "--base-dir", baseDir], stdout: (line) => output.push(line) });
      assert.equal(code, 0);
      assert.deepEqual(output, [`daemon already running (pid ${child.pid})`]);
      assert.equal(existsSync(paths.pidPath), true);
    } finally {
      child.kill("SIGKILL");
    }
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
      await waitExit(child);
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

test("stop probes the persisted binding to detect a mismatch (refuses, preserves record, never signals)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const spool = new Spool(":memory:");
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
      // Record points at the live daemon's port but carries a STALE instanceId.
      writePidFile(paths.pidPath, process.pid, { instanceId: "stale-instance", host: handle.host, port: handle.port });
      const errs: string[] = [];
      const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined, stderr: (l) => errs.push(l) });
      // Reached the recorded port, saw a different instanceId: refuse, keep the record, never signal.
      assert.equal(code, 1);
      assert.ok(errs.some((l) => l.includes("does not match the daemon serving")), errs.join("|"));
      assert.equal(existsSync(paths.pidPath), true);
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

test("start refuses to double-start after confirming a prior daemon's identity", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const { child, port } = await spawnFakeDaemon("inst-1");
    try {
      writePidFile(paths.pidPath, child.pid!, { instanceId: "inst-1", host: "127.0.0.1", port });
      const out: string[] = [];
      const code = await runCapture({ argv: ["start", "--base-dir", baseDir], stdout: (l) => out.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(out, [`daemon already running (pid ${child.pid})`]);
    } finally {
      child.kill("SIGKILL");
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

test("stop refuses a verified instance mismatch: never signals, preserves the pid file (even with --force)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const spool = new Spool(":memory:");
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      // Record points at THIS process (alive) + the live daemon's endpoint, but a GHOST instanceId.
      writePidFile(paths.pidPath, process.pid, { instanceId: "ghost-instance", host: handle.host, port: handle.port });
      const errs: string[] = [];
      const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined, stderr: (l) => errs.push(l) });
      assert.equal(code, 1);
      assert.ok(errs.some((l) => l.includes("does not match the daemon serving")), errs.join("|"));
      assert.equal(existsSync(paths.pidPath), true); // preserved, not reclaimed, not signalled
      // --force must NOT override a verified mismatch.
      const code2 = await runCapture({ argv: ["stop", "--force", "--base-dir", baseDir], stdout: () => undefined, stderr: () => undefined });
      assert.equal(code2, 1);
      assert.equal(existsSync(paths.pidPath), true);
    } finally {
      await handle.close();
      spool.close();
    }
  });
});

test("stop --force signals an unverifiable (health-unreachable) recorded pid", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
    assert.ok(child.pid);
    try {
      const port = await closedPort();
      writePidFile(paths.pidPath, child.pid, { instanceId: "x", host: "127.0.0.1", port });
      const out: string[] = [];
      const code = await runCapture({ argv: ["stop", "--force", "--base-dir", baseDir], stdout: (l) => out.push(l) });
      assert.equal(code, 0);
      assert.match(out.join("\n"), /sent SIGTERM|stopped/);
      await waitExit(child);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("superviseReplay ingests after readiness and surfaces an ok status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-sr-"));
  try {
    writeFileSync(
      path.join(dir, "a.json"),
      JSON.stringify({
        id: "conv_a",
        startedAtUtc: "2026-07-20T15:00:00.000Z",
        segments: [{ channel: "mic", text: "hi", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }],
      }),
    );
    const spool = new Spool(":memory:");
    await superviseReplay(spool, dir, { stdout: () => undefined, stderr: () => undefined });
    assert.equal(spool.meta("replay_status"), "ok");
    assert.equal(spool.stats().conversations, 1);
    spool.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replay failure after readiness surfaces state without killing or lying about the daemon", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-sr-"));
  try {
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ startedAtUtc: "2026-07-20T15:00:00.000Z", state: "finished", segments: [] }));
    const spool = new Spool(":memory:");
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      await superviseReplay(spool, dir, { stdout: () => undefined, stderr: () => undefined });
      assert.ok((spool.meta("replay_status") ?? "").startsWith("failed"));
      assert.equal(spool.stats().conversations, 0); // atomic: nothing persisted
      const res = await fetch(`${handle.url}/v1/health`, { headers: { authorization: "Bearer tok" } });
      assert.equal(res.status, 200); // daemon still serving
      const body = (await res.json()) as { replayStatus?: unknown };
      assert.ok(String(body.replayStatus).startsWith("failed")); // surfaced on health
    } finally {
      await handle.close();
      spool.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readiness is established before replay and a slow replay still reaches ok", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const dir = await mkdtemp(path.join(tmpdir(), "cap-sr-"));
    try {
      const docs = Array.from({ length: 6 }, (_, i) => ({
        id: `conv_${i}`,
        startedAtUtc: `2026-07-20T15:0${i}:00.000Z`,
        segments: [{ channel: "mic", text: `t${i}`, startUtc: `2026-07-20T15:0${i}:00.000Z`, endUtc: `2026-07-20T15:0${i}:01.000Z` }],
      }));
      writeFileSync(path.join(dir, "m.json"), JSON.stringify(docs));
      const spool = new Spool(":memory:");
      const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
      try {
        // Readiness marker is written before any replay ingestion runs.
        writePidFile(paths.pidPath, process.pid, { instanceId: spool.meta("instance_id")!, host: handle.host, port: handle.port });
        assert.ok(readPidRecord(paths.pidPath)?.instanceId, "ready marker set before replay");
        await superviseReplay(spool, dir, { stdout: () => undefined, stderr: () => undefined });
        assert.equal(spool.meta("replay_status"), "ok");
        assert.equal(spool.stats().conversations, 6);
        assert.equal((await fetch(`${handle.url}/v1/health`, { headers: { authorization: "Bearer tok" } })).status, 200);
      } finally {
        await handle.close();
        spool.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Spawn a minimal fake daemon that serves /v1/health with a fixed instanceId + its own pid. */
async function spawnFakeDaemon(instanceId: string): Promise<{ child: ReturnType<typeof spawn>; port: number }> {
  const src =
    'const http=require("node:http");' +
    'const s=http.createServer((q,r)=>{r.writeHead(200,{"content-type":"application/json"});' +
    'r.end(JSON.stringify({ok:true,instanceId:process.env.IID,pid:process.pid}))});' +
    's.listen(0,"127.0.0.1",()=>console.log(s.address().port));process.stdin.resume();';
  const child = spawn(process.execPath, ["-e", src], { env: { ...process.env, IID: instanceId } });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.on("data", (d) => {
      const n = Number(String(d).trim());
      if (Number.isInteger(n)) resolve(n);
    });
    child.on("exit", () => reject(new Error("fake daemon exited before listening")));
  });
  return { child, port };
}

test("stop signals only when both instanceId and health pid match the record", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const { child, port } = await spawnFakeDaemon("inst-1");
    try {
      writePidFile(paths.pidPath, child.pid!, { instanceId: "inst-1", host: "127.0.0.1", port });
      const out: string[] = [];
      const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: (l) => out.push(l) });
      assert.equal(code, 0);
      assert.match(out.join("\n"), /sent SIGTERM|stopped/);
      await waitExit(child); // the verified pid was signalled
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("stop refuses when the health pid differs from the record (reused pid), never signalling", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const { child: daemon, port } = await spawnFakeDaemon("inst-1");
    const other = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
    assert.ok(other.pid);
    try {
      // Record points at OTHER's pid, but the endpoint is served by a daemon
      // with the matching instanceId under a DIFFERENT pid -> must refuse.
      writePidFile(paths.pidPath, other.pid, { instanceId: "inst-1", host: "127.0.0.1", port });
      const errs: string[] = [];
      const code = await runCapture({ argv: ["stop", "--base-dir", baseDir], stdout: () => undefined, stderr: (l) => errs.push(l) });
      assert.equal(code, 1);
      assert.ok(errs.some((l) => l.includes("identity/pid mismatch")), errs.join("|"));
      assert.equal(existsSync(paths.pidPath), true); // preserved
      assert.equal(isProcessAlive(other.pid), true); // NOT signalled
    } finally {
      daemon.kill("SIGKILL");
      other.kill("SIGKILL");
    }
  });
});

test("recordChildPidOrTerminate kills the child when the pid write fails", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    // pidPath as a directory makes writePidFile's rename fail.
    mkdirSync(paths.pidPath, { recursive: true });
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
    assert.ok(child.pid);
    try {
      const errs: string[] = [];
      const ok = recordChildPidOrTerminate(child.pid, paths, { host: "127.0.0.1", port: 4340 }, (l) => errs.push(l));
      assert.equal(ok, false);
      assert.ok(errs.some((l) => l.includes("failed to record daemon pid")), errs.join("|"));
      await waitExit(child); // child was terminated
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("unexpected positional arguments are rejected before side effects", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const errs: string[] = [];
    const code = await runCapture({ argv: ["init", "extra", "--base-dir", baseDir], stdout: () => undefined, stderr: (l) => errs.push(l) });
    assert.equal(code, 2);
    assert.ok(errs.some((l) => l.includes("unexpected argument(s): extra")), errs.join("|"));
    assert.equal(existsSync(paths.configPath), false); // init did not run
  });
});

test("global flags before the subcommand are accepted", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const out: string[] = [];
    const code = await runCapture({ argv: ["--base-dir", baseDir, "init"], stdout: (l) => out.push(l) });
    assert.equal(code, 0);
    assert.equal(existsSync(paths.configPath), true);
  });
});

test("replay failure status is sanitized before it reaches health output", async () => {
  const spool = new Spool(":memory:");
  const missing = path.join(tmpdir(), "cap-definitely-missing-xyz");
  await superviseReplay(spool, missing, { stdout: () => undefined, stderr: () => undefined });
  const status = spool.meta("replay_status") ?? "";
  assert.ok(status.startsWith("failed"), status);
  assert.ok(!status.includes(missing), status); // absolute path stripped
  assert.ok(status.includes("<path>"), status);
  spool.close();
});

test("replay ingestion yields so the daemon stays responsive during a multi-batch replay", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-big-"));
  try {
    const iso = (s: number, ms = 0) => new Date(Date.UTC(2026, 6, 20, 0, 0, s, ms)).toISOString();
    const docs = Array.from({ length: 60 }, (_, i) => ({
      id: `conv_${i}`,
      startedAtUtc: iso(i),
      segments: [{ channel: "mic", text: `t${i}`, startUtc: iso(i), endUtc: iso(i, 500) }],
    }));
    writeFileSync(path.join(dir, "big.json"), JSON.stringify(docs));
    const spool = new Spool(":memory:");
    const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
    try {
      const ingest = superviseReplay(spool, dir, { stdout: () => undefined, stderr: () => undefined });
      // The bound server answers health while ingestion is still in flight.
      const res = await fetch(`${handle.url}/v1/health`, { headers: { authorization: "Bearer tok" } });
      assert.equal(res.status, 200);
      await ingest;
      assert.equal(spool.meta("replay_status"), "ok");
      assert.equal(spool.stats().conversations, 60);
    } finally {
      await handle.close();
      spool.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordedDaemonIsRunning permits the child's own prewritten record (pid === process.pid)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    // The background parent writes this record (our own pid, no instanceId yet).
    const record = { pid: process.pid, instanceId: null, startedAtIso: new Date().toISOString(), host: "127.0.0.1", port: 4340 };
    assert.equal(await recordedDaemonIsRunning(record, paths, () => undefined), false);
  });
});

test("recordedDaemonIsRunning refuses a real prior daemon at the endpoint", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writeFileSync(paths.tokenPath, "tok\n", { mode: 0o600 });
    const { child, port } = await spawnFakeDaemon("inst-1");
    try {
      const record = { pid: child.pid!, instanceId: "inst-1", startedAtIso: new Date().toISOString(), host: "127.0.0.1", port };
      assert.equal(await recordedDaemonIsRunning(record, paths, () => undefined), true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("foreground start closes the server and spool if pid persistence fails after bind", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const port = await closedPort();
    mkdirSync(paths.pidPath, { recursive: true }); // makes writePidFile fail
    const errs: string[] = [];
    const code = await runCapture({
      argv: ["start", "--foreground", "--host", "127.0.0.1", "--port", String(port), "--base-dir", baseDir],
      stdout: () => undefined,
      stderr: (l) => errs.push(l),
    });
    assert.equal(code, 1);
    assert.ok(errs.some((l) => l.startsWith("error:")), errs.join("|"));
    // The bound port must have been released (handle.close ran) — a fresh
    // listener can bind it.
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  });
});

test("SIGTERM during a large replay shuts down cleanly (drains, no write-after-close)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const dir = await mkdtemp(path.join(tmpdir(), "cap-big-"));
    try {
      const iso = (i: number) => new Date(Date.UTC(2026, 6, 20, 0, Math.floor(i / 60), i % 60)).toISOString();
      const docs = Array.from({ length: 120 }, (_, i) => ({
        id: `conv_${i}`,
        startedAtUtc: iso(i),
        segments: [{ channel: "mic", text: `t${i}`, startUtc: iso(i), endUtc: iso(i) }],
      }));
      writeFileSync(path.join(dir, "big.json"), JSON.stringify(docs));
      const port = await closedPort();
      const run = runCapture({
        argv: ["start", "--foreground", "--replay", dir, "--host", "127.0.0.1", "--port", String(port), "--base-dir", baseDir],
        stdout: () => undefined,
        stderr: () => undefined,
      });
      await waitFor(() => readPidRecord(paths.pidPath)?.instanceId != null);
      process.emit("SIGTERM");
      const code = await run;
      assert.equal(code, 0); // clean drain + close, no unhandled write-after-close
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("normal replay completes, then SIGTERM shuts down cleanly", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const dir = await mkdtemp(path.join(tmpdir(), "cap-sm-"));
    try {
      writeFileSync(
        path.join(dir, "a.json"),
        JSON.stringify([
          { id: "c0", startedAtUtc: "2026-07-20T15:00:00.000Z", segments: [{ channel: "mic", text: "a", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }] },
          { id: "c1", startedAtUtc: "2026-07-20T15:01:00.000Z", segments: [{ channel: "mic", text: "b", startUtc: "2026-07-20T15:01:00.000Z", endUtc: "2026-07-20T15:01:01.000Z" }] },
        ]),
      );
      const port = await closedPort();
      const run = runCapture({
        argv: ["start", "--foreground", "--replay", dir, "--host", "127.0.0.1", "--port", String(port), "--base-dir", baseDir],
        stdout: () => undefined,
        stderr: () => undefined,
      });
      await waitFor(() => existsSync(paths.tokenPath));
      const token = readFileSync(paths.tokenPath, "utf8").trim();
      await waitFor(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
          if (!r.ok) return false;
          const b = (await r.json()) as { replayStatus?: unknown };
          return b.replayStatus === "ok";
        } catch {
          return false;
        }
      });
      process.emit("SIGTERM");
      const code = await run;
      assert.equal(code, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("recordChildPidOrTerminate does not clobber the child's already-published ready record", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    // Child got scheduled first and wrote its full record with an instanceId.
    writePidFile(paths.pidPath, 4242, { instanceId: "inst-ready", host: "127.0.0.1", port: 5555 });
    const ok = recordChildPidOrTerminate(4242, paths, { host: "127.0.0.1", port: 6666 }, () => undefined);
    assert.equal(ok, true);
    const rec = readPidRecord(paths.pidPath);
    assert.equal(rec?.instanceId, "inst-ready"); // preserved, not clobbered
    assert.equal(rec?.port, 5555);
  });
});

test("recordChildPidOrTerminate overwrites a stale full record from a different pid", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    writePidFile(paths.pidPath, 9999, { instanceId: "old-inst", host: "127.0.0.1", port: 5555 });
    const ok = recordChildPidOrTerminate(4242, paths, { host: "127.0.0.1", port: 6666 }, () => undefined);
    assert.equal(ok, true);
    const rec = readPidRecord(paths.pidPath);
    assert.equal(rec?.pid, 4242); // provisional record for our child now owns the file
    assert.equal(rec?.instanceId, null);
    assert.equal(rec?.port, 6666);
  });
});

test("a flag the selected command ignores is rejected (no silent drop)", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const errs: string[] = [];
    // `init` only honors --force; --port belongs to `start`. It must error,
    // not write the default config while silently dropping the port.
    const code = await runCapture({
      argv: ["init", "--port", "5555", "--base-dir", baseDir],
      stdout: () => undefined,
      stderr: (l) => errs.push(l),
    });
    assert.equal(code, 2);
    assert.match(errs.join("\n"), /flag --port is not valid for command 'init'/);
    assert.equal(existsSync(paths.configPath), false);
  });
});

test("a valid subcommand flag plus the global --base-dir is accepted", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const code = await runCapture({
      argv: ["init", "--force", "--base-dir", baseDir],
      stdout: () => undefined,
      stderr: () => undefined,
    });
    assert.equal(code, 0);
    assert.equal(existsSync(paths.configPath), true);
  });
});

test("bracketed IPv6 loopback host is recognized (start must not refuse [::1])", () => {
  assert.equal(stripIpv6Brackets("[::1]"), "::1");
  assert.equal(stripIpv6Brackets("127.0.0.1"), "127.0.0.1");
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::ffff:127.0.0.1]"), true);
  assert.equal(isLoopbackHost("[2001:db8::1]"), false); // a non-loopback IPv6 is still refused
});

test("stop waits (bounded) for the daemon to exit before returning", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = capturePaths(baseDir);
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
    assert.ok(child.pid);
    const pid = child.pid;
    try {
      writePidFile(paths.pidPath, pid);
      const out: string[] = [];
      const code = await runCapture({ argv: ["stop", "--force", "--base-dir", baseDir], stdout: (l) => out.push(l) });
      assert.equal(code, 0);
      // The bounded wait must not return while the process is still alive.
      assert.equal(isProcessAlive(pid), false, "stop returned before the daemon exited");
      assert.ok(out.some((l) => l.includes("stopped")), out.join("|"));
    } finally {
      child.kill("SIGKILL");
    }
  });
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
