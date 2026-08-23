import assert from "node:assert/strict";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireLockDir,
  ensurePackageBuild,
  isLockHeldByLiveProcess,
  releaseLockDir,
  spawnExitCode,
  spawnSucceeded,
} from "../scripts/build-staleness.mjs";

const buildStalenessModuleUrl = new URL("../scripts/build-staleness.mjs", import.meta.url).href;

async function makeScenario(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const srcDir = path.join(root, "pkg", "src");
  const distFile = path.join(root, "pkg", "dist", "index.js");
  await mkdir(srcDir, { recursive: true });
  const sourceFile = path.join(srcDir, "index.ts");
  await writeFile(sourceFile, "export const v = 1;\n");
  const state = { builds: 0 };
  const runBuild = () => {
    state.builds += 1;
    fsSync.mkdirSync(path.dirname(distFile), { recursive: true });
    fsSync.writeFileSync(distFile, `dist build #${state.builds}\n`);
  };
  const ensure = () => ensurePackageBuild(root, "@scope/test-pkg", distFile, [srcDir], { runBuild });
  return { root, srcDir, distFile, sourceFile, state, ensure };
}

function sidecarPath(distFile) {
  return `${distFile}.source-fingerprint.json`;
}

test("sub-second and equal-mtime source changes rebuild instead of reusing stale dist", async () => {
  const scenario = await makeScenario("remnic-build-staleness-subsecond-");
  try {
    const { distFile, sourceFile, state, ensure } = scenario;

    await ensure();
    assert.equal(state.builds, 1);

    // Equal mtime: the changed source carries the exact same timestamp as dist.
    await writeFile(sourceFile, "export const v = 2;\n");
    const distTime = new Date((await stat(distFile)).mtimeMs);
    await utimes(sourceFile, distTime, distTime);
    await ensure();
    assert.equal(state.builds, 2, "equal-mtime content change must rebuild");

    // Sub-second newer: inside the old one-second tolerance window.
    await writeFile(sourceFile, "export const v = 3;\n");
    const distTime2 = new Date((await stat(distFile)).mtimeMs);
    const newer = new Date(distTime2.getTime() + 300);
    await utimes(sourceFile, newer, newer);
    await ensure();
    assert.equal(state.builds, 3, "sub-second-newer content change must rebuild");

    // Sub-second older: the tolerance blind spot in the other direction.
    await writeFile(sourceFile, "export const v = 4;\n");
    const distTime3 = new Date((await stat(distFile)).mtimeMs);
    const older = new Date(distTime3.getTime() - 300);
    await utimes(sourceFile, older, older);
    await ensure();
    assert.equal(state.builds, 4, "sub-second-older content change must rebuild");
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test("unchanged sources skip the build even when mtimes move forward", async () => {
  const scenario = await makeScenario("remnic-build-staleness-unchanged-");
  try {
    const { distFile, sourceFile, state, ensure } = scenario;

    await ensure();
    assert.equal(state.builds, 1);

    // Simulate a checkout/clone refresh: same content, brand-new mtimes well
    // past dist. The fingerprint is content-only, so this must not rebuild.
    const refreshed = new Date(Date.now() + 60_000);
    await utimes(sourceFile, refreshed, refreshed);
    await utimes(distFile, new Date((await stat(distFile)).mtimeMs), new Date((await stat(distFile)).mtimeMs));
    await ensure();
    await ensure();
    assert.equal(state.builds, 1, "unchanged content must never trigger a rebuild");
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test("clean tree builds once and records a fingerprint sidecar; hydrated tree skips", async () => {
  const scenario = await makeScenario("remnic-build-staleness-clean-");
  try {
    const { distFile, state, ensure } = scenario;

    // Clean: no dist at all.
    await ensure();
    assert.equal(state.builds, 1);
    const sidecar = JSON.parse(await readFile(sidecarPath(distFile), "utf8"));
    assert.equal(sidecar.version, 1);
    assert.match(sidecar.fingerprint, /^[0-9a-f]{64}$/);

    // Hydrated: dist plus matching sidecar.
    await ensure();
    assert.equal(state.builds, 1);
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test("missing or corrupt fingerprint sidecar rebuilds conservatively", async () => {
  const scenario = await makeScenario("remnic-build-staleness-sidecar-");
  try {
    const { distFile, state, ensure } = scenario;

    await ensure();
    assert.equal(state.builds, 1);

    // Pre-fix dist with no sidecar: one cutover rebuild, then stable.
    await rm(sidecarPath(distFile));
    await ensure();
    assert.equal(state.builds, 2);
    await ensure();
    assert.equal(state.builds, 2);

    // Corrupt sidecar: treated as stale, not as matching.
    await writeFile(sidecarPath(distFile), "not json\n");
    await ensure();
    assert.equal(state.builds, 3);
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test("fingerprint scan does not follow source symlinks outside the package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-symlink-"));
  try {
    const srcDir = path.join(root, "pkg", "src");
    const distFile = path.join(root, "pkg", "dist", "index.js");
    const outsideDir = path.join(root, "outside");
    await mkdir(srcDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const localFile = path.join(srcDir, "local.ts");
    const outsideFile = path.join(outsideDir, "outside.ts");
    await writeFile(localFile, "local\n");
    await writeFile(outsideFile, "outside\n");
    await symlink(outsideDir, path.join(srcDir, "outside-link"), "dir");

    const state = { builds: 0 };
    const ensure = () =>
      ensurePackageBuild(root, "@scope/test-pkg", distFile, [srcDir], {
        runBuild: () => {
          state.builds += 1;
          fsSync.mkdirSync(path.dirname(distFile), { recursive: true });
          fsSync.writeFileSync(distFile, "dist\n");
        },
      });

    await ensure();
    assert.equal(state.builds, 1);

    // Content behind the symlink changes with a newer mtime: not part of the
    // package source tree, so the dist stays fresh.
    await writeFile(outsideFile, "outside changed\n");
    const newer = new Date(Date.now() + 60_000);
    await utimes(outsideFile, newer, newer);
    await ensure();
    assert.equal(state.builds, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent ensurePackageBuild processes trigger exactly one build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-concurrent-"));
  try {
    const srcDir = path.join(root, "pkg", "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, "index.ts"), "export const v = 1;\n");
    const distFile = path.join(root, "pkg", "dist", "index.js");
    const buildLog = path.join(root, "builds.log");

    // The driver imports the real module by URL so the child processes run the
    // production lock path, not an in-process mock.
    const driverPath = path.join(root, "driver.mjs");
    await writeFile(
      driverPath,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        `import { ensurePackageBuild } from ${JSON.stringify(buildStalenessModuleUrl)};`,
        "const [rootArg, distArg, logArg] = process.argv.slice(2);",
        "ensurePackageBuild(rootArg, '@scope/concurrent-pkg', distArg, [path.join(rootArg, 'pkg', 'src')], {",
        "  runBuild: () => {",
        "    fs.appendFileSync(logArg, `build ${process.pid}\\n`);",
        "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);",
        "    fs.mkdirSync(path.dirname(distArg), { recursive: true });",
        "    fs.writeFileSync(distArg, 'dist\\n');",
        "  },",
        "});",
      ].join("\n"),
    );

    const children = [0, 1].map(() => {
      const child = spawn(process.execPath, [driverPath, root, distFile, buildLog], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      return child;
    });
    const exitCodes = await Promise.all(
      children.map((child) => new Promise((resolve) => child.on("close", (code) => resolve(code)))),
    );
    assert.deepEqual(exitCodes, [0, 0]);

    const log = await readFile(buildLog, "utf8");
    assert.equal(log.trim().split("\n").filter((line) => line.length > 0).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signaled spawnSync build is a failure and does not keep a fingerprint", async () => {
  assert.equal(spawnSucceeded({ status: null, signal: "SIGTERM" }), false);
  assert.equal(spawnExitCode({ status: null, signal: "SIGTERM" }), 143);
  assert.equal(spawnExitCode({ status: null, signal: "SIGINT" }), 130);
  assert.equal(spawnExitCode({ status: null, signal: "SIGHUP" }), 129);
  assert.equal(spawnExitCode({ status: null, signal: "SIGKILL" }), 1);
  assert.equal(spawnSucceeded({ status: 0, signal: null }), true);
  assert.equal(spawnSucceeded({ status: 1, signal: null }), false);
  assert.equal(spawnExitCode({ status: 2, signal: null }), 2);
  assert.equal(spawnSucceeded({ status: null, signal: null, error: new Error("spawn failed") }), false);
  assert.equal(spawnExitCode({ status: null, signal: null, error: new Error("spawn failed") }), 1);

  const scenario = await makeScenario("remnic-build-staleness-signal-");
  try {
    const { distFile, state, ensure } = scenario;
    await ensure();
    assert.equal(state.builds, 1);
    assert.equal(fsSync.existsSync(sidecarPath(distFile)), true);

    await writeFile(scenario.sourceFile, "export const v = 99;\n");
    const failing = () =>
      ensurePackageBuild(scenario.root, "@scope/test-pkg", distFile, [scenario.srcDir], {
        runBuild: () => {
          state.builds += 1;
          throw new Error("simulated signaled build");
        },
      });
    assert.throws(failing, /simulated signaled build/);
    assert.equal(state.builds, 2);
    assert.equal(fsSync.existsSync(sidecarPath(distFile)), false);
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
});

test("PID reuse cannot keep a lock live", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-pid-reuse-"));
  try {
    const lockDir = path.join(root, "lock");
    fsSync.mkdirSync(lockDir);
    fsSync.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        startTicks: -1,
        nonce: "reused-pid",
        acquiredAt: Date.now(),
      })}\n`,
    );
    assert.equal(isLockHeldByLiveProcess(lockDir), false);
    const handle = acquireLockDir(lockDir);
    assert.ok(handle);
    const owner = JSON.parse(fsSync.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.nonce, "reused-pid");
    assert.notEqual(owner.startTicks, -1);
    releaseLockDir(handle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two stale-lock reclaimers leave exactly one owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-reclaim-"));
  try {
    const srcDir = path.join(root, "pkg", "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, "index.ts"), "export const v = 1;\n");
    const distFile = path.join(root, "pkg", "dist", "index.js");
    const buildLog = path.join(root, "builds.log");
    const lockDir = path.join(root, "node_modules", ".cache", "remnic-build-locks", "scope-reclaim-pkg");
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => dead.on("close", resolve));
    fsSync.mkdirSync(lockDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: dead.pid,
        startTicks: 0,
        nonce: "dead-owner",
        acquiredAt: Date.now() - 1000,
      })}\n`,
    );

    const driverPath = path.join(root, "reclaim-driver.mjs");
    await writeFile(
      driverPath,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        `import { ensurePackageBuild } from ${JSON.stringify(buildStalenessModuleUrl)};`,
        "const [rootArg, distArg, logArg] = process.argv.slice(2);",
        "ensurePackageBuild(rootArg, '@scope/reclaim-pkg', distArg, [path.join(rootArg, 'pkg', 'src')], {",
        "  runBuild: () => {",
        "    fs.appendFileSync(logArg, `build ${process.pid}\\n`);",
        "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);",
        "    fs.mkdirSync(path.dirname(distArg), { recursive: true });",
        "    fs.writeFileSync(distArg, 'dist\\n');",
        "  },",
        "});",
      ].join("\n"),
    );

    const children = [0, 1].map(() => {
      const child = spawn(process.execPath, [driverPath, root, distFile, buildLog], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      return child;
    });
    const exitCodes = await Promise.all(
      children.map((child) => new Promise((resolve) => child.on("close", (code) => resolve(code)))),
    );
    assert.deepEqual(exitCodes, [0, 0]);

    const log = await readFile(buildLog, "utf8");
    assert.equal(log.trim().split("\n").filter((line) => line.length > 0).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("release removes the lock identity it owns and leaves no aside leftovers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-release-"));
  try {
    const lockRoot = path.join(root, "node_modules", ".cache", "remnic-build-locks");
    const lockDir = path.join(lockRoot, "scope-release-pkg");
    await mkdir(lockRoot, { recursive: true });

    const handle = acquireLockDir(lockDir);
    assert.ok(handle);
    releaseLockDir(handle);

    assert.equal(fsSync.existsSync(lockDir), false, "owned lock must be removed");
    assert.deepEqual(fsSync.readdirSync(lockRoot), [], "no .released- aside dirs may remain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release is a no-op when the live lock owner no longer matches the handle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-tampered-"));
  try {
    const lockRoot = path.join(root, "node_modules", ".cache", "remnic-build-locks");
    const lockDir = path.join(lockRoot, "scope-tampered-pkg");
    await mkdir(lockRoot, { recursive: true });

    const handle = acquireLockDir(lockDir);
    assert.ok(handle);
    const tampered = { ...handle.owner, nonce: "tampered-nonce" };
    await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(tampered)}\n`);

    releaseLockDir(handle);

    assert.equal(fsSync.existsSync(lockDir), true, "a foreign identity on the live path must survive release");
    const observed = JSON.parse(fsSync.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    assert.equal(observed.nonce, "tampered-nonce");
    assert.deepEqual(fsSync.readdirSync(lockRoot), [path.basename(lockDir)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long build outlives stale reclaim: late release leaves the new owner's lock intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-late-release-"));
  let child = null;
  try {
    const lockRoot = path.join(root, "node_modules", ".cache", "remnic-build-locks");
    const lockDir = path.join(lockRoot, "scope-late-release-pkg");
    await mkdir(lockRoot, { recursive: true });
    const acquiredFlag = path.join(root, "acquired");
    const goFlag = path.join(root, "go");

    // Original owner: acquires, then holds past the stale bound until told to
    // finish — the exact shape of a build longer than the lock timeout.
    const driverPath = path.join(root, "late-release-driver.mjs");
    await writeFile(
      driverPath,
      [
        'import fs from "node:fs";',
        `import { acquireLockDir, releaseLockDir } from ${JSON.stringify(buildStalenessModuleUrl)};`,
        "const [lockDirArg, acquiredArg, goArg] = process.argv.slice(2);",
        "const handle = acquireLockDir(lockDirArg);",
        "if (!handle) process.exit(2);",
        "fs.writeFileSync(acquiredArg, String(process.pid));",
        "while (!fs.existsSync(goArg)) {",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
        "}",
        "releaseLockDir(handle);",
      ].join("\n"),
    );

    child = spawn(process.execPath, [driverPath, lockDir, acquiredFlag, goFlag], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const childExit = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    while (!fsSync.existsSync(acquiredFlag)) {
      await sleep(10);
    }

    const previousTimeout = process.env.REMNIC_BUILD_LOCK_TIMEOUT_MS;
    process.env.REMNIC_BUILD_LOCK_TIMEOUT_MS = "50";
    try {
      await sleep(100); // The original owner's lock is now older than the stale bound.
      const waiterHandle = acquireLockDir(lockDir); // Waiter quarantines + reacquires.
      assert.ok(waiterHandle);
      assert.notEqual(waiterHandle.owner.pid, Number(fsSync.readFileSync(acquiredFlag, "utf8")));

      await writeFile(goFlag, ""); // Original owner finishes its build and releases.
      assert.equal(await childExit, 0);

      assert.equal(
        fsSync.existsSync(lockDir),
        true,
        "the original owner's late release must not remove the new owner's lock",
      );
      const observed = JSON.parse(fsSync.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
      assert.deepEqual(observed, waiterHandle.owner);

      releaseLockDir(waiterHandle);
      assert.equal(fsSync.existsSync(lockDir), false);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.REMNIC_BUILD_LOCK_TIMEOUT_MS;
      } else {
        process.env.REMNIC_BUILD_LOCK_TIMEOUT_MS = previousTimeout;
      }
    }
  } finally {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});
