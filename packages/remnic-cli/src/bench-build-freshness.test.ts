import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkBenchBuildFreshness } from "./bench-build-freshness.js";

test("checkBenchBuildFreshness flags local bench source newer than dist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-freshness-"));
  const benchDir = path.join(root, "bench");
  const srcDir = path.join(benchDir, "src");
  const distDir = path.join(benchDir, "dist");
  await mkdir(srcDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(
    path.join(benchDir, "package.json"),
    JSON.stringify({ name: "@remnic/bench" }),
  );
  await writeFile(path.join(srcDir, "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(distDir, "index.js"), "export const value = 0;\n");

  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newTime = new Date("2026-01-01T00:00:05.000Z");
  await touch(path.join(distDir, "index.js"), oldTime);
  await touch(path.join(srcDir, "index.ts"), newTime);

  const freshness = checkBenchBuildFreshness(benchDir);
  assert.equal(freshness.stale, true);
  assert.match(freshness.reason ?? "", /Source files are newer/);
  assert.ok(
    freshness.sourcePath === path.join(srcDir, "index.ts") ||
      freshness.sourcePath === path.join(benchDir, "package.json"),
  );
});

test("checkBenchBuildFreshness ignores non-local bench package paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-freshness-"));
  const benchDir = path.join(root, "bench");
  await mkdir(benchDir, { recursive: true });
  await writeFile(
    path.join(benchDir, "package.json"),
    JSON.stringify({ name: "not-remnic-bench" }),
  );

  assert.equal(checkBenchBuildFreshness(benchDir).stale, false);
});

test("checkBenchBuildFreshness ignores published bench packages without source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-freshness-"));
  const benchDir = path.join(root, "bench");
  const distDir = path.join(benchDir, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(
    path.join(benchDir, "package.json"),
    JSON.stringify({ name: "@remnic/bench" }),
  );
  await writeFile(path.join(distDir, "index.js"), "export const value = 0;\n");

  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newTime = new Date("2026-01-01T00:00:05.000Z");
  await touch(path.join(distDir, "index.js"), oldTime);
  await touch(path.join(benchDir, "package.json"), newTime);

  assert.equal(checkBenchBuildFreshness(benchDir).stale, false);
});

test("checkBenchBuildFreshness does not follow source symlinks outside bench", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-freshness-"));
  try {
    const benchDir = path.join(root, "bench");
    const srcDir = path.join(benchDir, "src");
    const distDir = path.join(benchDir, "dist");
    const outsideDir = path.join(root, "outside");
    await mkdir(srcDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      path.join(benchDir, "package.json"),
      JSON.stringify({ name: "@remnic/bench" }),
    );
    await writeFile(path.join(srcDir, "index.ts"), "export const value = 1;\n");
    await writeFile(
      path.join(outsideDir, "outside.ts"),
      "export const value = 2;\n",
    );
    await writeFile(path.join(distDir, "index.js"), "export const value = 0;\n");
    await symlink(outsideDir, path.join(srcDir, "outside-link"), "dir");

    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const distTime = new Date("2026-01-01T00:00:05.000Z");
    const outsideTime = new Date("2026-01-01T00:00:10.000Z");
    await touch(path.join(benchDir, "package.json"), oldTime);
    await touch(path.join(srcDir, "index.ts"), oldTime);
    await touch(path.join(distDir, "index.js"), distTime);
    await touch(path.join(outsideDir, "outside.ts"), outsideTime);

    const freshness = checkBenchBuildFreshness(benchDir);
    assert.equal(freshness.stale, false);
    assert.notEqual(freshness.sourcePath, path.join(outsideDir, "outside.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function touch(filePath: string, date: Date): Promise<void> {
  const { utimes } = await import("node:fs/promises");
  await utimes(filePath, date, date);
}
