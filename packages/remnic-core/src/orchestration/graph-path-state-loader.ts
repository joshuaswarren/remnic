import type { Dir, Dirent, Stats } from "node:fs";
import type { MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { isErrnoCode } from "../utils/errno.js";

interface ArchivePathIndex {
  version: number;
  pathsByBasename: Map<string, string[]>;
}
interface ArchivePathIndexUnavailable {
  version: number;
  unavailable: "oversized";
}
type ArchivePathIndexResult = ArchivePathIndex | ArchivePathIndexUnavailable;

function isArchivePathIndexUnavailable(index: ArchivePathIndexResult): index is ArchivePathIndexUnavailable {
  return "unavailable" in index;
}

const MAX_ARCHIVE_PATH_INDEXES = 32;
const MAX_ARCHIVE_PATH_INDEX_BUILDS = 32;
const MAX_ARCHIVE_PATH_INDEX_GENERATION_RETRIES = 1;
const MAX_ARCHIVE_INDEX_ENTRIES = 100_000;

function isArchiveScanAbsenceError(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR");
}

export class GraphPathStateLoader {
  private archivePathIndexes?: Map<string, ArchivePathIndexResult>;
  private archivePathIndexBuilds = new Map<string, Promise<ArchivePathIndexResult | null>>();
  private archiveLstat: (filePath: string) => Promise<Stats> = lstat;
  private archiveRealpath: (filePath: string) => Promise<string> = realpath;
  private openArchiveDirectory: (directoryPath: string) => Promise<Dir> = opendir;
  async readNode(
    storage: StorageManager,
    nodeId: string,
    deadlineAtMs: number | null | undefined,
    allowArchiveLookup: boolean,
  ): Promise<MemoryFile | null> {
    if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
    const configuredStorageRoot = path.resolve(storage.dir);
    const storageRoot = await realpath(configuredStorageRoot).catch(() => null);
    if (!storageRoot || storageRoot !== configuredStorageRoot) return null;
    const logicalId = path.basename(nodeId, path.extname(nodeId));
    const directRelativePaths = [nodeId, path.join("cold", nodeId)];
    let inactiveDirectMemory: MemoryFile | null = null;
    for (const relativePath of directRelativePaths) {
      const safePath = await this.resolveContainedPath(storageRoot, relativePath);
      if (!safePath) continue;
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const memory = await storage.readMemoryByPath(safePath);
      if (!memory || memory.frontmatter.id !== logicalId) continue;
      if (memory.frontmatter.status === undefined || memory.frontmatter.status === "active") return memory;
      inactiveDirectMemory ??= memory;
    }
    if (inactiveDirectMemory) return inactiveDirectMemory;
    if (!allowArchiveLookup || (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs)) {
      return null;
    }
    const archiveIndex = await this.getArchivePathIndex(storage, storageRoot, deadlineAtMs);
    if (
      !archiveIndex ||
      isArchivePathIndexUnavailable(archiveIndex) ||
      (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs)
    ) {
      return null;
    }
    const archivePaths = archiveIndex.pathsByBasename.get(path.basename(nodeId)) ?? [];
    for (const archivePath of archivePaths) {
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const memory = await storage.readMemoryByPath(archivePath);
      if (!memory) continue;
      if (memory.frontmatter.id === logicalId) return memory;
    }
    return null;
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
  ): Promise<ArchivePathIndexResult | null> {
    if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
    if (!this.archivePathIndexes) this.archivePathIndexes = new Map();
    const archivePathIndexes = this.archivePathIndexes;
    let generationRetries = 0;

    while (true) {
      const version = storage.getArchiveMutationVersion();
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const cacheKey = `${storageRoot}\0${version}`;
      const cached = archivePathIndexes.get(cacheKey);
      if (cached) {
        archivePathIndexes.delete(cacheKey);
        archivePathIndexes.set(cacheKey, cached);
        return cached;
      }

      let build = this.archivePathIndexBuilds.get(cacheKey);
      if (!build) {
        if (this.archivePathIndexBuilds.size >= MAX_ARCHIVE_PATH_INDEX_BUILDS) {
          const trackedBuilds = [...this.archivePathIndexBuilds.values()].map((pending) =>
            pending.then(() => undefined, () => undefined)
          );
          const admitted = await this.waitForDeadline(Promise.race(trackedBuilds), deadlineAtMs);
          if (admitted === null) return null;
          continue;
        }
        build = this.buildArchivePathIndex(storageRoot, version)
          .then((index) => {
            if (!index) return null;
            if (storage.getArchiveMutationVersion() !== version) return null;
            const rootPrefix = `${storageRoot}\0`;
            for (const key of archivePathIndexes.keys()) {
              if (key.startsWith(rootPrefix)) archivePathIndexes.delete(key);
            }
            archivePathIndexes.set(cacheKey, index);
            while (archivePathIndexes.size > MAX_ARCHIVE_PATH_INDEXES) {
              const oldestKey = archivePathIndexes.keys().next().value;
              if (oldestKey === undefined) break;
              archivePathIndexes.delete(oldestKey);
            }
            return index;
          })
          .finally(() => {
            this.archivePathIndexBuilds.delete(cacheKey);
          });
        this.archivePathIndexBuilds.set(cacheKey, build);
      }
      const index = await this.waitForDeadline(build, deadlineAtMs);
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      const currentVersion = storage.getArchiveMutationVersion();
      if (index && currentVersion === version) return index;
      if (index && currentVersion !== version) archivePathIndexes.delete(cacheKey);
      if (currentVersion === version) return null;
      if (generationRetries >= MAX_ARCHIVE_PATH_INDEX_GENERATION_RETRIES) return null;
      generationRetries += 1;
    }
  }

  private async waitForDeadline<T>(
    promise: Promise<T>,
    deadlineAtMs: number | null | undefined,
  ): Promise<T | null> {
    if (typeof deadlineAtMs !== "number") return promise;
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) return null;
    const timeout = Promise.withResolvers<null>();
    const timer = setTimeout(() => timeout.resolve(null), remainingMs);
    try {
      return await Promise.race([promise, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async buildArchivePathIndex(
    storageRoot: string,
    version: number,
  ): Promise<ArchivePathIndexResult | null> {
    const pathsByBasename = new Map<string, string[]>();
    const archiveRoot = path.join(storageRoot, "archive");
    let archiveRootStatus: Stats;
    try {
      archiveRootStatus = await this.archiveLstat(archiveRoot);
    } catch (error) {
      if (isArchiveScanAbsenceError(error)) return { version, pathsByBasename };
      return null;
    }
    if (
      !archiveRootStatus ||
      !archiveRootStatus.isDirectory() ||
      archiveRootStatus.isSymbolicLink()
    ) {
      return { version, pathsByBasename };
    }
    let canonicalArchiveRoot: string;
    try {
      canonicalArchiveRoot = await this.archiveRealpath(archiveRoot);
    } catch (error) {
      if (isArchiveScanAbsenceError(error)) return { version, pathsByBasename };
      return null;
    }
    const archiveRelative = path.relative(storageRoot, canonicalArchiveRoot);
    if (
      archiveRelative.length > 0 &&
      (archiveRelative.startsWith("..") || path.isAbsolute(archiveRelative))
    ) {
      return { version, pathsByBasename };
    }
    const pending = [canonicalArchiveRoot];
    let indexedPathCount = 0;
    let visitedEntryCount = 1;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      let currentStatus: Stats;
      try {
        currentStatus = await this.archiveLstat(current);
      } catch (error) {
        if (isArchiveScanAbsenceError(error)) continue;
        return null;
      }
      if (
        !currentStatus ||
        !currentStatus.isDirectory() ||
        currentStatus.isSymbolicLink()
      ) {
        continue;
      }
      let canonicalCurrent: string;
      try {
        canonicalCurrent = await this.archiveRealpath(current);
      } catch (error) {
        if (isArchiveScanAbsenceError(error)) continue;
        return null;
      }
      const currentRelative = path.relative(storageRoot, canonicalCurrent);
      if (
        currentRelative.length > 0 &&
        (currentRelative.startsWith("..") || path.isAbsolute(currentRelative))
      ) {
        continue;
      }
      let directory: Dir;
      try {
        directory = await this.openArchiveDirectory(canonicalCurrent);
      } catch (error) {
        if (isArchiveScanAbsenceError(error)) continue;
        return null;
      }
      try {
        for await (const entry of directory) {
          visitedEntryCount += 1;
          if (visitedEntryCount > MAX_ARCHIVE_INDEX_ENTRIES) {
            return { version, unavailable: "oversized" };
          }
          if (entry.isSymbolicLink()) continue;
          const entryPath = path.join(canonicalCurrent, entry.name);
          if (entry.isDirectory()) {
            pending.push(entryPath);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          if (indexedPathCount >= MAX_ARCHIVE_INDEX_ENTRIES) {
            return { version, unavailable: "oversized" };
          }
          let canonical: string;
          try {
            canonical = await this.archiveRealpath(entryPath);
          } catch (error) {
            if (isArchiveScanAbsenceError(error)) continue;
            return null;
          }
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
          indexedPathCount += 1;
        }
      } catch {
        return null;
      }
    }
    for (const paths of pathsByBasename.values()) {
      paths.sort((left, right) => {
        const normalizedLeft = left.normalize("NFC");
        const normalizedRight = right.normalize("NFC");
        return normalizedRight < normalizedLeft
          ? -1
          : normalizedRight > normalizedLeft
            ? 1
            : 0;
      });
    }
    return { version, pathsByBasename };
  }
}
