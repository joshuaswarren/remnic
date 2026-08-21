import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isAnySourceNewerThan } from "../scripts/build-staleness.mjs";

test("build staleness scan does not follow source symlinks outside the package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-build-staleness-"));
  try {
    const srcDir = path.join(root, "pkg", "src");
    const distDir = path.join(root, "pkg", "dist");
    const outsideDir = path.join(root, "outside");
    await mkdir(srcDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const distFile = path.join(distDir, "index.js");
    const localFile = path.join(srcDir, "local.ts");
    const outsideFile = path.join(outsideDir, "newer.ts");
    await writeFile(distFile, "dist\n");
    await writeFile(localFile, "local\n");
    await writeFile(outsideFile, "outside\n");

    const oldTime = new Date("2026-01-01T00:00:00Z");
    const distTime = new Date("2026-01-02T00:00:00Z");
    const newerOutsideTime = new Date("2026-01-03T00:00:00Z");
    await utimes(localFile, oldTime, oldTime);
    await utimes(distFile, distTime, distTime);
    await utimes(outsideFile, newerOutsideTime, newerOutsideTime);

    await symlink(outsideDir, path.join(srcDir, "outside-link"), "dir");

    assert.equal(isAnySourceNewerThan([srcDir], distFile), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
