import fs from "node:fs";
import path from "node:path";

export interface PreparedDirectorySwap {
  rollbackDir?: string;
}

export interface RollbackOpenclawUpgradeOptions {
  configBackupPath?: string;
  configPath: string;
  pluginBackupDir?: string;
  pluginDir: string;
  rollbackDir?: string;
}

export interface BestEffortGatewayRestartResult {
  message: string;
  restarted: boolean;
}

interface AtomicFileOperationHooks {
  copyTempFileSync?: (sourcePath: string, tempPath: string) => void;
  renameTempFileSync?: (tempPath: string, targetPath: string) => void;
  writeTempFileSync?: (tempPath: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSiblingTempFilePath(targetPath: string, label: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${label}.${nonce}.tmp`);
}

function resolveAtomicWriteMode(targetPath: string, explicitMode: fs.Mode | undefined): fs.Mode {
  if (explicitMode !== undefined) return explicitMode;
  try {
    return fs.statSync(targetPath).mode & 0o7777;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0o600;
    }
    throw error;
  }
}

function resolveAtomicReplacementPath(targetPath: string): string {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      return fs.realpathSync(targetPath);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return targetPath;
    }
    throw error;
  }
  return targetPath;
}

function createSiblingSwapPath(targetDir: string, label: string): string {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.${label}.${nonce}`);
}

function cleanupDisplacedDirectoryBestEffort(
  displacedDir: string | undefined,
  context: string,
): string | undefined {
  if (!displacedDir) return undefined;

  try {
    fs.rmSync(displacedDir, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return (
      `Warning: ${context}, but failed to remove the displaced plugin copy at ` +
      `${displacedDir}: ${describeError(error)}`
    );
  }
}

export function atomicWriteFileSync(
  targetPath: string,
  data: string | NodeJS.ArrayBufferView,
  options: { hooks?: AtomicFileOperationHooks; mode?: fs.Mode } = {},
): void {
  const resolvedTargetPath = resolveAtomicReplacementPath(targetPath);
  fs.mkdirSync(path.dirname(resolvedTargetPath), { recursive: true });
  const tempPath = createSiblingTempFilePath(resolvedTargetPath, "write");
  const mode = resolveAtomicWriteMode(resolvedTargetPath, options.mode);

  try {
    if (options.hooks?.writeTempFileSync) {
      options.hooks.writeTempFileSync(tempPath);
    } else {
      fs.writeFileSync(tempPath, data, { mode });
    }
    fs.chmodSync(tempPath, mode);
    const renameTempFileSync = options.hooks?.renameTempFileSync ?? fs.renameSync;
    renameTempFileSync(tempPath, resolvedTargetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function atomicCopyFileSync(
  sourcePath: string,
  targetPath: string,
  options: { hooks?: AtomicFileOperationHooks } = {},
): void {
  if (!fs.existsSync(sourcePath)) return;
  const resolvedTargetPath = resolveAtomicReplacementPath(targetPath);
  fs.mkdirSync(path.dirname(resolvedTargetPath), { recursive: true });
  const tempPath = createSiblingTempFilePath(resolvedTargetPath, "copy");
  const mode = fs.statSync(sourcePath).mode & 0o7777;

  try {
    const copyTempFileSync = options.hooks?.copyTempFileSync ?? fs.copyFileSync;
    copyTempFileSync(sourcePath, tempPath);
    fs.chmodSync(tempPath, mode);
    const renameTempFileSync = options.hooks?.renameTempFileSync ?? fs.renameSync;
    renameTempFileSync(tempPath, resolvedTargetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function swapDirectoryWithRollback(
  stagedDir: string,
  targetDir: string,
  rollbackDir: string,
): PreparedDirectorySwap {
  let hasRollbackCopy = false;

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.rmSync(rollbackDir, { recursive: true, force: true });
  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, rollbackDir);
    hasRollbackCopy = true;
  }

  try {
    fs.renameSync(stagedDir, targetDir);
  } catch (swapError) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    if (hasRollbackCopy && fs.existsSync(rollbackDir)) {
      try {
        fs.renameSync(rollbackDir, targetDir);
        hasRollbackCopy = false;
      } catch (restoreError) {
        throw new AggregateError(
          [swapError, restoreError],
          `Failed to stage upgraded plugin and failed to restore the previous plugin copy. ` +
          `The last known-good plugin remains preserved at ${rollbackDir}.`,
        );
      }
    }
    throw swapError;
  }

  return { rollbackDir: hasRollbackCopy ? rollbackDir : undefined };
}

export function cleanupRollbackDirectory(rollbackDir?: string): void {
  if (!rollbackDir) return;
  fs.rmSync(rollbackDir, { recursive: true, force: true });
}

export function cleanupRollbackDirectoryBestEffort(rollbackDir?: string): string | undefined {
  if (!rollbackDir) return undefined;

  try {
    cleanupRollbackDirectory(rollbackDir);
    return undefined;
  } catch (error) {
    return (
      `Warning: the upgrade completed, but failed to remove the preserved rollback copy at ` +
      `${rollbackDir}: ${describeError(error)}`
    );
  }
}

export function restoreDirectoryFromRollback(
  targetDir: string,
  rollbackDir: string,
): string | undefined {
  if (!fs.existsSync(rollbackDir)) {
    throw new Error(`Rollback directory is missing: ${rollbackDir}`);
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const displacedDir = fs.existsSync(targetDir)
    ? createSiblingSwapPath(targetDir, "rollback-restore")
    : undefined;

  if (displacedDir) {
    fs.renameSync(targetDir, displacedDir);
  }

  try {
    fs.renameSync(rollbackDir, targetDir);
  } catch (restoreError) {
    if (displacedDir && fs.existsSync(displacedDir)) {
      try {
        fs.renameSync(displacedDir, targetDir);
      } catch (revertError) {
        throw new AggregateError(
          [restoreError, revertError],
          `Failed to restore the previous plugin copy into ${targetDir}, and failed to put the ` +
          `current plugin copy back in place. The last known-good plugin remains preserved at ` +
          `${rollbackDir}. The displaced plugin copy remains preserved at ${displacedDir}.`,
        );
      }
    }

    throw new Error(
      `Failed to restore the previous plugin copy into ${targetDir}. ` +
      `The last known-good plugin remains preserved at ${rollbackDir}.`,
      { cause: restoreError },
    );
  }

  return cleanupDisplacedDirectoryBestEffort(
    displacedDir,
    `restored the previous plugin copy into ${targetDir}`,
  );
}

function restoreDirectoryFromBackup(targetDir: string, backupDir: string): string | undefined {
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Plugin backup directory is missing: ${backupDir}`);
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  const stagedDir = createSiblingSwapPath(targetDir, "backup-restore");
  const displacedDir = fs.existsSync(targetDir)
    ? createSiblingSwapPath(targetDir, "pre-backup-restore")
    : undefined;

  fs.cpSync(backupDir, stagedDir, { recursive: true });

  if (displacedDir) {
    fs.renameSync(targetDir, displacedDir);
  }

  try {
    fs.renameSync(stagedDir, targetDir);
  } catch (restoreError) {
    fs.rmSync(targetDir, { recursive: true, force: true });

    if (displacedDir && fs.existsSync(displacedDir)) {
      try {
        fs.renameSync(displacedDir, targetDir);
      } catch (revertError) {
        throw new AggregateError(
          [restoreError, revertError],
          `Failed to restore the plugin backup into ${targetDir}, and failed to put the current ` +
          `plugin copy back in place. The durable backup remains preserved at ${backupDir}. ` +
          `The displaced plugin copy remains preserved at ${displacedDir}.`,
        );
      }
    }

    fs.rmSync(stagedDir, { recursive: true, force: true });
    throw new Error(
      `Failed to restore the plugin backup into ${targetDir}. ` +
      `The durable backup remains preserved at ${backupDir}.`,
      { cause: restoreError },
    );
  }

  return cleanupDisplacedDirectoryBestEffort(
    displacedDir,
    `restored the plugin backup into ${targetDir}`,
  );
}

function restoreFileFromBackup(targetPath: string, backupPath: string): void {
  atomicCopyFileSync(backupPath, targetPath);
}

export function rollbackOpenclawUpgrade({
  configBackupPath,
  configPath,
  pluginBackupDir,
  pluginDir,
  rollbackDir,
}: RollbackOpenclawUpgradeOptions): string[] {
  const notes: string[] = [];
  const errors: string[] = [];
  let rollbackRestoreError: string | undefined;
  let pluginRestored = false;

  try {
    if (rollbackDir && fs.existsSync(rollbackDir)) {
      const cleanupWarning = restoreDirectoryFromRollback(pluginDir, rollbackDir);
      notes.push(`Restored previous plugin from rollback copy at ${rollbackDir}`);
      if (cleanupWarning) notes.push(cleanupWarning);
      pluginRestored = true;
    }
  } catch (error) {
    rollbackRestoreError = error instanceof Error ? error.message : String(error);
  }

  try {
    if (!pluginRestored && pluginBackupDir && fs.existsSync(pluginBackupDir)) {
      const cleanupWarning = restoreDirectoryFromBackup(pluginDir, pluginBackupDir);
      if (rollbackRestoreError) {
        notes.push(
          `Rollback copy restore failed; restored previous plugin from durable backup at ` +
          `${pluginBackupDir}`,
        );
      } else {
        notes.push(`Restored previous plugin from backup at ${pluginBackupDir}`);
      }
      if (cleanupWarning) notes.push(cleanupWarning);
      pluginRestored = true;
    } else if (!pluginRestored && !rollbackRestoreError) {
      notes.push("No previous plugin copy was available for automatic restore");
    }
  } catch (error) {
    if (rollbackRestoreError) {
      errors.push(rollbackRestoreError);
      rollbackRestoreError = undefined;
    }
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!pluginRestored && rollbackRestoreError) {
    errors.push(rollbackRestoreError);
  } else if (!pluginRestored && notes.length === 0) {
    notes.push("No previous plugin copy was available for automatic restore");
  }

  try {
    if (configBackupPath && fs.existsSync(configBackupPath)) {
      restoreFileFromBackup(configPath, configBackupPath);
      notes.push(`Restored OpenClaw config from backup at ${configBackupPath}`);
    }
  } catch (error) {
    errors.push(
      `Failed to restore OpenClaw config from backup at ${configBackupPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  return notes;
}

export function createOpenclawUpgradeRollbackFailure(options: {
  failurePhase: string;
  installError: unknown;
  rollbackError: unknown;
}): AggregateError {
  const { failurePhase, installError, rollbackError } = options;
  return new AggregateError(
    [installError, rollbackError],
    `OpenClaw upgrade failed while ${failurePhase}. ` +
    `Automatic rollback also failed: ${describeError(rollbackError)}. ` +
    `Original upgrade failure: ${describeError(installError)}.`,
  );
}

export function runBestEffortGatewayRestart(
  restartGateway: () => void,
  gatewayLabel: string,
): BestEffortGatewayRestartResult {
  try {
    restartGateway();
    return {
      message: `Restarted OpenClaw gateway via launchctl kickstart (${gatewayLabel}).`,
      restarted: true,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      message:
        `Warning: the upgrade completed, but the automatic OpenClaw gateway restart failed: ${reason}\n` +
        "Run this manually when you're ready:\n" +
        `  launchctl kickstart -k gui/$(id -u)/${gatewayLabel}`,
      restarted: false,
    };
  }
}
