import type { MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

interface ArchivePathIndex {
  version: string;
  pathsByBasename: Map<string, string[]>;
}

export class GraphPathStateLoader {
  private archivePathIndexes?: Map<string, ArchivePathIndex>;

  async readNode(
    storage: StorageManager,
    nodeId: string,
    deadlineAtMs: number | null | undefined,
    allowArchiveLookup: boolean,
  ): Promise<MemoryFile | null> {
    if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
    const storageRoot = await realpath(storage.dir).catch(() => path.resolve(storage.dir));
    if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
    const directRelativePaths = [nodeId, path.join("cold", nodeId)];
    for (const relativePath of directRelativePaths) {
      const safePath = await this.resolveContainedPath(storageRoot, relativePath);
      if (!safePath) continue;
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const memory = await storage.readMemoryByPath(safePath);
      if (memory) return memory;
    }
    if (!allowArchiveLookup || (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs)) {
      return null;
    }
    const archiveIndex = await this.getArchivePathIndex(storage, storageRoot, deadlineAtMs);
    if (!archiveIndex || (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs)) {
      return null;
    }
    const archivePaths = archiveIndex.pathsByBasename.get(path.basename(nodeId)) ?? [];
    const logicalId = path.basename(nodeId, path.extname(nodeId));
    let newestFallback: MemoryFile | null = null;
    for (const archivePath of archivePaths) {
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const memory = await storage.readMemoryByPath(archivePath);
      if (!memory) continue;
      newestFallback ??= memory;
      if (memory.frontmatter.id === logicalId) return memory;
    }
    return newestFallback;
  }

  private async resolveContainedPath(
    storageRoot: string,
    relativePath: string,
  ): Promise<string | null> {
    if (path.isAbsolute(relativePath)) return null;
    const rawSegments = relativePath.replace(/\\/g, "/").split("/");
    if (rawSegments.includes("..")) return null;
    const candidate = path.resolve(storageRoot, relativePath);
    const lexicalRelative = path.relative(storageRoot, candidate);
    if (
      lexicalRelative.length > 0 &&
      (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative))
    ) {
      return null;
    }
    const canonical = await realpath(candidate).catch(() => candidate);
    const canonicalRelative = path.relative(storageRoot, canonical);
    if (
      canonicalRelative.length > 0 &&
      (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative))
    ) {
      return null;
    }
    return canonical;
  }

  private async getArchivePathIndex(
    storage: StorageManager,
    storageRoot: string,
    deadlineAtMs: number | null | undefined,
  ): Promise<ArchivePathIndex | null> {
    if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
    const version = await storage.getCorpusScanVersion();
    if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
    const archivePathIndexes = this.archivePathIndexes ??= new Map();
    const cacheKey = `${storageRoot}\0${version}`;
    const cached = archivePathIndexes.get(cacheKey);
    if (cached) return cached;
    const index = await this.buildArchivePathIndex(storageRoot, version, deadlineAtMs);
    if (!index || (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs)) {
      return null;
    }
    const rootPrefix = `${storageRoot}\0`;
    for (const key of archivePathIndexes.keys()) {
      if (key.startsWith(rootPrefix)) archivePathIndexes.delete(key);
    }
    archivePathIndexes.set(cacheKey, index);
    return index;
  }

  private async buildArchivePathIndex(
    storageRoot: string,
    version: string,
    deadlineAtMs: number | null | undefined,
  ): Promise<ArchivePathIndex | null> {
    const pathsByBasename = new Map<string, string[]>();
    const pending = [path.join(storageRoot, "archive")];
    while (pending.length > 0) {
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const current = pending.pop();
      if (!current) break;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const canonical = await realpath(entryPath).catch(() => null);
        if (!canonical) continue;
        const relative = path.relative(storageRoot, canonical);
        if (
          relative.length > 0 &&
          (relative.startsWith("..") || path.isAbsolute(relative))
        ) {
          continue;
        }
        const paths = pathsByBasename.get(entry.name);
        if (paths) paths.push(canonical);
        else pathsByBasename.set(entry.name, [canonical]);
      }
    }
    for (const paths of pathsByBasename.values()) {
      paths.sort((left, right) => right.localeCompare(left));
    }
    return { version, pathsByBasename };
  }
}
