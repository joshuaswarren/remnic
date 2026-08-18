/**
 * Directory-relative I/O for the flush-plan snapshot files (issue #2380).
 *
 * The ingester walks the plan file, its sidecars, and every directory down to
 * the workspace root and refuses a symlink anywhere on the way — once before
 * the lock wait and again inside the lock. That answers for the tree as it was
 * at check time, and `O_NOFOLLOW` constrains only the FINAL path component. A
 * local process that can write the gateway's plugin-state directory can
 * therefore replace a checked PARENT directory with a symlink after the check,
 * and the temp-file create, rename, and unlink that follow all resolve through
 * the swap.
 *
 * Node exposes no `openat`, `renameat`, or `unlinkat`, but the kernel offers
 * the same guarantee through the per-process descriptor directory: a path under
 * `/proc/self/fd/<fd>/` (Linux) or `/dev/fd/<fd>/` (macOS and the BSDs)
 * resolves through the OPEN descriptor's inode instead of re-walking the
 * textual path. Opening the snapshot directory once and holding that handle for
 * the whole ingestion therefore makes every snapshot create, rename, and unlink
 * directory-relative: a parent swapped afterwards is simply not the directory
 * the writes land in.
 */

import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, stat } from "node:fs/promises";
import path from "node:path";

/** Every file one flush-plan ingestion touches. All share one directory. */
export interface SnapshotPaths {
  plan: string;
  inflight: string;
  rotating: string;
  oversized: string;
  /**
   * The cross-process lock. Acquired before the directory is pinned, so it
   * stays a real filesystem path; a parent swap can only make its refresh
   * report lost ownership, which declines the flush instead of writing.
   */
  lock: string;
  /**
   * Real path of `oversized`, for log lines. The I/O paths above may be
   * descriptor-anchored, which means nothing to whoever reads the warning.
   */
  oversizedLabel: string;
}

export function buildSnapshotPaths(planPath: string): SnapshotPaths {
  return {
    plan: planPath,
    inflight: `${planPath}.inflight`,
    rotating: `${planPath}.rotating`,
    oversized: `${planPath}.oversized`,
    lock: `${planPath}.lock`,
    oversizedLabel: `${planPath}.oversized`,
  };
}

/**
 * Where this platform exposes open descriptors as path components, or
 * `undefined` when it exposes none and path-based I/O is the only option.
 */
export function descriptorDirectoryRoot(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "linux") return "/proc/self/fd";
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") return "/dev/fd";
  return undefined;
}

export type PinnedSnapshotDirectory =
  | {
      kind: "pinned";
      /** The same file set, addressed through the held directory descriptor. */
      paths: SnapshotPaths;
      close(): Promise<void>;
    }
  /** No descriptor directory to anchor against; the caller keeps real paths. */
  | { kind: "unsupported" }
  /** The directory is a symlink or changed identity: refuse, never guess. */
  | { kind: "unstable" };

/**
 * Open the snapshot directory and return the same paths addressed through that
 * descriptor.
 *
 * `unstable` and `unsupported` are deliberately distinct: the first is an
 * attack or a race and must stop the flush, the second is a platform without a
 * descriptor directory and leaves the pre-existing path-based behavior.
 */
export async function pinSnapshotDirectory(
  paths: SnapshotPaths,
  options: { descriptorRoot?: string | undefined } = {}
): Promise<PinnedSnapshotDirectory> {
  const descriptorRoot = options.descriptorRoot ?? descriptorDirectoryRoot();
  if (descriptorRoot === undefined) return { kind: "unsupported" };
  const directory = path.dirname(paths.plan);

  let before: Stats;
  try {
    before = await lstat(directory);
  } catch {
    return { kind: "unstable" };
  }
  if (before.isSymbolicLink() || !before.isDirectory()) return { kind: "unstable" };

  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    // ELOOP means a symlink was swapped in between the lstat and the open;
    // ENOENT and ENOTDIR mean the directory went away under us. All refuse.
    return { kind: "unstable" };
  }
  try {
    // The handle now pins an inode. Confirm it is the inode the walk checked:
    // a swap already in place fails the lstat compare, and one reverted after
    // the open fails the descriptor compare below.
    const opened = await handle.stat();
    const after = await lstat(directory);
    if (
      !opened.isDirectory() ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !isSameInode(before, opened) ||
      !isSameInode(after, opened)
    ) {
      await closeQuietly(handle);
      return { kind: "unstable" };
    }

    // Prove the descriptor directory actually resolves to the pinned inode
    // before trusting it for writes: a host without procfs mounted must fall
    // back to path-based I/O rather than write to a path that means nothing.
    const pinnedDirectory = path.join(descriptorRoot, String(handle.fd));
    let anchored: Stats;
    try {
      anchored = await stat(pinnedDirectory);
    } catch {
      await closeQuietly(handle);
      return { kind: "unsupported" };
    }
    if (!anchored.isDirectory() || !isSameInode(anchored, opened)) {
      await closeQuietly(handle);
      return { kind: "unsupported" };
    }

    return {
      kind: "pinned",
      paths: {
        ...paths,
        plan: anchoredChild(pinnedDirectory, paths.plan),
        inflight: anchoredChild(pinnedDirectory, paths.inflight),
        rotating: anchoredChild(pinnedDirectory, paths.rotating),
        oversized: anchoredChild(pinnedDirectory, paths.oversized),
      },
      close: () => closeQuietly(handle),
    };
  } catch (err) {
    await closeQuietly(handle);
    throw err;
  }
}

function anchoredChild(pinnedDirectory: string, realPath: string): string {
  return path.join(pinnedDirectory, path.basename(realPath));
}

function isSameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}
