import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFixtureMemoryDir, writeSensitiveTransferFixtureEntries } from "./transfer-fixtures.js";
import { backupMemoryDir } from "../src/transfer/backup.js";

async function assertPathMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

test("v2.3 backup creates a timestamped directory", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-backup-"));
  const backupDir = await backupMemoryDir({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const name = path.basename(backupDir);
  assert.match(name, /^\d{4}-\d{2}-\d{2}T/);

  const entries = await readdir(backupDir);
  assert.ok(entries.includes("manifest.json"));
});

test("plaintext backup excludes secure store, capsules, VCS, and dependencies", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  await writeSensitiveTransferFixtureEntries(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-backup-"));
  const backupDir = await backupMemoryDir({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf-8")) as {
    files: Array<{ path: string }>;
  };
  const paths = manifest.files.map((file) => file.path);
  assert.equal(paths.some((entry) => entry.startsWith(".secure-store/")), false);
  assert.equal(paths.some((entry) => entry.startsWith(".capsules/")), false);
  assert.equal(paths.some((entry) => entry.startsWith(".git/")), false);
  assert.equal(paths.some((entry) => entry.startsWith("node_modules/")), false);
  assert.ok(paths.includes("facts/2026-02-11/fact-1.md"));

  await assertPathMissing(path.join(backupDir, ".secure-store", "header.json"));
  await assertPathMissing(path.join(backupDir, ".capsules", "old.capsule.json.gz"));
  await assertPathMissing(path.join(backupDir, ".git", "config"));
  await assertPathMissing(path.join(backupDir, "node_modules", "pkg", "index.js"));
});
