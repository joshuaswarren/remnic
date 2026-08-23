import assert from "node:assert/strict";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensurePackageBuild } from "../scripts/build-staleness.mjs";

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
