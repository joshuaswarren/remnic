import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZodError } from "zod";

import { EngramAccessInputError } from "./access-errors.js";
import { defaultCapsulesDir } from "./capsule-cli.js";
import { isCapsuleImportArchiveInputError, validateCapsuleImportArchive } from "./capsule-import-gate.js";

async function storeFixture(t: test.TestContext): Promise<{ storageDir: string; archivePath: string }> {
  const storageDir = await mkdtemp(path.join(tmpdir(), "remnic-gate-"));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const storeDir = defaultCapsulesDir(storageDir);
  await mkdir(storeDir, { recursive: true });
  const archivePath = path.join(storeDir, "capsule.tgz");
  await writeFile(archivePath, "archive-bytes");
  return { storageDir, archivePath };
}

test("capsule import gate: an archive inside the capsule store validates", async (t) => {
  const { storageDir, archivePath } = await storeFixture(t);
  await assert.doesNotReject(validateCapsuleImportArchive(archivePath, storageDir));
});

test("capsule import gate: an archive outside the store is refused with the shared message", async (t) => {
  const { storageDir } = await storeFixture(t);
  const outside = path.join(storageDir, "outside.tgz");
  await writeFile(outside, "bytes");

  await assert.rejects(
    validateCapsuleImportArchive(outside, storageDir),
    (err: Error) =>
      err instanceof EngramAccessInputError &&
      /existing file inside the namespace capsule store/.test(err.message),
  );
});

test("capsule import gate: a missing path is refused without revealing it is missing", async (t) => {
  const { storageDir } = await storeFixture(t);
  const missing = path.join(defaultCapsulesDir(storageDir), "never.tgz");

  await assert.rejects(
    validateCapsuleImportArchive(missing, storageDir),
    /existing file inside the namespace capsule store/,
  );
});

test("capsule import gate: .. traversal out of the store is refused", async (t) => {
  const { storageDir, archivePath } = await storeFixture(t);
  const traversed = path.join(defaultCapsulesDir(storageDir), "..", "outside-store.tgz");
  await writeFile(path.resolve(traversed), "bytes");

  await assert.rejects(
    validateCapsuleImportArchive(traversed, storageDir),
    /existing file inside the namespace capsule store/,
  );
  // The real archive still validates — the refusal is about the traversal, not the store.
  await assert.doesNotReject(validateCapsuleImportArchive(archivePath, storageDir));
});

test("capsule import gate: a store symlink to a file outside the store is refused", async (t) => {
  const { storageDir } = await storeFixture(t);
  const outside = path.join(storageDir, "outside-target.tgz");
  await writeFile(outside, "bytes");
  // The link path itself sits inside the store; only its real path escapes.
  const link = path.join(defaultCapsulesDir(storageDir), "escape.tgz");
  await symlink(outside, link);

  await assert.rejects(
    validateCapsuleImportArchive(link, storageDir),
    /existing file inside the namespace capsule store/,
  );
});

test("capsule import gate: a directory inside the store is refused as not-a-file", async (t) => {
  const { storageDir } = await storeFixture(t);
  await mkdir(path.join(defaultCapsulesDir(storageDir), "a-dir"), { recursive: true });

  await assert.rejects(
    validateCapsuleImportArchive(path.join(defaultCapsulesDir(storageDir), "a-dir"), storageDir),
    /must point to a file/,
  );
});

test("capsule import gate: a missing capsule store is refused like any other path", async (t) => {
  const storageDir = await mkdtemp(path.join(tmpdir(), "remnic-gate-nostore-"));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const archivePath = path.join(storageDir, "whatever.tgz");

  await assert.rejects(
    validateCapsuleImportArchive(archivePath, storageDir),
    /existing file inside the namespace capsule store/,
  );
});

test("archive input classifier: zod errors and archive-shape messages are input faults", () => {
  assert.ok(isCapsuleImportArchiveInputError(new ZodError([]), "anything"));
  assert.ok(isCapsuleImportArchiveInputError(Object.assign(new Error("x"), { code: "Z_ANY" }), "anything"));
  assert.ok(isCapsuleImportArchiveInputError(new Error("y"), "importCapsule: archive is truncated"));
  assert.ok(isCapsuleImportArchiveInputError(new Error("y"), "importCapsule: manifest invalid"));
  assert.ok(isCapsuleImportArchiveInputError(new Error("y"), "gunzip failed: incorrect header check"));
  assert.ok(isCapsuleImportArchiveInputError(new Error("y"), "unexpected end of file"));
  assert.ok(!isCapsuleImportArchiveInputError(new Error("db unavailable"), "importCapsule: backend write failed"));
});
