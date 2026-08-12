import { randomUUID } from "node:crypto";
import { type Stats, constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
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

async function openDirectoryNoFollow(
  directory: string,
  errorMessage: string
): Promise<{
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

async function closeDirectoryHandles(handles: FileHandle[]): Promise<void> {
  for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
}

async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(code ?? "")) throw error;
  }
}

export async function resolvePrivateDirectoryPath(
  directory: string,
  handle: FileHandle,
  opened: Stats,
  errorMessage: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const descriptorRoot = requirePrivateFileDescriptorRoot(platform, errorMessage);
  const pinnedPath = path.join(descriptorRoot, String(handle.fd));
  const metadata = await stat(pinnedPath);
  if (!metadata.isDirectory() || metadata.dev !== opened.dev || metadata.ino !== opened.ino) {
    throw new Error(errorMessage);
  }
  return pinnedPath;
}

export function requirePrivateFileDescriptorRoot(platform: NodeJS.Platform, errorMessage: string): string {
  if (platform === "linux") return "/proc/self/fd";
  throw new Error(errorMessage);
}

async function openStableDirectoryFromRoot(
  trustedRoot: string,
  directory: string,
  errorMessage: string
): Promise<{
  before: Stats;
  opened: Stats;
  handle: FileHandle;
  handles: FileHandle[];
}> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(errorMessage);
  }
  const components = relative === "" ? [] : relative.split(path.sep);
  const handles: FileHandle[] = [];
  let currentPath = root;
  try {
    let current = await openDirectoryNoFollow(root, errorMessage);
    handles.push(current.handle);
    for (const component of components) {
      const pinnedParent = await resolvePrivateDirectoryPath(currentPath, current.handle, current.opened, errorMessage);
      const child = await openDirectoryNoFollow(path.join(pinnedParent, component), errorMessage);
      handles.push(child.handle);
      assertStableDirectory(current.before, current.opened, await lstat(currentPath), errorMessage);
      currentPath = path.join(currentPath, component);
      current = child;
    }
    assertStableDirectory(current.before, current.opened, await lstat(target), errorMessage);
    return { ...current, handles };
  } catch (error) {
    await closeDirectoryHandles(handles);
    throw error;
  }
}

export async function ensurePrivateDirectoryNoFollow(
  trustedRoot: string,
  directory: string,
  errorMessage: string,
  syncVerifiedParent: (handle: FileHandle) => Promise<void> = syncDirectoryHandle
): Promise<void> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(errorMessage);
  }
  const components = relative === "" ? [] : relative.split(path.sep);
  const handles: FileHandle[] = [];
  let currentPath = root;
  try {
    let current = await openDirectoryNoFollow(root, errorMessage);
    handles.push(current.handle);
    for (const component of components) {
      const pinnedParent = await resolvePrivateDirectoryPath(currentPath, current.handle, current.opened, errorMessage);
      const childPath = path.join(pinnedParent, component);
      try {
        await mkdir(childPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await syncVerifiedParent(current.handle);
      const child = await openDirectoryNoFollow(childPath, errorMessage);
      handles.push(child.handle);
      await child.handle.chmod(0o700);
      assertStableDirectory(current.before, current.opened, await lstat(currentPath), errorMessage);
      currentPath = path.join(currentPath, component);
      current = child;
    }
    assertStableDirectory(current.before, current.opened, await lstat(target), errorMessage);
  } finally {
    await closeDirectoryHandles(handles);
  }
}

export async function withPrivateDirectoryNoFollow<T>(
  trustedRoot: string,
  directory: string,
  errorMessage: string,
  task: (pinnedDirectory: string) => Promise<T>
): Promise<T> {
  let directoryHandles: FileHandle[] = [];
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = await resolvePrivateDirectoryPath(
      directory,
      stableDirectory.handle,
      stableDirectory.opened,
      errorMessage
    );
    const result = await task(pinnedDirectory);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    return result;
  } finally {
    await closeDirectoryHandles(directoryHandles);
  }
}

export async function readPrivateFileNoFollow(
  directory: string,
  filePath: string,
  errorMessage: string,
  trustedRoot = directory
): Promise<string> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  let directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = await resolvePrivateDirectoryPath(
      directory,
      stableDirectory.handle,
      stableDirectory.opened,
      errorMessage
    );
    try {
      fileHandle = await open(path.join(pinnedDirectory, targetName), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    if (!fileMetadata.isFile() || fileMetadata.nlink !== 1) throw new Error(errorMessage);
    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await closeDirectoryHandles(directoryHandles);
  }
}

export async function appendPrivateFileNoFollow(
  directory: string,
  filePath: string,
  content: string,
  errorMessage: string,
  trustedRoot = directory
): Promise<void> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  let directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = await resolvePrivateDirectoryPath(
      directory,
      stableDirectory.handle,
      stableDirectory.opened,
      errorMessage
    );
    try {
      fileHandle = await open(
        path.join(pinnedDirectory, targetName),
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
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
    await fileHandle.appendFile(content, "utf8");
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await closeDirectoryHandles(directoryHandles);
  }
}

export async function writePrivateFileAtomicallyNoFollow(
  directory: string,
  filePath: string,
  content: string,
  errorMessage: string,
  trustedRoot = directory
): Promise<void> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  const tempName = `.${targetName}.${randomUUID()}.tmp`;
  let tempPath: string | undefined;
  let directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = await resolvePrivateDirectoryPath(
      directory,
      stableDirectory.handle,
      stableDirectory.opened,
      errorMessage
    );
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
    await syncDirectoryHandle(stableDirectory.handle);
  } finally {
    await fileHandle?.close().catch(() => undefined);
    if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
    await closeDirectoryHandles(directoryHandles);
  }
}

export async function removePrivateFilesNoFollow(
  directory: string,
  fileNames: string[],
  errorMessage: string,
  trustedRoot = directory
): Promise<void> {
  if (
    fileNames.some(
      (fileName) =>
        fileName.length === 0 || fileName === "." || fileName === ".." || path.basename(fileName) !== fileName
    )
  ) {
    throw new Error(errorMessage);
  }
  let directoryHandles: FileHandle[] = [];
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = await resolvePrivateDirectoryPath(
      directory,
      stableDirectory.handle,
      stableDirectory.opened,
      errorMessage
    );
    for (const fileName of fileNames) {
      await rm(path.join(pinnedDirectory, fileName), { force: true });
    }
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    await syncDirectoryHandle(stableDirectory.handle);
  } finally {
    await closeDirectoryHandles(directoryHandles);
  }
}
