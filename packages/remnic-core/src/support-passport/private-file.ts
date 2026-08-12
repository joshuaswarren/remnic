import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

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
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(errorMessage);
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

async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(code ?? "")) throw error;
  }
}

async function pinnedDirectoryPath(
  directory: string,
  handle: FileHandle,
  opened: Stats,
  errorMessage: string
): Promise<string> {
  const descriptorRoot =
    process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : null;
  if (!descriptorRoot) return directory;
  const pinnedPath = path.join(descriptorRoot, String(handle.fd));
  const metadata = await stat(pinnedPath);
  if (!metadata.isDirectory() || metadata.dev !== opened.dev || metadata.ino !== opened.ino) {
    throw new Error(errorMessage);
  }
  return pinnedPath;
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

export async function writePrivateFileAtomicallyNoFollow(
  directory: string,
  filePath: string,
  content: string,
  errorMessage: string
): Promise<void> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  const tempName = `.${targetName}.${randomUUID()}.tmp`;
  let tempPath = path.join(directory, tempName);
  let directoryHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectory(directory, errorMessage);
    directoryHandle = stableDirectory.handle;
    const pinnedDirectory = await pinnedDirectoryPath(directory, directoryHandle, stableDirectory.opened, errorMessage);
    tempPath = path.join(pinnedDirectory, tempName);
    const targetPath = path.join(pinnedDirectory, targetName);
    try {
      fileHandle = await open(
        tempPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    if (!fileMetadata.isFile() || fileMetadata.nlink !== 1) throw new Error(errorMessage);
    await fileHandle.chmod(0o600);
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    await rename(tempPath, targetPath);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    await syncDirectoryHandle(directoryHandle);
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

export async function removePrivateFilesNoFollow(
  directory: string,
  fileNames: string[],
  errorMessage: string
): Promise<void> {
  if (
    fileNames.some(
      (fileName) => fileName.length === 0 || fileName === "." || fileName === ".." || path.basename(fileName) !== fileName
    )
  ) {
    throw new Error(errorMessage);
  }
  let directoryHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectory(directory, errorMessage);
    directoryHandle = stableDirectory.handle;
    const pinnedDirectory = await pinnedDirectoryPath(directory, directoryHandle, stableDirectory.opened, errorMessage);
    for (const fileName of fileNames) {
      await rm(path.join(pinnedDirectory, fileName), { force: true });
    }
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    await syncDirectoryHandle(directoryHandle);
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}
