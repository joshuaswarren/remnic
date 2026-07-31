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
