import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendPrivateFileNoFollow } from "./private-file.js";

test("private append cannot escape its pinned directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-append-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const outsidePath = path.join(root, "outside.jsonl");
  await mkdir(privateDirectory);

  await assert.rejects(appendPrivateFileNoFollow(privateDirectory, outsidePath, "private\n", "private path escaped"));
  await assert.rejects(readFile(outsidePath, "utf8"), { code: "ENOENT" });
});
