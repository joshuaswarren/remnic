import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeMemoryFileWithRetry } from "./migrate-utils.js";

test("migration memory writes retry colliding ids without overwriting existing files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migrate-"));
  const subdir = "facts/2026-05-21";
  await mkdir(path.join(memoryDir, subdir), { recursive: true });
  await writeFile(
    path.join(memoryDir, subdir, "fact-collision.md"),
    "original fact\n",
    "utf-8",
  );
  const ids = ["fact-collision", "fact-unique"];

  const result = await writeMemoryFileWithRetry({
    memoryDir,
    dryRun: false,
    subdir,
    prefix: "fact",
    makeId: () => ids.shift() ?? "fact-extra",
    buildContent: (id) => `id: ${id}\n\nnew fact\n`,
  });

  assert.deepEqual(result, { id: "fact-unique", filename: "fact-unique.md" });
  assert.equal(
    await readFile(path.join(memoryDir, subdir, "fact-collision.md"), "utf-8"),
    "original fact\n",
  );
  assert.equal(
    await readFile(path.join(memoryDir, subdir, "fact-unique.md"), "utf-8"),
    "id: fact-unique\n\nnew fact\n",
  );
});
