import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

async function visibleEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => !entry.startsWith(".")).sort();
}
