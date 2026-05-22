import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import {
  createSpace,
  pushToSpace,
} from "../packages/remnic-core/src/spaces/index.ts";

async function writeMemory(filePath: string, id: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    [
      "---",
      `id: ${id}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf-8",
  );
}

test("pushToSpace skips symlinked markdown files outside the source space", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-spaces-symlink-"));
  const sourceDir = path.join(baseDir, "source-memory");
  const targetDir = path.join(baseDir, "target-memory");
  const outsideDir = path.join(baseDir, "outside");

  createSpace({
    name: "Source",
    kind: "project",
    memoryDir: sourceDir,
    baseDir,
  });
  createSpace({
    name: "Target",
    kind: "project",
    memoryDir: targetDir,
    baseDir,
  });

  await writeMemory(path.join(sourceDir, "facts", "safe.md"), "safe", "safe content");
  await writeMemory(path.join(outsideDir, "secret.md"), "secret", "external secret");
  try {
    await symlink(
      path.join(outsideDir, "secret.md"),
      path.join(sourceDir, "facts", "secret.md"),
    );
  } catch {
    return;
  }

  const result = pushToSpace("source", "target", { baseDir });
  assert.equal(result.memoriesPushed, 1);

  const copiedSafe = await readFile(path.join(targetDir, "facts", "safe.md"), "utf-8");
  assert.match(copiedSafe, /safe content/);
  await assert.rejects(() => stat(path.join(targetDir, "facts", "secret.md")));
});
