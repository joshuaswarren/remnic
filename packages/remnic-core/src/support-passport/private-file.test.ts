import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendPrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  writePrivateFileAtomicallyNoFollow,
} from "./private-file.js";

test("private append cannot escape its pinned directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-append-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const outsidePath = path.join(root, "outside.jsonl");
  await mkdir(privateDirectory);

  await assert.rejects(appendPrivateFileNoFollow(privateDirectory, outsidePath, "private\n", "private path escaped"));
  await assert.rejects(readFile(outsidePath, "utf8"), { code: "ENOENT" });
});

test("private append fails before mutation when descriptor pinning is unavailable", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-append-win32-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const auditPath = path.join(privateDirectory, "audit.jsonl");
  await assert.rejects(
    ensurePrivateDirectoryNoFollow(root, privateDirectory, "private path escaped", undefined, true, "win32"),
    /private path escaped/
  );
  await assert.rejects(readFile(auditPath, "utf8"), { code: "ENOENT" });
});

test("private append rejects a renamed target after opening it", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-append-rename-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const auditPath = path.join(privateDirectory, "audit.jsonl");
  const movedPath = path.join(privateDirectory, "moved.jsonl");
  await mkdir(privateDirectory);
  await writeFile(auditPath, "before\n", { mode: 0o600 });

  await assert.rejects(
    appendPrivateFileNoFollow(
      privateDirectory,
      auditPath,
      "after\n",
      "audit target changed",
      privateDirectory,
      process.platform,
      async (filePath, flags, mode) => {
        const handle = await open(filePath, flags, mode);
        await rename(auditPath, movedPath);
        return handle;
      }
    ),
    /audit target changed/
  );
  assert.equal(await readFile(movedPath, "utf8"), "before\n");
  await assert.rejects(readFile(auditPath, "utf8"), { code: "ENOENT" });
});

test("private atomic writes reject a final pathname replaced after directory sync", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-private-atomic-rename-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private");
  const markerPath = path.join(privateDirectory, "marker.json");
  const movedPath = path.join(privateDirectory, "moved.json");
  await mkdir(privateDirectory);

  await assert.rejects(
    writePrivateFileAtomicallyNoFollow(
      privateDirectory,
      markerPath,
      "committed\n",
      "marker target changed",
      privateDirectory,
      process.platform,
      async () => {
        await rename(markerPath, movedPath);
        await writeFile(markerPath, "replaced\n", { mode: 0o600 });
      }
    ),
    /marker target changed/
  );
  assert.equal(await readFile(movedPath, "utf8"), "committed\n");
  assert.equal(await readFile(markerPath, "utf8"), "replaced\n");
});
