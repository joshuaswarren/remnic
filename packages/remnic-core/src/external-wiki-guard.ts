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

async function canonicalPath(candidate: string): Promise<string> {
  let existing = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export async function assertExternalWikiRootOutsideMemoryDirCanonical(
  memoryDir: string,
  rootDir: string
): Promise<void> {
  const [canonicalMemoryDir, canonicalRootDir] = await Promise.all([canonicalPath(memoryDir), canonicalPath(rootDir)]);
  assertExternalWikiRootOutsideMemoryDir(canonicalMemoryDir, canonicalRootDir);
}
