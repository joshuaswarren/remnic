import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const ARCHIVE_MUTATION_VERSION_SENTINEL = ".archive-mutation-version.log";
const fallbackVersionByDir = new Map<string, number>();

export function getArchiveMutationVersionForDir(memoryDir: string): number {
  try {
    return statSync(path.join(memoryDir, "state", ARCHIVE_MUTATION_VERSION_SENTINEL)).size;
  } catch {
    return fallbackVersionByDir.get(memoryDir) ?? 0;
  }
}

export function bumpArchiveMutationVersionForDir(memoryDir: string): void {
  const filePath = path.join(memoryDir, "state", ARCHIVE_MUTATION_VERSION_SENTINEL);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, "x");
    fallbackVersionByDir.set(memoryDir, statSync(filePath).size);
  } catch {
    fallbackVersionByDir.set(memoryDir, (fallbackVersionByDir.get(memoryDir) ?? 0) + 1);
  }
}

export function bumpArchiveMutationIfChanged(memoryDir: string, changed: boolean): void {
  if (changed) bumpArchiveMutationVersionForDir(memoryDir);
}
export function bumpArchiveMutationForPath(memoryDir: string, changed: boolean, filePath: string): void {
  if (!changed) return;
  const relative = path.relative(memoryDir, filePath);
  if (relative === "archive" || relative.startsWith(`archive${path.sep}`)) {
    bumpArchiveMutationVersionForDir(memoryDir);
  }
}
export async function recordArchiveMutation<T>(
  memoryDir: string,
  filePath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const result = await mutation();
  if (result !== false) bumpArchiveMutationForPath(memoryDir, true, filePath);
  return result;
}
export function recordArchiveDelete(
  memoryDir: string,
  filePath: string,
  remove: () => Promise<boolean>,
): Promise<boolean> {
  return recordArchiveMutation(memoryDir, filePath, remove);
}

export async function recordArchiveWrite(
  memoryDir: string,
  filePath: string,
  write: () => Promise<void>,
): Promise<void> {
  await recordArchiveMutation(memoryDir, filePath, write);
}
