import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

function assertStableDirectory(before: Stats, opened: Stats, after: Stats, errorMessage: string): void {
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    after.dev !== opened.dev ||
    after.ino !== opened.ino
  ) {
    throw new Error(errorMessage);
  }
}

async function openStableDirectory(directory: string, errorMessage: string): Promise<{
  before: Stats;
  opened: Stats;
  handle: FileHandle;
}> {
  const before = await lstat(directory);
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertStableDirectory(before, opened, await lstat(directory), errorMessage);
    return { before, opened, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function readPrivateFileNoFollow(
  directory: string,
  filePath: string,
  errorMessage: string
): Promise<string> {
  let directoryHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectory(directory, errorMessage);
    directoryHandle = stableDirectory.handle;
    try {
      fileHandle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    assertStableDirectory(
      stableDirectory.before,
      stableDirectory.opened,
      await lstat(directory),
      errorMessage
    );
    if (!fileMetadata.isFile() || fileMetadata.nlink !== 1) throw new Error(errorMessage);
    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

export async function appendPrivateFileNoFollow(
  directory: string,
  filePath: string,
  content: string,
  errorMessage: string
): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectory(directory, errorMessage);
    directoryHandle = stableDirectory.handle;
    try {
      fileHandle = await open(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    assertStableDirectory(
      stableDirectory.before,
      stableDirectory.opened,
      await lstat(directory),
      errorMessage
    );
    if (!fileMetadata.isFile() || fileMetadata.nlink !== 1) throw new Error(errorMessage);
    await fileHandle.chmod(0o600);
    await fileHandle.appendFile(content, "utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}
