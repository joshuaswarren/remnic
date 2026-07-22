import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pruneExpiredRawAudio } from "./janitor.js";

test("pruneExpiredRawAudio removes only expired regular files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capture-janitor-"));
  const raw = path.join(root, "raw");
  const outside = path.join(root, "outside.wav");
  const oldFile = path.join(raw, "old.wav");
  const freshFile = path.join(raw, "fresh.wav");
  await mkdir(raw);
  await Promise.all([writeFile(oldFile, "old"), writeFile(freshFile, "fresh"), writeFile(outside, "outside")]);
  await utimes(oldFile, new Date(0), new Date(0));
  await symlink(outside, path.join(raw, "linked.wav"));

  const removed = await pruneExpiredRawAudio(raw, 1_000, 2_000);

  assert.deepEqual(removed, [oldFile]);
  assert.equal(await readFile(freshFile, "utf8"), "fresh");
  assert.equal(await readFile(outside, "utf8"), "outside");
});

test("pruneExpiredRawAudio rejects a symlinked raw root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capture-janitor-"));
  const target = path.join(root, "target");
  const raw = path.join(root, "raw");
  await mkdir(target);
  await symlink(target, raw);

  await assert.rejects(pruneExpiredRawAudio(raw, 1_000, 2_000), /non-symlink/);
});
