import path from "node:path";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort across platforms and filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function tempPathFor(outputPath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${suffix}.tmp`);
}

export async function copyExistingFileToBackup(
  sourcePath: string,
  backupPath: string,
): Promise<string | undefined> {
  try {
    await stat(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(sourcePath, backupPath);
  return backupPath;
}

export async function writeFileAtomically(
  outputPath: string,
  content: string,
  backupPath?: string,
): Promise<string | undefined> {
  const dir = path.dirname(outputPath);
  await mkdir(dir, { recursive: true });
  const tempPath = tempPathFor(outputPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let resolvedBackupPath: string | undefined;
  try {
    handle = await open(tempPath, "w");
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (backupPath) {
      resolvedBackupPath = await copyExistingFileToBackup(outputPath, backupPath);
    }
    await rename(tempPath, outputPath);
    await syncDirectory(dir);
    return resolvedBackupPath;
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function commitPreparedFileAtomically(
  tempPath: string,
  outputPath: string,
  backupPath?: string,
): Promise<string | undefined> {
  const dir = path.dirname(outputPath);
  let resolvedBackupPath: string | undefined;
  try {
    if (backupPath) {
      resolvedBackupPath = await copyExistingFileToBackup(outputPath, backupPath);
    }
    await rename(tempPath, outputPath);
    await syncDirectory(dir);
    return resolvedBackupPath;
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
