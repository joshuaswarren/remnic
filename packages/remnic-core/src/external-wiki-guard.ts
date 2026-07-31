import { realpath } from "node:fs/promises";
import path from "node:path";

export const EXTERNAL_WIKI_COLLECTION_PREFIX = "external-wiki-";

export function isExternalWikiCollectionName(collection: string): boolean {
  return collection.startsWith(EXTERNAL_WIKI_COLLECTION_PREFIX);
}

export function assertExternalWikiRootOutsideMemoryDir(memoryDir: string, rootDir: string): void {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const relativeRoot = path.relative(resolvedMemoryDir, path.resolve(rootDir));
  const isInsideMemoryDir =
    relativeRoot === "" ||
    (!path.isAbsolute(relativeRoot) && relativeRoot !== ".." && !relativeRoot.startsWith(`..${path.sep}`));
  if (isInsideMemoryDir) {
    throw new Error(`external wiki rootDir must be outside memoryDir: ${rootDir}`);
  }
}

async function canonicalPathIfPresent(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  try {
    return await realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

export async function assertExternalWikiRootOutsideMemoryDirCanonical(
  memoryDir: string,
  rootDir: string
): Promise<void> {
  const [canonicalMemoryDir, canonicalRootDir] = await Promise.all([
    canonicalPathIfPresent(memoryDir),
    canonicalPathIfPresent(rootDir),
  ]);
  assertExternalWikiRootOutsideMemoryDir(canonicalMemoryDir, canonicalRootDir);
}
