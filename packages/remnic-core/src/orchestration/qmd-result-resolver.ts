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
import { resolveNamespaceCapabilities } from "../capabilities.js";
import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import { namespaceIdentityFromToken } from "../namespaces/identity.js";
import { normalizeQmdResultPath } from "../namespaces/search.js";
import { SecureStoreLockedError } from "../secure-store/index.js";
import { isPathInsideStorageRoot } from "../storage-paths.js";
import { isSupportPassportPrivateMemory } from "../support-passport/card-projection.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "../types.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";

const INTERNAL_QMD_ROOTS = new Set([
  ...ALL_CATEGORY_DIRS,
  "activity",
  "archive",
  "artifacts",
  "cold",
  "config",
  "entities",
  "identity",
  "meetings",
  "namespaces",
  "state",
  "summaries",
  "transcripts",
  "wearables",
  "work",
  "workspace",
]);

const PRIVATE_RESULT_RESOLUTION_CONCURRENCY = 16;

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
  if (resultPath.trim().startsWith("qmd://")) {
    try {
      const parsed = new URL(resultPath.trim());
      if (parsed.protocol !== "qmd:" || !parsed.hostname) return null;
      const collection = parsed.hostname;
      const relativePath = normalizeQmdResultPath(resultPath, collection).replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relativePath) return null;
      return { collection, relativePath };
    } catch {
      return null;
    }
  }
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
export function qmdResultPathCandidates(storageDir: string, resultPath: string): string[] {
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
    // Daemon-mode results can arrive pre-absolutized against the storage
    // root while the file lives under facts/<date>/ (hot-facts collection
    // registered at the facts/ subtree — issue #2111). Mirror the relative
    // branch's facts/ fallback; addCandidate re-checks containment.
    const relative = path.relative(storageRoot, path.resolve(resultPath));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      const normalized = relative.split(path.sep).join("/");
      if (/^\d{4}-\d{2}-\d{2}\//.test(normalized)) {
        addCandidate(path.join(storageRoot, "facts", normalized));
      }
    }
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
  private readonly qmdCollectionNamespaceFromPrefix: (collectionPrefix: string) => string | null;
  private readonly namespaceFromPath: (p: string) => string;

  constructor(options: {
    getConfig: () => PluginConfig;
    storageFor: (namespace: string) => Promise<StorageManager>;
    storageDirNamespace: (storageDir: string) => string;
    qmdCollectionNamespaceFromPrefix: (collectionPrefix: string) => string | null;
    namespaceFromPath: (p: string) => string;
  }) {
    this.getConfig = options.getConfig;
    this.storageFor = options.storageFor;
    this.storageDirNamespace = options.storageDirNamespace;
    this.qmdCollectionNamespaceFromPrefix = options.qmdCollectionNamespaceFromPrefix;
    this.namespaceFromPath = options.namespaceFromPath;
  }

  async readQmdResultMemory(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = [],
    preferredNamespace?: string
  ): Promise<MemoryFile | null> {
    const parts = qmdCollectionPathParts(resultPath);
    const fallbackStorageDir = storageDirOrNull(fallbackStorage);
    const config = this.getConfig();
    const coldCollection = config.qmdColdCollection ?? "openclaw-engram-cold";
    const fallbackResultPath =
      resultPath.trim().startsWith("qmd://") && parts?.collection === config.qmdCollection
        ? parts.relativePath
        : resultPath;
    if (parts && parts.collection === coldCollection) {
      const storages: StorageManager[] = [];
      const seenStorageDirs = new Set<string>();
      const addStorage = (storage: StorageManager): void => {
        const storageDir = storageDirOrNull(storage);
        const storageKey = storageDir ? path.resolve(storageDir) : `storage-without-dir-${storages.length}`;
        if (seenStorageDirs.has(storageKey)) return;
        seenStorageDirs.add(storageKey);
        storages.push(storage);
      };

      const fallbackNamespace =
        fallbackStorageDir !== null ? this.storageDirNamespace(fallbackStorageDir) : config.defaultNamespace;
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
          for (const candidate of qmdResultPathCandidates(coldRoot, parts.relativePath)) {
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
    const collectionNamespace = parts ? this.qmdCollectionNamespaceFromPrefix(parts.collection) : null;

    if (parts && collectionNamespace) {
      try {
        const collectionStorage = await this.storageFor(collectionNamespace);
        for (const candidate of qmdResultPathCandidates(collectionStorage.dir, parts.relativePath)) {
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
        for (const candidate of qmdResultPathCandidates(preferredStorage.dir, fallbackResultPath)) {
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
      // The caller supplied an explicit owning namespace. For a relative path
      // the preferred store was the only correct lead, so a miss means the hit
      // is stale/deleted — do NOT fall through to the default store and validate
      // a same-relative-path memory from the wrong namespace (#2020). Absolute
      // paths still fall through: the absolute branch resolves the true owner.
      if (!path.isAbsolute(fallbackResultPath)) return null;
    }
    if (path.isAbsolute(fallbackResultPath)) {
      if (!fallbackStorageDir) {
        return await fallbackStorage.readMemoryByPath(fallbackResultPath);
      }
      const ownerStorage = await this.storageForAbsoluteQmdResultPath(
        fallbackResultPath,
        fallbackStorage,
        recallNamespaces
      );
      if (!ownerStorage) return null;
      for (const candidate of qmdResultPathCandidates(ownerStorage.dir, fallbackResultPath)) {
        const memory = await ownerStorage.storage.readMemoryByPath(candidate);
        if (memory) return memory;
      }
      return null;
    }

    if (!fallbackStorageDir) {
      return await fallbackStorage.readMemoryByPath(fallbackResultPath);
    }
    for (const candidate of qmdResultPathCandidates(fallbackStorageDir, fallbackResultPath)) {
      const memory = await fallbackStorage.readMemoryByPath(candidate);
      if (memory) return memory;
    }
    return null;
  }

  async filterPrivateSearchResults(
    results: QmdSearchResult[],
    fallbackStorage: StorageManager,
    namespaces: readonly string[] = [],
    preserveUnresolved = false,
    visibilityCache = new Map<string, boolean>()
  ): Promise<QmdSearchResult[]> {
    const namespaceKey = namespaces.join("\0");
    const entries = results
      .filter((result) => Boolean(result.path))
      .map((result) => ({
        result,
        cacheKey: `${namespaceKey}\0${preserveUnresolved ? "1" : "0"}\0${result.namespace ?? ""}\0${result.path}`,
      }));
    const pending = new Map<string, QmdSearchResult>();
    for (const { result, cacheKey } of entries) {
      if (!visibilityCache.has(cacheKey)) pending.set(cacheKey, result);
    }
    const unresolved = [...pending];
    for (let offset = 0; offset < unresolved.length; offset += PRIVATE_RESULT_RESOLUTION_CONCURRENCY) {
      await Promise.all(
        unresolved.slice(offset, offset + PRIVATE_RESULT_RESOLUTION_CONCURRENCY).map(async ([cacheKey, result]) => {
          visibilityCache.set(
            cacheKey,
            await this.isVisibleSearchResult(result, fallbackStorage, namespaces, preserveUnresolved)
          );
        })
      );
    }
    return entries.filter(({ cacheKey }) => visibilityCache.get(cacheKey) === true).map(({ result }) => result);
  }

  private async isVisibleSearchResult(
    result: QmdSearchResult,
    fallbackStorage: StorageManager,
    namespaces: readonly string[],
    preserveUnresolved: boolean
  ): Promise<boolean> {
    const parts = qmdCollectionPathParts(result.path);
    const config = this.getConfig();
    const collectionIsKnownInternal = parts !== null && INTERNAL_QMD_ROOTS.has(parts.collection);
    const collectionIsConfigured =
      parts !== null &&
      (parts.collection === config.qmdCollection ||
        parts.collection === (config.qmdColdCollection ?? "openclaw-engram-cold") ||
        this.qmdCollectionNamespaceFromPrefix(parts.collection) !== null);
    let memory = await this.readQmdResultMemory(result.path, fallbackStorage, namespaces, result.namespace);
    if (!memory && parts && !collectionIsKnownInternal && !collectionIsConfigured) {
      memory = await this.readQmdResultMemory(parts.relativePath, fallbackStorage, namespaces, result.namespace);
    }
    const absoluteInsideMemoryRoot =
      path.isAbsolute(result.path) &&
      isPathInsideStorageRoot(path.resolve(config.memoryDir), path.resolve(result.path));
    const hasExplicitQmdCollection = result.path.trim().startsWith("qmd://");
    const unresolvedInternalPath =
      !memory &&
      (absoluteInsideMemoryRoot ||
        (collectionIsKnownInternal && (!preserveUnresolved || hasExplicitQmdCollection)) ||
        (hasExplicitQmdCollection && collectionIsConfigured));
    const unresolvedExternalCollection =
      !memory &&
      ((parts !== null && !collectionIsKnownInternal && !collectionIsConfigured) ||
        (path.isAbsolute(result.path) &&
          !isPathInsideStorageRoot(path.resolve(config.memoryDir), path.resolve(result.path))));
    return (
      (memory !== null && !isSupportPassportPrivateMemory(memory)) ||
      (!memory && !unresolvedInternalPath && (preserveUnresolved || unresolvedExternalCollection))
    );
  }

  async resolveColdQmdResultForRecall(
    result: QmdSearchResult,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = []
  ): Promise<{ namespace: string; result: QmdSearchResult } | null> {
    const memory = await this.readQmdResultMemory(result.path, fallbackStorage, recallNamespaces, result.namespace);
    if (!memory) return null;

    let ownerNamespace: string | null = null;
    if (path.isAbsolute(memory.path)) {
      const ownerStorage = await this.storageForAbsoluteQmdResultPath(memory.path, fallbackStorage, recallNamespaces);
      ownerNamespace = ownerStorage?.namespace ?? null;
      if (!ownerNamespace && resolveNamespaceCapabilities(this.getConfig()).namespaces) return null;
    }
    ownerNamespace ??= this.namespaceFromPath(memory.path);
    if (recallNamespaces.length > 0 && !recallNamespaces.includes(ownerNamespace)) {
      return null;
    }

    return {
      namespace: ownerNamespace,
      result: {
        ...result,
        docid: result.docid || memory.frontmatter.id,
        path: memory.path,
        snippet: result.snippet || memory.content.slice(0, 400),
        origin: memory.frontmatter.origin,
      },
    };
  }

  async storageForAbsoluteQmdResultPath(
    resultPath: string,
    fallbackStorage: StorageManager,
    recallNamespaces: readonly string[] = []
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
      if (candidateRoot === memoryRoot && isPathInsideStorageRoot(namespacesRoot, resolvedPath)) {
        return;
      }
      seenDirs.add(candidateRoot);
      matches.push({ storage, dir: candidateRoot, namespace });
    };

    const fallbackNamespace =
      fallbackStorageDir !== null ? this.storageDirNamespace(fallbackStorageDir) : config.defaultNamespace;
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
        candidateNamespaces.add(namespaceIdentityFromToken(namespaceSegment) ?? namespaceSegment);
      }
    }
    for (const policy of config.namespacePolicies ?? []) {
      candidateNamespaces.add(policy.name);
    }

    for (const ns of candidateNamespaces) {
      if (!ns) continue;
      try {
        maybeAddStorage(await this.storageFor(ns), ns);
      } catch {}
    }

    matches.sort((a, b) => b.dir.length - a.dir.length);
    return matches[0] ?? null;
  }
}
