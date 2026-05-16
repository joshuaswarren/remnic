import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await readFile(filePath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sha256, bytes: buf.byteLength };
}

export function sha256String(content: string): { sha256: string; bytes: number } {
  const buf = Buffer.from(content, "utf-8");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sha256, bytes: buf.byteLength };
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(fp);
      } else if (ent.isFile()) {
        out.push(fp);
      }
    }
  }
  await walk(rootDir);
  return out.sort();
}

export async function ensureDirExists(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function toPosixRelPath(absPath: string, rootDir: string): string {
  const rel = path.relative(rootDir, absPath);
  // normalize to posix for portability across platforms
  return rel.split(path.sep).join("/");
}

export function fromPosixRelPath(relPath: string): string {
  return relPath.split("/").join(path.sep);
}

export interface SafeArchiveRoot {
  abs: string;
  real: string;
  errorPrefix: string;
  argName: string;
}

export async function prepareSafeArchiveRoot(
  absPath: string,
  errorPrefix: string,
  argName: string,
): Promise<SafeArchiveRoot> {
  const rootAbs = path.resolve(absPath);
  await assertIsDirectoryNotSymlink(rootAbs, errorPrefix, argName);
  return {
    abs: rootAbs,
    real: await realpath(rootAbs),
    errorPrefix,
    argName,
  };
}

export function validateArchiveRelativePath(
  relPath: string,
  errorPrefix: string,
): string {
  if (relPath.length === 0) {
    throw new Error(`${errorPrefix}: record path must not be empty`);
  }
  if (relPath.includes("\\")) {
    throw new Error(
      `${errorPrefix}: record path must use POSIX separators: ${relPath}`,
    );
  }
  if (path.posix.isAbsolute(relPath)) {
    throw new Error(
      `${errorPrefix}: record path must be relative: ${relPath}`,
    );
  }

  const segments = relPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `${errorPrefix}: record path contains unsafe segments: ${relPath}`,
    );
  }

  const normalized = path.posix.normalize(relPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(
      `${errorPrefix}: record path escapes target root: ${relPath}`,
    );
  }

  return normalized;
}

export async function resolveSafeArchiveTarget(
  root: SafeArchiveRoot,
  relPath: string,
): Promise<string> {
  const safeRelPath = validateArchiveRelativePath(relPath, root.errorPrefix);
  const targetAbs = path.resolve(root.abs, fromPosixRelPath(safeRelPath));
  if (!isPathInsideRoot(root.abs, targetAbs)) {
    throw new Error(
      `${root.errorPrefix}: record path escapes target root: ${relPath}`,
    );
  }

  const targetStat = await lstat(targetAbs).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (targetStat?.isSymbolicLink()) {
    throw new Error(
      `${root.errorPrefix}: record path targets a symlink: ${relPath}`,
    );
  }

  await assertRealpathInsideRoot(
    root.real,
    targetAbs,
    relPath,
    root.errorPrefix,
  );
  return targetAbs;
}

// ---------------------------------------------------------------------------
// Shared path-safety helpers (used by capsule-import, capsule-merge, and
// capsule-fork).
//
// These helpers are security-critical (path-traversal and symlink-bypass
// guards), so any future fix must apply uniformly. The `errorPrefix` and
// `argName` arguments let each caller surface module-specific error messages
// ("importCapsule:" vs "mergeCapsule:" vs "forkCapsule:") without forking the
// implementation.
// ---------------------------------------------------------------------------

/**
 * Return true when {@link absPath} is the same as {@link rootReal} or a
 * descendant. {@link rootReal} should be the value returned by
 * `realpath(rootAbs)` so that symlinked subdirectories are detected.
 */
export function isPathInsideRoot(rootReal: string, absPath: string): boolean {
  const rel = path.relative(rootReal, absPath);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Assert that {@link absPath} is an existing directory and is not itself a
 * symlink. `existsSync` returns true for files (gotcha #24); a stat-based
 * check is required. Symlinked roots are rejected up-front so an attacker
 * cannot hand the importer a `~/import-target` link → `/etc` and have writes
 * silently follow the link (Codex P1 round 5 thread on PR #741).
 */
export async function assertIsDirectoryNotSymlink(
  absPath: string,
  errorPrefix: string,
  argName: string,
): Promise<void> {
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(
      `${errorPrefix}: '${argName}' must be an existing directory: ${absPath}`,
    );
  }
  const lst = await lstat(absPath).catch(() => null);
  if (lst && lst.isSymbolicLink()) {
    throw new Error(
      `${errorPrefix}: '${argName}' must not be a symlink — resolve it to its real path first: ${absPath}`,
    );
  }
}

/**
 * Walk upward from {@link targetAbs} to find the nearest existing ancestor,
 * resolve it via `fs.realpath` (which follows symlinks), then re-append the
 * remaining suffix and verify the result is inside {@link rootReal}.
 *
 * This catches the case where an existing subdirectory at any point in the
 * path is a symlink that points outside the intended root. Because the file
 * does not exist yet we cannot realpath it directly; we resolve the deepest
 * existing prefix and re-apply the non-existent suffix. Callers must ensure
 * {@link rootReal} was already resolved via `realpath`.
 */
export async function assertRealpathInsideRoot(
  rootReal: string,
  targetAbs: string,
  sourcePath: string,
  errorPrefix: string,
): Promise<void> {
  let existing = targetAbs;
  const suffix: string[] = [];
  while (existing !== path.dirname(existing)) {
    const st = await lstat(existing).catch(() => null);
    if (st !== null) break;
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const existingReal = await realpath(existing).catch(() => existing);
  const targetReal =
    suffix.length > 0 ? path.join(existingReal, ...suffix) : existingReal;
  if (!isPathInsideRoot(rootReal, targetReal)) {
    throw new Error(
      `${errorPrefix}: record path escapes target root via symlink: ${sourcePath}`,
    );
  }
}
