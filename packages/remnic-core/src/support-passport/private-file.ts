import { randomUUID } from "node:crypto";
import { type Stats, constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const NON_WRITABLE_ANCESTOR_SYNC_ERRORS = new Set(["EROFS", "EPERM", "EACCES"]);

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

function assertStableRegularFile(before: Stats, opened: Stats, after: Stats, errorMessage: string): void {
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    after.isSymbolicLink() ||
    !after.isFile() ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    after.dev !== opened.dev ||
    after.ino !== opened.ino ||
    opened.nlink !== 1
  ) {
    throw new Error(errorMessage);
  }
}

function openFlags(...flags: Array<number | undefined>): number {
  let combined = 0;
  for (const flag of flags) combined |= typeof flag === "number" ? flag : 0;
  return combined;
}

function assertContainedPath(trustedRoot: string, directory: string, errorMessage: string): void {
  const relative = path.relative(path.resolve(trustedRoot), path.resolve(directory));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
  const handle = await open(
    directory,
    openFlags(fsConstants.O_RDONLY, fsConstants.O_DIRECTORY, fsConstants.O_NOFOLLOW)
  );
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
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") return "/dev/fd";
  throw new Error(errorMessage);
}

async function openStableDirectoryFromRoot(
  trustedRoot: string,
  directory: string,
  errorMessage: string,
  platform: NodeJS.Platform = process.platform
): Promise<{
  before: Stats;
  opened: Stats;
  handle?: FileHandle;
  handles: FileHandle[];
  pinnedDirectory: string;
}> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(directory);
  assertContainedPath(root, target, errorMessage);
  requirePrivateFileDescriptorRoot(platform, errorMessage);
  const relative = path.relative(root, target);
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
    return {
      ...current,
      handles,
      pinnedDirectory: await resolvePrivateDirectoryPath(
        target,
        current.handle,
        current.opened,
        errorMessage,
        platform
      ),
    };
  } catch (error) {
    await closeDirectoryHandles(handles);
    throw error;
  }
}

export async function ensurePrivateDirectoryNoFollow(
  trustedRoot: string,
  directory: string,
  errorMessage: string,
  syncVerifiedParent: (handle: FileHandle) => Promise<void> = syncDirectoryHandle,
  hardenExistingChildren = true,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(directory);
  assertContainedPath(root, target, errorMessage);
  const relative = path.relative(root, target);
  requirePrivateFileDescriptorRoot(platform, errorMessage);
  const components = relative === "" ? [] : relative.split(path.sep);
  const handles: FileHandle[] = [];
  let currentPath = root;
  try {
    let current = await openDirectoryNoFollow(root, errorMessage);
    handles.push(current.handle);
    for (const component of components) {
      const pinnedParent = await resolvePrivateDirectoryPath(currentPath, current.handle, current.opened, errorMessage);
      const childPath = path.join(pinnedParent, component);
      let created = false;
      try {
        await mkdir(childPath, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await syncVerifiedParent(current.handle);
      const child = await openDirectoryNoFollow(childPath, errorMessage);
      handles.push(child.handle);
      if (created || (hardenExistingChildren && (child.opened.mode & 0o777) !== 0o700)) {
        await child.handle.chmod(0o700);
      }
      assertStableDirectory(current.before, current.opened, await lstat(currentPath), errorMessage);
      currentPath = path.join(currentPath, component);
      current = child;
    }
    assertStableDirectory(current.before, current.opened, await lstat(target), errorMessage);
  } finally {
    await closeDirectoryHandles(handles);
  }
}

export async function ensurePrivateDirectoryTreeNoFollow(
  directory: string,
  errorMessage: string,
  syncVerifiedParent: (handle: FileHandle) => Promise<void> = syncDirectoryHandle,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const target = path.resolve(directory);
  const filesystemRoot = path.parse(target).root;
  const rootMetadata = await stat(filesystemRoot);
  await ensurePrivateDirectoryNoFollow(
    filesystemRoot,
    target,
    errorMessage,
    async (handle) => {
      try {
        await syncVerifiedParent(handle);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const metadata = await handle.stat();
        if (
          metadata.ino === rootMetadata.ino &&
          metadata.dev === rootMetadata.dev &&
          NON_WRITABLE_ANCESTOR_SYNC_ERRORS.has(code ?? "")
        ) {
          return;
        }
        throw error;
      }
    },
    false,
    platform
  );
}

export async function withPrivateDirectoryNoFollow<T>(
  trustedRoot: string,
  directory: string,
  errorMessage: string,
  task: (pinnedDirectory: string) => Promise<T>,
  platform: NodeJS.Platform = process.platform
): Promise<T> {
  let directoryHandles: FileHandle[] = [];
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage, platform);
    directoryHandles = stableDirectory.handles;
    const result = await task(stableDirectory.pinnedDirectory);
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
  trustedRoot = directory,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  let directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage, platform);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = stableDirectory.pinnedDirectory;
    const targetPath = path.join(pinnedDirectory, targetName);
    const before = await lstat(targetPath);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(errorMessage);
    try {
      fileHandle = await open(targetPath, openFlags(fsConstants.O_RDONLY, fsConstants.O_NOFOLLOW));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    assertStableRegularFile(before, fileMetadata, await lstat(targetPath), errorMessage);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
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
  trustedRoot = directory,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  let directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage, platform);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = stableDirectory.pinnedDirectory;
    const targetPath = path.join(pinnedDirectory, targetName);
    try {
      fileHandle = await open(
        targetPath,
        openFlags(fsConstants.O_WRONLY, fsConstants.O_APPEND, fsConstants.O_CREAT, fsConstants.O_NOFOLLOW),
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    if (platform === "win32") await assertAbsoluteDirectoryChainNoFollow(directory, errorMessage);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    if (!fileMetadata.isFile() || fileMetadata.nlink !== 1) throw new Error(errorMessage);
    await fileHandle.chmod(0o600);
    await fileHandle.appendFile(content, "utf8");
    await fileHandle.sync();
    if (platform === "win32") await assertAbsoluteDirectoryChainNoFollow(directory, errorMessage);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    if (stableDirectory.handle) await syncDirectoryHandle(stableDirectory.handle);
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
  trustedRoot = directory,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (path.dirname(filePath) !== path.resolve(directory)) throw new Error(errorMessage);
  const targetName = path.basename(filePath);
  const tempName = `.${targetName}.${randomUUID()}.tmp`;
  let tempPath: string | undefined;
  let directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage, platform);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = stableDirectory.pinnedDirectory;
    tempPath = path.join(pinnedDirectory, tempName);
    const targetPath = path.join(pinnedDirectory, targetName);
    try {
      fileHandle = await open(
        tempPath,
        openFlags(fsConstants.O_WRONLY, fsConstants.O_CREAT, fsConstants.O_EXCL, fsConstants.O_NOFOLLOW),
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorMessage);
      throw error;
    }
    const fileMetadata = await fileHandle.stat();
    const tempMetadata = await lstat(tempPath);
    assertStableRegularFile(tempMetadata, fileMetadata, await lstat(tempPath), errorMessage);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    await fileHandle.chmod(0o600);
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    await rename(tempPath, targetPath);
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    if (stableDirectory.handle) await syncDirectoryHandle(stableDirectory.handle);
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
  trustedRoot = directory,
  platform: NodeJS.Platform = process.platform
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
    const stableDirectory = await openStableDirectoryFromRoot(trustedRoot, directory, errorMessage, platform);
    directoryHandles = stableDirectory.handles;
    const pinnedDirectory = stableDirectory.pinnedDirectory;
    for (const fileName of fileNames) {
      await rm(path.join(pinnedDirectory, fileName), { force: true });
    }
    assertStableDirectory(stableDirectory.before, stableDirectory.opened, await lstat(directory), errorMessage);
    if (stableDirectory.handle) await syncDirectoryHandle(stableDirectory.handle);
  } finally {
    await closeDirectoryHandles(directoryHandles);
  }
}
