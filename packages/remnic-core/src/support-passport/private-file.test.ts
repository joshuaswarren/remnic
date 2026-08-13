import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendPrivateFileNoFollow, ensurePrivateDirectoryNoFollow } from "./private-file.js";

test("private append cannot escape its pinned directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-append-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const outsidePath = path.join(root, "outside.jsonl");
  await mkdir(privateDirectory);

  await assert.rejects(appendPrivateFileNoFollow(privateDirectory, outsidePath, "private\n", "private path escaped"));
  await assert.rejects(readFile(outsidePath, "utf8"), { code: "ENOENT" });
});

test("private append works through the Windows-safe path strategy", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-append-win32-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const auditPath = path.join(privateDirectory, "audit.jsonl");
  await ensurePrivateDirectoryNoFollow(root, privateDirectory, "private path escaped", undefined, true, "win32");

  await appendPrivateFileNoFollow(privateDirectory, auditPath, "first\n", "private path escaped", root, "win32");
  await appendPrivateFileNoFollow(privateDirectory, auditPath, "second\n", "private path escaped", root, "win32");

  assert.equal(await readFile(auditPath, "utf8"), "first\nsecond\n");
});
