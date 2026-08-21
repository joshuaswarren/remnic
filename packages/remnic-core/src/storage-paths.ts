import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export function encodeStoragePathSegment(value: string, fallback = "unknown"): string {
  const raw = value.length > 0 ? value : fallback;
  try {
    return encodeURIComponent(raw).replaceAll(".", "%2E");
  } catch {
    return `encoded-${storagePathHash(raw)}`;
  }
}

export function storagePathHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function encodeStoragePathSegmentWithHash(value: string, fallback = "unknown"): string {
  const raw = value.length > 0 ? value : fallback;
  return `${encodeStoragePathSegment(value, fallback)}--${storagePathHash(raw)}`;
}

export function isSafeLegacyPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function isPathInsideStorageRoot(rootAbs: string, targetAbs: string): boolean {
  const rel = path.relative(rootAbs, targetAbs);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export function resolvePathInsideStorageRoot(
  root: string,
  ...parts: string[]
): string {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, ...parts);
  if (!isPathInsideStorageRoot(rootAbs, targetAbs)) {
    throw new Error(`resolved storage path escapes root: ${targetAbs}`);
  }
  return targetAbs;
}

async function assertNoSymlinkInExistingPath(
  rootAbs: string,
  targetAbs: string,
): Promise<void> {
  let current = rootAbs;
  while (current !== path.dirname(current)) {
    const stat = await lstat(current).catch(() => null);
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new Error(`storage path must not pass through a symlink: ${current}`);
      }
      break;
    }
    current = path.dirname(current);
  }

  const relative = path.relative(rootAbs, targetAbs);
  if (relative === "") return;

  current = rootAbs;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch(() => null);
    if (stat === null) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`storage path must not pass through a symlink: ${current}`);
    }
  }
}

async function assertRealPathInsideStorageRoot(
  rootAbs: string,
  targetAbs: string,
): Promise<void> {
  const rootReal = await resolvePossiblyMissingRealPath(rootAbs);
  const targetReal = await resolvePossiblyMissingRealPath(targetAbs);
  if (!isPathInsideStorageRoot(rootReal, targetReal)) {
    throw new Error(`resolved storage path escapes root: ${targetAbs}`);
  }
}

async function resolvePossiblyMissingRealPath(absPath: string): Promise<string> {
  let existing = absPath;
  const suffix: string[] = [];
  while (existing !== path.dirname(existing)) {
    const stat = await lstat(existing).catch(() => null);
    if (stat !== null) break;
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const existingReal = await realpath(existing).catch(() => existing);
  return suffix.length > 0 ? path.join(existingReal, ...suffix) : existingReal;
}

export async function resolveSafeStoragePath(
  root: string,
  ...parts: string[]
): Promise<string> {
  const rootAbs = path.resolve(root);
  const targetAbs = resolvePathInsideStorageRoot(rootAbs, ...parts);
  await assertNoSymlinkInExistingPath(rootAbs, targetAbs);
  await assertRealPathInsideStorageRoot(rootAbs, targetAbs);
  return targetAbs;
}
