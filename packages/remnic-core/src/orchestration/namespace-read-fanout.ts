/**
 * Namespace read-fanout coordinator — extracted from the orchestrator
 * (issue #1526, seam 26).
 *
 * Owns namespace-scoped READ fanout (never namespace RESOLUTION — the
 * ScopePlan resolver from #1521 stays the single authority for that):
 *   - storage-dir hint loading from the catalog
 *   - cross-namespace search and memory/archive reads
 *   - scoped memory candidate search and artifact recall fanout
 *   - artifact source status resolution (with per-storage cache)
 *   - path→namespace and storage-dir→namespace mapping helpers
 *
 * Behavior-preserving move from orchestrator.ts (late-binding deps rule,
 * seams 18–25).
 */

import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { StorageManager } from "../index.js";
import { NamespaceCatalog } from "../namespaces/catalog.js";
import { namespaceIdentityFromToken, namespaceIdentityToken, normalizeNamespaceIdentity } from "../namespaces/identity.js";
import { NamespaceSearchRouter } from "../namespaces/search.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { mergeArtifactRecallCandidates, tokenizeRecallQuery } from "./orchestrator-helpers.js";
import { qmdCollectionPathParts } from "./qmd-result-resolver.js";
import { qmdCollectionNamespaceFromPrefix as computeQmdCollectionNamespaceFromPrefix } from "./orchestrator-namespace-scope.js";
import { resolveNamespaceFromStorageDir } from "../scopes/scope-plan.js";
import type { ArtifactRecallOptions } from "./recall-search-prefilter.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions } from "../search/port.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "../types.js";
import {
  Orchestrator,
} from "../orchestrator.js";

export interface NamespaceReadFanoutDeps {
  readonly artifactSourceStatusCache: WeakMap<StorageManager, { loadedAtMs: number; statusVersion: number; statuses: Map<string, "active" | "superseded" | "archived" | "missing"> }>;
  readonly config: PluginConfig;
  configuredNamespaceList(): string[];
  fetchActiveArtifactsForNamespace(
    namespace: string,
    prompt: string,
    targetCount: number,
    options?: ArtifactRecallOptions,
  ): Promise<MemoryFile[]>;
  loadNamespaceStorageDirHintsFromCatalog(): void;
  readonly namespaceCatalog: NamespaceCatalog;
  namespaceFromPath(p: string): string;
  readonly namespaceSearchRouter: NamespaceSearchRouter;
  namespaceStorageDirHintOwnershipRank(
    record: { namespace: string },
    resolvedStorageDir: string,
    configured: Set<string>,
  ): number;
  readonly namespaceStorageDirHints: Map<string, Set<string>>;
  namespaceStorageDirHintsLoaded: boolean;
  preferNamespaceStorageDirHintOwner(
    current: { namespace: string; identityToken: string; storageDir: string },
    candidate: { namespace: string; identityToken: string; storageDir: string },
    resolvedStorageDir: string,
    configured: Set<string>,
  ): { namespace: string; identityToken: string; storageDir: string };
  readonly qmd: SearchBackend;
  rememberNamespaceStorageDirHint(namespace: string, storageDir?: string): void;
  storageDirMatchesNamespaceHint(namespace: string, storageDir: string): boolean;
  readonly storageRouter: NamespaceStorageRouter;
}

export class NamespaceReadFanoutCoordinator {
  constructor(
    private readonly deps: NamespaceReadFanoutDeps,
  ) {}

  preferNamespaceStorageDirHintOwner(
    current: { namespace: string; identityToken: string; storageDir: string },
    candidate: { namespace: string; identityToken: string; storageDir: string },
    resolvedStorageDir: string,
    configured: Set<string>,
  ): { namespace: string; identityToken: string; storageDir: string } {
    const currentRank = this.deps.namespaceStorageDirHintOwnershipRank(
      current,
      resolvedStorageDir,
      configured,
    );
    const candidateRank = this.deps.namespaceStorageDirHintOwnershipRank(
      candidate,
      resolvedStorageDir,
      configured,
    );
    if (candidateRank < currentRank) return candidate;
    if (candidateRank > currentRank) return current;

    const byName = candidate.namespace.localeCompare(current.namespace);
    if (byName < 0) return candidate;
    if (byName > 0) return current;
    return candidate.identityToken.localeCompare(current.identityToken) < 0
      ? candidate
      : current;
  }

  loadNamespaceStorageDirHintsFromCatalog(): void {
    if (this.deps.namespaceStorageDirHintsLoaded || !this.deps.namespaceCatalog.enabled) return;
    this.deps.namespaceStorageDirHintsLoaded = true;
    const catalogPath = path.join(this.deps.config.memoryDir, "state", "namespaces.jsonl");
    if (!existsSync(catalogPath)) return;

    let body: string;
    try {
      body = readFileSync(catalogPath, "utf8");
    } catch {
      return;
    }

    const compactedByNamespace = new Map<
      string,
      { namespace: string; identityToken: string; storageDir: string }
    >();
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        if (
          typeof record.namespace !== "string" ||
          typeof record.storageDir !== "string" ||
          typeof record.identityToken !== "string"
        ) {
          continue;
        }
        const namespace = normalizeNamespaceIdentity(record.namespace);
        if (!namespace || record.identityToken !== namespaceIdentityToken(namespace)) continue;
        compactedByNamespace.set(namespace, {
          namespace,
          identityToken: record.identityToken,
          storageDir: record.storageDir,
        });
      } catch {
        // Catalog hints are best-effort. The catalog reader still owns full recovery.
      }
    }

    const configured = new Set(
      this.deps.configuredNamespaceList().map((namespace) => normalizeNamespaceIdentity(namespace)),
    );
    const preferredByStorageDir = new Map<
      string,
      { namespace: string; identityToken: string; storageDir: string }
    >();
    for (const record of compactedByNamespace.values()) {
      if (!this.deps.storageDirMatchesNamespaceHint(record.namespace, record.storageDir)) {
        continue;
      }
      const resolvedStorageDir = path.resolve(record.storageDir);
      const current = preferredByStorageDir.get(resolvedStorageDir);
      preferredByStorageDir.set(
        resolvedStorageDir,
        current
          ? this.deps.preferNamespaceStorageDirHintOwner(
              current,
              record,
              resolvedStorageDir,
              configured,
            )
          : record,
      );
    }
    for (const record of preferredByStorageDir.values()) {
      this.deps.rememberNamespaceStorageDirHint(record.namespace, record.storageDir);
    }
  }

  async searchAcrossNamespaces(options: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    searchOptions?: SearchQueryOptions;
    execution?: SearchExecutionOptions;
  }): Promise<QmdSearchResult[]> {
    if (
      resolveNamespaceCapabilities(this.deps.config).namespaces &&
      options.namespaces !== undefined &&
      options.namespaces.length === 0
    ) {
      return [];
    }
    const namespaces = resolveNamespaceCapabilities(this.deps.config).namespaces
      ? Array.from(
          new Set(
            (options.namespaces?.length
              ? options.namespaces
              : this.deps.configuredNamespaceList()
            )
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        )
      : [this.deps.config.defaultNamespace];

    if (!resolveNamespaceCapabilities(this.deps.config).namespaces) {
      switch (options.mode) {
        case "hybrid":
          return await this.deps.qmd.hybridSearch(
            options.query,
            undefined,
            options.maxResults,
            options.execution,
          );
        case "bm25":
          return await this.deps.qmd.bm25Search(
            options.query,
            undefined,
            options.maxResults,
            options.execution,
          );
        case "vector":
          return await this.deps.qmd.vectorSearch(
            options.query,
            undefined,
            options.maxResults,
            options.execution,
          );
        default:
          return await this.deps.qmd.search(
            options.query,
            undefined,
            options.maxResults,
            options.searchOptions,
            options.execution,
          );
      }
    }

    return await this.deps.namespaceSearchRouter.searchAcrossNamespaces({
      query: options.query,
      namespaces,
      maxResults: options.maxResults,
      mode: options.mode,
      searchOptions: options.searchOptions,
      execution: options.execution,
    });
  }

  async resolveArtifactSourceStatuses(
    storage: StorageManager,
    sourceIds: string[],
  ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">> {
    const currentStatusVersion = storage.getMemoryStatusVersion();
    const cached = this.deps.artifactSourceStatusCache.get(storage);
    let snapshot = cached;
    const isFresh =
      snapshot !== undefined &&
      Date.now() - snapshot.loadedAtMs <=
        Orchestrator.ARTIFACT_STATUS_CACHE_TTL_MS &&
      snapshot.statusVersion === currentStatusVersion;

    const rebuildSnapshot = async () => {
      const MAX_STABLE_READ_ATTEMPTS = 3;
      let latestStatuses = new Map<
        string,
        "active" | "superseded" | "archived" | "missing"
      >();
      let latestVersionAfter = storage.getMemoryStatusVersion();

      for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
        const versionBefore = storage.getMemoryStatusVersion();
        const allMemories = await storage.readAllMemories();
        const versionAfter = storage.getMemoryStatusVersion();
        latestVersionAfter = versionAfter;
        latestStatuses = new Map(
          allMemories.map((m) => [
            m.frontmatter.id,
            (m.frontmatter.status ?? "active") as
              | "active"
              | "superseded"
              | "archived"
              | "missing",
          ]),
        );

        if (versionAfter === versionBefore) {
          const rebuilt = {
            loadedAtMs: Date.now(),
            statusVersion: versionAfter,
            statuses: latestStatuses,
          };
          this.deps.artifactSourceStatusCache.set(storage, rebuilt);
          return rebuilt;
        }
      }

      // Sustained write churn: return latest read without caching a potentially torn snapshot.
      return {
        loadedAtMs: Date.now(),
        statusVersion: latestVersionAfter,
        statuses: latestStatuses,
      };
    };

    if (!isFresh) {
      snapshot = await rebuildSnapshot();
    } else {
      // Warm cache may miss brand-new sourceMemoryId values created after snapshot build.
      // Refresh once on-demand when unseen IDs are requested.
      const hasUnknownSourceIds = sourceIds.some(
        (id) => !snapshot?.statuses.has(id),
      );
      if (hasUnknownSourceIds) {
        snapshot = await rebuildSnapshot();
      }
    }

    // Persist negative lookups in the cached snapshot so stale source IDs do not
    // trigger repeated full snapshot rebuilds on every matching recall.
    for (const id of sourceIds) {
      if (!snapshot?.statuses.has(id)) {
        snapshot?.statuses.set(id, "missing");
      }
    }

    const statuses = new Map<
      string,
      "active" | "superseded" | "archived" | "missing"
    >();
    for (const id of sourceIds) {
      const status = snapshot?.statuses.get(id);
      if (status) {
        statuses.set(id, status);
      } else {
        statuses.set(id, "missing");
      }
    }
    return statuses;
  }

  async recallArtifactsAcrossNamespaces(
    prompt: string,
    recallNamespaces: string[],
    targetCount: number,
    options: ArtifactRecallOptions = {},
  ): Promise<MemoryFile[]> {
    if (targetCount <= 0) return [];
    const namespaces = Array.from(new Set(recallNamespaces));
    const filteredByNamespace = await Promise.all(
      namespaces.map((namespace) =>
        this.deps.fetchActiveArtifactsForNamespace(namespace, prompt, targetCount, options),
      ),
    );

    return mergeArtifactRecallCandidates(filteredByNamespace, targetCount);
  }

  async searchScopedMemoryCandidates(
    candidatePaths: Set<string>,
    query: string,
    limit: number,
    options?: {
      allowArchived?: boolean;
    },
  ): Promise<QmdSearchResult[]> {
    const cappedLimit = Math.max(0, limit);
    if (cappedLimit === 0 || candidatePaths.size === 0) return [];

    const tokens = Array.from(new Set(tokenizeRecallQuery(query)));
    const memories = (
      await Promise.all(
        Array.from(candidatePaths).map(async (memoryPath) => {
          const namespace = resolveNamespaceCapabilities(this.deps.config).namespaces
            ? this.deps.namespaceFromPath(memoryPath)
            : this.deps.config.defaultNamespace;
          const storage = await this.deps.storageRouter.storageFor(namespace);
          const memory = await storage.readMemoryByPath(memoryPath);
          return memory ? { memory, namespace } : null;
        }),
      )
    ).filter(
      (entry): entry is { memory: MemoryFile; namespace: string } => entry !== null,
    );

    const results: QmdSearchResult[] = [];
    for (const { memory, namespace } of memories) {
      const status = memory.frontmatter.status ?? "active";
      if (!options?.allowArchived && status !== "active") continue;

      const haystack = [
        memory.content,
        memory.frontmatter.category,
        ...(memory.frontmatter.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) hits += 1;
      }
      const score = tokens.length > 0 ? hits / tokens.length : 0.01;
      if (tokens.length > 0 && hits === 0) continue;

      results.push({
        docid: memory.frontmatter.id,
        namespace,
        path: memory.path,
        score,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
        transport: "scoped_prefilter",
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, cappedLimit);
  }

  async resolveStateDirForNamespace(
    namespace: string,
  ): Promise<string> {
    if (!resolveNamespaceCapabilities(this.deps.config).namespaces) {
      return path.join(this.deps.config.memoryDir, "state");
    }
    if (namespace !== this.deps.config.defaultNamespace) {
      return path.join(this.deps.config.memoryDir, "namespaces", namespace, "state");
    }
    const candidate = path.join(
      this.deps.config.memoryDir,
      "namespaces",
      this.deps.config.defaultNamespace,
    );
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isDirectory()) {
        return path.join(candidate, "state");
      }
    } catch {
      // Fall back to the legacy root when the migrated default namespace directory is absent.
    }
    return path.join(this.deps.config.memoryDir, "state");
  }

  namespaceFromPath(p: string): string {
    if (!resolveNamespaceCapabilities(this.deps.config).namespaces) return this.deps.config.defaultNamespace;
    const parts = qmdCollectionPathParts(p);
    const collectionNamespace = parts
      ? computeQmdCollectionNamespaceFromPrefix(parts.collection, this.deps.config)
      : null;
    if (collectionNamespace) return collectionNamespace;
    const pathParts = p.replaceAll("\\", "/").split("/");
    const namespaceIndex = pathParts.indexOf("namespaces");
    const namespaceToken = namespaceIndex >= 0 ? pathParts[namespaceIndex + 1] : undefined;
    if (!namespaceToken) return this.deps.config.defaultNamespace;
    return namespaceIdentityFromToken(namespaceToken) ?? namespaceToken;
  }

  storageDirNamespace(storageDir: string): string {
    // #1521: delegates to the scope-module resolver. The inline dir→namespace
    // derivation (token round-trip guard, catalog hints) is retired so the
    // adHocNamespaceResolutions ratchet no longer counts this site. Hints are
    // loaded lazily via the callback (only after early returns, matching the
    // original behavior — codex P2).
    return resolveNamespaceFromStorageDir(storageDir, {
      config: this.deps.config,
      configuredNamespaces: this.deps.configuredNamespaceList(),
      hints: this.deps.namespaceStorageDirHints,
      loadHints: () => this.deps.loadNamespaceStorageDirHintsFromCatalog(),
    });
  }

  async readAllMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]> {
    const uniq = Array.from(new Set(namespaces.filter(Boolean)));
    const lists = await Promise.all(
      uniq.map(async (ns) => {
        const sm = await this.deps.storageRouter.storageFor(ns);
        return sm.readAllMemories();
      }),
    );
    return lists.flat();
  }

}
