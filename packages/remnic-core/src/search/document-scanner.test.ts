import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanMemoryDir } from "./document-scanner.js";

test("scanMemoryDir rejects symlinked category roots", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scan-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scan-outside-"));
  try {
    await writeFile(
      path.join(outsideDir, "outside.md"),
      [
        "---",
        "id: outside",
        "---",
        "Outside memory should not be indexed.",
      ].join("\n"),
      "utf8",
    );
    await symlink(outsideDir, path.join(memoryDir, "facts"), "dir");

    await assert.rejects(
      () => scanMemoryDir(memoryDir),
      /symlinked memory category directory/,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("scanMemoryDir skips nested symlink entries", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scan-nested-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-scan-nested-outside-"));
  try {
    const factsDir = path.join(memoryDir, "facts");
    await mkdir(factsDir, { recursive: true });
    await writeFile(
      path.join(factsDir, "inside.md"),
      [
        "---",
        "id: inside",
        "---",
        "Inside memory should be indexed.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(outsideDir, "outside.md"),
      [
        "---",
        "id: outside",
        "---",
        "Outside memory should not be indexed.",
      ].join("\n"),
      "utf8",
    );
    await symlink(outsideDir, path.join(factsDir, "outside"), "dir");

    const docs = await scanMemoryDir(memoryDir);

    assert.deepEqual(docs.map((doc) => doc.docid), ["inside"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
