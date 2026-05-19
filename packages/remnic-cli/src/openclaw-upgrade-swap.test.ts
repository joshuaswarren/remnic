import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  atomicCopyFileSync,
  atomicWriteFileSync,
} from "./openclaw-upgrade-swap.js";

test("atomicWriteFileSync preserves the target when temp write fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-atomic-write-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(configPath, '{"plugins":{"entries":{"old":true}}}\n', "utf8");

  assert.throws(
    () =>
      atomicWriteFileSync(configPath, '{"plugins":{"entries":{"new":true}}}\n', {
        hooks: {
          writeTempFileSync(tempPath) {
            throw new Error(`simulated write failure for ${tempPath}`);
          },
        },
      }),
    /simulated write failure/,
  );

  assert.equal(await readFile(configPath, "utf8"), '{"plugins":{"entries":{"old":true}}}\n');
  assert.deepEqual(await visibleEntries(root), ["openclaw.json"]);
});

test("atomicWriteFileSync preserves existing owner-only config permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-atomic-mode-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(configPath, '{"plugins":{"entries":{"old":true}}}\n', "utf8");
  await chmod(configPath, 0o600);

  atomicWriteFileSync(configPath, '{"plugins":{"entries":{"new":true}}}\n');

  assert.equal(await readFile(configPath, "utf8"), '{"plugins":{"entries":{"new":true}}}\n');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("atomicWriteFileSync updates symlink targets without replacing the link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-atomic-symlink-write-"));
  const targetPath = path.join(root, "managed", "openclaw.json");
  const linkPath = path.join(root, "openclaw.json");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, '{"plugins":{"entries":{"old":true}}}\n', "utf8");
  await symlink(targetPath, linkPath);

  atomicWriteFileSync(linkPath, '{"plugins":{"entries":{"new":true}}}\n');

  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(targetPath, "utf8"), '{"plugins":{"entries":{"new":true}}}\n');
});

test("atomicCopyFileSync preserves the target when temp copy fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-atomic-copy-"));
  const backupPath = path.join(root, "backup", "openclaw.json");
  const configPath = path.join(root, "live", "openclaw.json");
  await mkdir(path.dirname(backupPath), { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(backupPath, '{"plugins":{"entries":{"backup":true}}}\n', "utf8");
  await writeFile(configPath, '{"plugins":{"entries":{"live":true}}}\n', "utf8");

  assert.throws(
    () =>
      atomicCopyFileSync(backupPath, configPath, {
        hooks: {
          copyTempFileSync(sourcePath, tempPath) {
            throw new Error(`simulated copy failure from ${sourcePath} to ${tempPath}`);
          },
        },
      }),
    /simulated copy failure/,
  );

  assert.equal(await readFile(configPath, "utf8"), '{"plugins":{"entries":{"live":true}}}\n');
  assert.deepEqual(await visibleEntries(path.dirname(configPath)), ["openclaw.json"]);
});

test("atomicCopyFileSync preserves backup file permissions on restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-atomic-copy-mode-"));
  const backupPath = path.join(root, "backup", "openclaw.json");
  const configPath = path.join(root, "live", "openclaw.json");
  await mkdir(path.dirname(backupPath), { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(backupPath, '{"plugins":{"entries":{"backup":true}}}\n', "utf8");
  await writeFile(configPath, '{"plugins":{"entries":{"live":true}}}\n', "utf8");
  await chmod(backupPath, 0o600);
  await chmod(configPath, 0o644);

  atomicCopyFileSync(backupPath, configPath);

  assert.equal(await readFile(configPath, "utf8"), '{"plugins":{"entries":{"backup":true}}}\n');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("atomicCopyFileSync restores through symlink targets without replacing the link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-atomic-symlink-copy-"));
  const backupPath = path.join(root, "backup", "openclaw.json");
  const targetPath = path.join(root, "managed", "openclaw.json");
  const linkPath = path.join(root, "openclaw.json");
  await mkdir(path.dirname(backupPath), { recursive: true });
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(backupPath, '{"plugins":{"entries":{"backup":true}}}\n', "utf8");
  await writeFile(targetPath, '{"plugins":{"entries":{"live":true}}}\n', "utf8");
  await symlink(targetPath, linkPath);

  atomicCopyFileSync(backupPath, linkPath);

  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(targetPath, "utf8"), '{"plugins":{"entries":{"backup":true}}}\n');
});

async function visibleEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => !entry.startsWith(".")).sort();
}
