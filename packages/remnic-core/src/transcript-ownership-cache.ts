import { stat } from "node:fs/promises";
import { resolveSafeStoragePath } from "./storage-paths.js";

export type DirectoryOwnershipCacheEntry = {
  status: "empty" | "matches";
  fileSizes: Map<string, number>;
};

export async function refreshTranscriptDirectoryOwnershipCache(
  cache: Map<string, DirectoryOwnershipCacheEntry>,
  cacheKey: string,
  root: string,
  dir: string,
  file: string,
): Promise<void> {
  const cached = cache.get(cacheKey);
  if (!cached) return;

  try {
    const filePath = await resolveSafeStoragePath(root, dir, file);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) {
      cache.delete(cacheKey);
      return;
    }
    const fileSizes = new Map(cached.fileSizes);
    fileSizes.set(file, Math.max(0, fileInfo.size));
    cache.set(cacheKey, { status: "matches", fileSizes });
  } catch {
    cache.delete(cacheKey);
  }
}
