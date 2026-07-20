/**
 * QMD result resolver — extracted from the orchestrator (issue #1526 seam 11).
 *
 * Owns the subsystem that resolves a QMD search-result path back to the
 * concrete `MemoryFile` (and its owning namespace/storage). Three concerns
 * live here:
 *
 *   - `readQmdResultMemory` — resolve a result path to a `MemoryFile`,
 *     handling cold-tier collections, namespace-prefixed collections, and
 *     absolute vs relative paths.
 *   - `resolveColdQmdResultForRecall` — wrap a result with its owner
 *     namespace so the recall pipeline can scope-filter candidates.
 *   - `storageForAbsoluteQmdResultPath` — find the `StorageManager` whose
 *     directory tree contains an absolute result path.
 *
 * Behavior-preserving move from orchestrator.ts — no logic changes. The
 * orchestrator constructs one instance and keeps thin delegating methods so
 * existing call sites (recallInternal, applyColdFallbackPipeline,
 * loadSearchResultMemoryMap, suggestLinksForMemory, and the
 * RecallRerankCoordinator callback) continue to work.
 *
 * Config, the storage router, and the orchestrator's namespace-resolution
 * helpers are accessed through getter callbacks (not captured at
 * construction) so that post-construction reassignment of the
 * orchestrator's live fields is honored. This mirrors the
 * RecallRerankCoordinator / ConversationIndexCoordinator accessor pattern.
 */

import path from "node:path";
import { log } from "../logger.js";
import { isPathInsideStorageRoot } from "../storage-paths.js";
import { namespaceIdentityFromToken } from "../namespaces/identity.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { SecureStoreLockedError } from "../secure-store/index.js";
import type { PluginConfig, QmdSearchResult, MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";

/**
 * Split a relative QMD result path into its collection prefix and the
 * remainder. Returns `null` for absolute paths, date-only prefixes, or
 * paths with no collection separator.
 */
export function qmdCollectionPathParts(resultPath: string): {
  collection: string;
  relativePath: string;
} | null {
  if (!resultPath || path.isAbsolute(resultPath)) return null;
  const normalized = resultPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return null;
  const collection = normalized.slice(0, slashIndex);
  if (/^\d{4}-\d{2}-\d{2}$/.test(collection)) return null;
  return {
    collection,
    relativePath: normalized.slice(slashIndex + 1),
  };
}

/**
 * Build the set of on-disk candidate paths to probe for a QMD result,
 * constrained to the storage root so a result path can never escape the
 * namespace directory.
 */
export function qmdResultPathCandidates(
  storageDir: string,
  resultPath: string,
): string[] {
  const candidates = new Set<string>();
  const storageRoot = path.resolve(storageDir);
  const addCandidate = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (isPathInsideStorageRoot(storageRoot, resolved)) {
      candidates.add(resolved);
    }
  };
  const addRelativeCandidates = (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) return;
    addCandidate(path.join(storageRoot, normalized));
    if (/^\d{4}-\d{2}-\d{2}\//.test(normalized)) {
      addCandidate(path.join(storageRoot, "facts", normalized));
    }
  };

  if (path.isAbsolute(resultPath)) {
    addCandidate(resultPath);
  } else {
    addRelativeCandidates(resultPath);
  }

  return [...candidates];
}

/**
 * Extract a non-empty `dir` from a storage, returning `null` when the
 * property is absent or not a non-empty string at runtime. Proxy-backed
 * fake storages used in recall paths may not provide a real `dir`, so
 * every caller must handle the null case (skip or fall back to a direct
 * `readMemoryByPath`).
 */
function storageDirOrNull(storage: StorageManager): string | null {
  const dir = storage.dir;
  return typeof dir === "string" && dir.length > 0 ? dir : null;
}

/**
 * Coordinator for resolving QMD search-result paths to concrete memory
 * files and their owning namespace/storage.
 */
export class QmdResultResolver {
  private readonly getConfig: () => PluginConfig;
  private readonly storageFor: (namespace: string) => Promise<StorageManager>;
  private readonly storageDirNamespace: (storageDir: string) => string;
  private readonly qmdCollectionNamespaceFromPrefix: (
    collectionPrefix: string,
  ) => string | null;
  private readonly namespaceFromPath: (p: string) => string;

  constructor(options: {
    getConfig: () => PluginConfig;
    storageFor: (namespace: string) => Promise<StorageManager>;
    storageDirNamespace: (storageDir: string) => string;
    qmdCollectionNamespaceFromPrefix: (
      collectionPrefix: string,
    ) => string | null;
    namespaceFromPath: (p: string) => string;
  }) {
    this.getConfig = options.getConfig;
    this.storageFor = options.storageFor;
    this.storageDirNamespace = options.storageDirNamespace;
    this.qmdCollectionNamespaceFromPrefix =
      options.qmdCollectionNamespaceFromPrefix;
    this.namespaceFromPath = options.namespaceFromPath;
  }

  async readQmdResultMemory(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
    preferredNamespace?: string,
  ): Promise<MemoryFile | null> {
    const parts = qmdCollectionPathParts(resultPath);
    const fallbackStorageDir = storageDirOrNull(fallbackStorage);
    const config = this.getConfig();
    const coldCollection = config.qmdColdCollection ?? "openclaw-engram-cold";
    if (parts && parts.collection === coldCollection) {
      const storages: StorageManager[] = [];
      const seenStorageDirs = new Set<string>();
      const addStorage = (storage: StorageManager): void => {
        const storageDir = storageDirOrNull(storage);
        const storageKey = storageDir
          ? path.resolve(storageDir)
          : `storage-without-dir-${storages.length}`;
        if (seenStorageDirs.has(storageKey)) return;
        seenStorageDirs.add(storageKey);
        storages.push(storage);
      };

      const fallbackNamespace =
        fallbackStorageDir !== null
          ? this.storageDirNamespace(fallbackStorageDir)
          : config.defaultNamespace;
      if (
        recallNamespaces.length === 0 ||
        !resolveNamespaceCapabilities(config).namespaces ||
        recallNamespaces.includes(fallbackNamespace)
      ) {
        addStorage(fallbackStorage);
      }

      if (recallNamespaces.length > 0) {
        for (const namespace of recallNamespaces) {
          try {
            addStorage(await this.storageFor(namespace));
          } catch (err) {
            log.debug("qmd cold result namespace storage lookup skipped", {
              path: resultPath,
              namespace,
              error: (err as Error).message,
            });
          }
        }
      }

      for (const storage of storages) {
        const storageDir = storageDirOrNull(storage);
        if (!storageDir) {
          const memory = await storage.readMemoryByPath(resultPath);
          if (memory) return memory;
          continue;
        }
        try {
          const coldRoot = path.join(storageDir, "cold");
          for (const candidate of qmdResultPathCandidates(
            coldRoot,
            parts.relativePath,
          )) {
            const memory = await storage.readMemoryByPath(candidate);
            if (memory) return memory;
          }
        } catch (err) {
          if (err instanceof SecureStoreLockedError) throw err;
          log.debug("qmd cold result path lookup failed open", {
            path: resultPath,
            collection: coldCollection,
            error: (err as Error).message,
          });
        }
      }
      return null;
    }
    const collectionNamespace = parts
      ? this.qmdCollectionNamespaceFromPrefix(parts.collection)
      : null;

    if (parts && collectionNamespace) {
      try {
        const collectionStorage = await this.storageFor(collectionNamespace);
        for (const candidate of qmdResultPathCandidates(
          collectionStorage.dir,
          parts.relativePath,
        )) {
          const memory = await collectionStorage.readMemoryByPath(candidate);
          if (memory) return memory;
        }
        return null;
      } catch (err) {
        if (err instanceof SecureStoreLockedError) throw err;
        log.debug("qmd result namespace path lookup failed open", {
          path: resultPath,
          namespace: collectionNamespace,
          error: (err as Error).message,
        });
        return null;
      }
    }

    if (preferredNamespace) {
      try {
        const preferredStorage = await this.storageFor(preferredNamespace);
        for (const candidate of qmdResultPathCandidates(
          preferredStorage.dir,
          resultPath,
        )) {
          const memory = await preferredStorage.readMemoryByPath(candidate);
          if (memory) return memory;
        }
      } catch (err) {
        if (err instanceof SecureStoreLockedError) throw err;
        log.debug("qmd preferred namespace path lookup failed open", {
          path: resultPath,
          namespace: preferredNamespace,
          error: (err as Error).message,
        });
      }
    }
    if (path.isAbsolute(resultPath)) {
      if (!fallbackStorageDir) {
        return await fallbackStorage.readMemoryByPath(resultPath);
      }
      const ownerStorage = await this.storageForAbsoluteQmdResultPath(
        resultPath,
        fallbackStorage,
        recallNamespaces,
      );
      if (!ownerStorage) return null;
      for (const candidate of qmdResultPathCandidates(
        ownerStorage.dir,
        resultPath,
      )) {
        const memory = await ownerStorage.storage.readMemoryByPath(candidate);
        if (memory) return memory;
      }
      return null;
    }

    if (!fallbackStorageDir) {
      return await fallbackStorage.readMemoryByPath(resultPath);
    }
    for (const candidate of qmdResultPathCandidates(
      fallbackStorageDir,
      resultPath,
    )) {
      const memory = await fallbackStorage.readMemoryByPath(candidate);
      if (memory) return memory;
    }
    return null;
  }

  async resolveColdQmdResultForRecall(
    result: QmdSearchResult,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
  ): Promise<{ namespace: string; result: QmdSearchResult } | null> {
    const memory = await this.readQmdResultMemory(
      result.path,
      fallbackStorage,
      recallNamespaces,
      result.namespace,
    );
    if (!memory) return null;

    let ownerNamespace: string | null = null;
    if (path.isAbsolute(memory.path)) {
      const ownerStorage = await this.storageForAbsoluteQmdResultPath(
        memory.path,
        fallbackStorage,
        recallNamespaces,
      );
      ownerNamespace = ownerStorage?.namespace ?? null;
      if (!ownerNamespace && resolveNamespaceCapabilities(this.getConfig()).namespaces) return null;
    }
    ownerNamespace ??= this.namespaceFromPath(memory.path);
    if (
      recallNamespaces.length > 0 &&
      !recallNamespaces.includes(ownerNamespace)
    ) {
      return null;
    }

    return {
      namespace: ownerNamespace,
      result: {
        ...result,
        docid: result.docid || memory.frontmatter.id,
        path: memory.path,
        snippet: result.snippet || memory.content.slice(0, 400),
      },
    };
  }

  async storageForAbsoluteQmdResultPath(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
  ): Promise<{ storage: StorageManager; dir: string; namespace: string } | null> {
    const resolvedPath = path.resolve(resultPath);
    const config = this.getConfig();
    const memoryRoot = path.resolve(config.memoryDir);
    const namespacesRoot = path.join(memoryRoot, "namespaces");
    const fallbackStorageDir = storageDirOrNull(fallbackStorage);
    const matches: Array<{ storage: StorageManager; dir: string; namespace: string }> = [];
    const seenDirs = new Set<string>();

    const maybeAddStorage = (storage: StorageManager, namespace: string) => {
      const storageDir = storageDirOrNull(storage);
      if (!storageDir) return;
      const candidateRoot = path.resolve(storageDir);
      if (seenDirs.has(candidateRoot)) return;
      if (!isPathInsideStorageRoot(candidateRoot, resolvedPath)) return;
      if (
        candidateRoot === memoryRoot &&
        isPathInsideStorageRoot(namespacesRoot, resolvedPath)
      ) {
        return;
      }
      seenDirs.add(candidateRoot);
      matches.push({ storage, dir: candidateRoot, namespace });
    };

    const fallbackNamespace =
      fallbackStorageDir !== null
        ? this.storageDirNamespace(fallbackStorageDir)
        : config.defaultNamespace;
    maybeAddStorage(fallbackStorage, fallbackNamespace);

    const candidateNamespaces = new Set<string>();
    candidateNamespaces.add(config.defaultNamespace);
    candidateNamespaces.add(config.sharedNamespace);
    for (const ns of recallNamespaces) {
      candidateNamespaces.add(ns);
    }
    if (isPathInsideStorageRoot(namespacesRoot, resolvedPath)) {
      const relativeToNamespaces = path.relative(namespacesRoot, resolvedPath);
      const [namespaceSegment] = relativeToNamespaces.split(/[\\/]/);
      if (namespaceSegment) {
        candidateNamespaces.add(
          namespaceIdentityFromToken(namespaceSegment) ?? namespaceSegment,
        );
      }
    }
    for (const policy of config.namespacePolicies ?? []) {
      candidateNamespaces.add(policy.name);
    }

    for (const ns of candidateNamespaces) {
      if (!ns) continue;
      try {
        maybeAddStorage(await this.storageFor(ns), ns);
      } catch {
        continue;
      }
    }

    matches.sort((a, b) => b.dir.length - a.dir.length);
    return matches[0] ?? null;
  }
}
