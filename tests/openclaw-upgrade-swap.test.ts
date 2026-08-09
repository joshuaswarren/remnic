import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupRollbackDirectory,
  cleanupRollbackDirectoryBestEffort,
  createOpenclawUpgradeRollbackFailure,
  restoreDirectoryFromRollback,
  rollbackOpenclawUpgrade,
  runBestEffortGatewayRestart,
} from "../packages/remnic-cli/src/openclaw-upgrade-swap.ts";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openclaw-upgrade-swap-test-"));
}

function writeMarker(dirPath: string, value: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "marker.txt"), value, "utf8");
}

function readMarker(dirPath: string): string {
  return fs.readFileSync(path.join(dirPath, "marker.txt"), "utf8");
}

test("cleanupRollbackDirectory removes the preserved rollback copy after success", async () => {
  const tmp = await makeTmpDir();
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(rollbackDir, "old-plugin");
  cleanupRollbackDirectory(rollbackDir);

  assert.equal(fs.existsSync(rollbackDir), false);
});

test("cleanupRollbackDirectoryBestEffort degrades cleanup failures into a warning", async () => {
  const tmp = await makeTmpDir();
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(rollbackDir, "old-plugin");

  const rmSync = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) === rollbackDir) {
      throw new Error("permission denied");
    }
    return rmSync(target, options);
  }) as typeof fs.rmSync;

  try {
    const warning = cleanupRollbackDirectoryBestEffort(rollbackDir);

    assert.match(warning ?? "", /failed to remove the preserved rollback copy/i);
    assert.match(warning ?? "", /permission denied/);
    assert.equal(fs.existsSync(rollbackDir), true);
  } finally {
    fs.rmSync = rmSync;
  }
});

test("restoreDirectoryFromRollback reinstates the previous plugin copy", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(rollbackDir, "old-plugin");

  const warning = restoreDirectoryFromRollback(pluginDir, rollbackDir);

  assert.equal(warning, undefined);
  assert.equal(readMarker(pluginDir), "old-plugin");
  assert.equal(fs.existsSync(rollbackDir), false);
});

test("restoreDirectoryFromRollback degrades displaced-dir cleanup failures into a warning", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(rollbackDir, "old-plugin");
  const rmSync = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target).includes(".openclaw-remnic.rollback-restore.")) {
      throw new Error("cleanup busy");
    }
    return rmSync(target, options);
  }) as typeof fs.rmSync;

  try {
    const warning = restoreDirectoryFromRollback(pluginDir, rollbackDir);

    assert.match(warning ?? "", /failed to remove the displaced plugin copy/i);
    assert.match(warning ?? "", /cleanup busy/);
    assert.equal(readMarker(pluginDir), "old-plugin");
    assert.equal(fs.existsSync(rollbackDir), false);
  } finally {
    fs.rmSync = rmSync;
  }
});

test("restoreDirectoryFromRollback keeps the current plugin if the rollback rename fails", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(rollbackDir, "old-plugin");
  const renameSync = fs.renameSync;
  let rollbackRenameSeen = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === rollbackDir && String(to) === pluginDir && !rollbackRenameSeen) {
      rollbackRenameSeen = true;
      throw new Error("restore failed");
    }
    return renameSync(from, to);
  }) as typeof fs.renameSync;

  try {
    assert.throws(
      () => restoreDirectoryFromRollback(pluginDir, rollbackDir),
      /Failed to restore the previous plugin copy/
    );
    assert.equal(readMarker(pluginDir), "new-plugin");
    assert.equal(readMarker(rollbackDir), "old-plugin");
  } finally {
    fs.renameSync = renameSync;
  }
});

test("rollbackOpenclawUpgrade restores plugin and config from rollback artifacts", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const rollbackDir = path.join(tmp, "rollback");
  const configPath = path.join(tmp, "openclaw.json");
  const configBackupPath = path.join(tmp, "backups", "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(rollbackDir, "old-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");
  fs.mkdirSync(path.dirname(configBackupPath), { recursive: true });
  fs.writeFileSync(configBackupPath, '{"plugins":{"slots":{"memory":"openclaw-remnic"}}}\n', "utf8");

  const notes = rollbackOpenclawUpgrade({
    configBackupPath,
    configPath,
    pluginDir,
    rollbackDir,
  });

  assert.equal(readMarker(pluginDir), "old-plugin");
  assert.match(fs.readFileSync(configPath, "utf8"), /openclaw-remnic/);
  assert.ok(notes.some((note) => note.includes("Restored previous plugin from rollback copy")));
  assert.ok(notes.some((note) => note.includes("Restored OpenClaw config from backup")));
});

test("rollbackOpenclawUpgrade falls back to the durable backup when rollback restore fails", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const rollbackDir = path.join(tmp, "rollback");
  const pluginBackupDir = path.join(tmp, "backups", "extensions", "openclaw-remnic");
  const configPath = path.join(tmp, "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(rollbackDir, "old-plugin");
  writeMarker(pluginBackupDir, "backup-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");

  const renameSync = fs.renameSync;
  let rollbackRenameSeen = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === rollbackDir && String(to) === pluginDir && !rollbackRenameSeen) {
      rollbackRenameSeen = true;
      throw new Error("rollback rename failed");
    }
    return renameSync(from, to);
  }) as typeof fs.renameSync;

  try {
    const notes = rollbackOpenclawUpgrade({
      configPath,
      pluginBackupDir,
      pluginDir,
      rollbackDir,
    });

    assert.equal(readMarker(pluginDir), "backup-plugin");
    assert.equal(readMarker(rollbackDir), "old-plugin");
    assert.ok(notes.some((note) => note.includes("Rollback copy restore failed")));
    assert.ok(notes.some((note) => note.includes("durable backup")));
  } finally {
    fs.renameSync = renameSync;
  }
});

test("rollbackOpenclawUpgrade falls back to the durable plugin backup when rollback dir is gone", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const pluginBackupDir = path.join(tmp, "backups", "extensions", "openclaw-remnic");
  const configPath = path.join(tmp, "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(pluginBackupDir, "old-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");

  const notes = rollbackOpenclawUpgrade({
    configPath,
    pluginBackupDir,
    pluginDir,
  });

  assert.equal(readMarker(pluginDir), "old-plugin");
  assert.ok(notes.some((note) => note.includes("Restored previous plugin from backup")));
});

test("rollbackOpenclawUpgrade keeps backup restore cleanup failures non-fatal", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const pluginBackupDir = path.join(tmp, "backups", "extensions", "openclaw-remnic");
  const configPath = path.join(tmp, "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(pluginBackupDir, "old-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");

  const rmSync = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target).includes(".openclaw-remnic.pre-backup-restore.")) {
      throw new Error("cleanup busy");
    }
    return rmSync(target, options);
  }) as typeof fs.rmSync;

  try {
    const notes = rollbackOpenclawUpgrade({
      configPath,
      pluginBackupDir,
      pluginDir,
    });

    assert.equal(readMarker(pluginDir), "old-plugin");
    assert.ok(notes.some((note) => note.includes("Restored previous plugin from backup")));
    assert.ok(notes.some((note) => /failed to remove the displaced plugin copy/i.test(note)));
  } finally {
    fs.rmSync = rmSync;
  }
});

test("rollbackOpenclawUpgrade keeps the current plugin when backup restore cannot be swapped in", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const pluginBackupDir = path.join(tmp, "backups", "extensions", "openclaw-remnic");
  const configPath = path.join(tmp, "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(pluginBackupDir, "old-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");

  const renameSync = fs.renameSync;
  let stagedRenameSeen = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === pluginDir && String(from).includes(".openclaw-remnic.backup-restore.") && !stagedRenameSeen) {
      stagedRenameSeen = true;
      throw new Error("swap failed");
    }
    return renameSync(from, to);
  }) as typeof fs.renameSync;

  try {
    assert.throws(
      () =>
        rollbackOpenclawUpgrade({
          configPath,
          pluginBackupDir,
          pluginDir,
        }),
      /Failed to restore the plugin backup into/
    );
    assert.equal(readMarker(pluginDir), "new-plugin");
    assert.equal(readMarker(pluginBackupDir), "old-plugin");
  } finally {
    fs.renameSync = renameSync;
  }
});

test("runBestEffortGatewayRestart reports success when launchctl restart works", () => {
  const result = runBestEffortGatewayRestart(() => {}, "ai.openclaw.gateway");

  assert.equal(result.restarted, true);
  assert.match(result.message, /Restarted OpenClaw gateway/);
});

test("runBestEffortGatewayRestart degrades to a warning when launchctl restart fails", () => {
  const result = runBestEffortGatewayRestart(() => {
    throw new Error("launchctl failed");
  }, "ai.openclaw.gateway");

  assert.equal(result.restarted, false);
  assert.match(result.message, /upgrade completed, but the automatic OpenClaw gateway restart failed/);
  assert.match(result.message, /launchctl kickstart -k gui\/\$\(id -u\)\/ai\.openclaw\.gateway/);
});

test("createOpenclawUpgradeRollbackFailure preserves both the install and rollback failures", () => {
  const installError = new Error("package.json parse failed");
  const rollbackError = new Error("restore rename failed");

  const error = createOpenclawUpgradeRollbackFailure({
    failurePhase: "installing the published plugin",
    installError,
    rollbackError,
  });

  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.equal(error.errors[0], installError);
  assert.equal(error.errors[1], rollbackError);
  assert.match(error.message, /Automatic rollback also failed: restore rename failed/);
  assert.match(error.message, /Original upgrade failure: package\.json parse failed/);
});
