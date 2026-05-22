import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { writeFileAtomically } from "../packages/remnic-core/src/maintenance/atomic-file.ts";

test("writeFileAtomically copies backups without removing the live file first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-atomic-file-"));
  try {
    const outputPath = path.join(dir, "state", "ledger.jsonl");
    const backupPath = path.join(dir, "archive", "ledger.jsonl");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "old\n", "utf-8");

    const resolvedBackupPath = await writeFileAtomically(outputPath, "new\n", backupPath);

    assert.equal(resolvedBackupPath, backupPath);
    assert.equal(await readFile(backupPath, "utf-8"), "old\n");
    assert.equal(await readFile(outputPath, "utf-8"), "new\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomically leaves the live file intact when backup creation fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-atomic-file-fail-"));
  try {
    const outputPath = path.join(dir, "state", "ledger.jsonl");
    const backupPath = path.join(dir, "archive", "ledger.jsonl");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "old\n", "utf-8");
    await writeFile(path.dirname(backupPath), "not-a-directory", "utf-8");

    await assert.rejects(() => writeFileAtomically(outputPath, "new\n", backupPath));
    assert.equal(await readFile(outputPath, "utf-8"), "old\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
