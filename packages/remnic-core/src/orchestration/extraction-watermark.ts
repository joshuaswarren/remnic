import path from "node:path";

import { resolveNamespaceCapabilities } from "../capabilities.js";
import { resolveCorpusNamespaceRoots, type CorpusNamespaceRoot } from "../corpus-watermark.js";
import type { ExtractionRootStats, ExtractionWatermarkRead } from "../extraction-liveness.js";
import type { MetaState, PluginConfig } from "../types.js";

export interface ExtractionWatermarkMeta extends Pick<MetaState, "lastExtractionAt"> {
  extractionCount?: number;
  lastConsolidationAt?: string | null;
}

export interface ExtractionWatermarkStorage {
  readonly dir: string;
  loadMeta(): Promise<ExtractionWatermarkMeta>;
}

export interface ExtractionNamespaceRootCache {
  getResolvedRootsStatus(compute: () => Promise<CorpusNamespaceRoot[]>): {
    roots: CorpusNamespaceRoot[] | undefined;
    refreshError: unknown;
  };
}

export interface AggregateExtractionWatermarkOptions {
  config: PluginConfig;
  rootStorage: ExtractionWatermarkStorage;
  storageForNamespace(
    namespace: string,
    rootDir: string
  ): ExtractionWatermarkStorage | Promise<ExtractionWatermarkStorage>;
  rootsCache?: ExtractionNamespaceRootCache;
}

function readFailure(reason: string, rootStats?: ExtractionRootStats): ExtractionWatermarkRead {
  return {
    lastExtractionAt: null,
    readFailed: true,
    readError: reason,
    ...(rootStats ? { rootStats } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readWatermark(storage: ExtractionWatermarkStorage, name: string): Promise<ExtractionWatermarkRead> {
  try {
    const meta = await storage.loadMeta();
    const hasRootStats = meta.extractionCount !== undefined || meta.lastConsolidationAt !== undefined;
    return {
      lastExtractionAt: meta.lastExtractionAt ?? null,
      readFailed: false,
      ...(hasRootStats
        ? {
            rootStats: {
              extractionCount: meta.extractionCount,
              lastConsolidationAt: meta.lastConsolidationAt,
            },
          }
        : {}),
    };
  } catch (error) {
    return readFailure(`${name} watermark unreadable: ${errorMessage(error)}`);
  }
}

async function resolveRoots(
  options: AggregateExtractionWatermarkOptions
): Promise<CorpusNamespaceRoot[] | ExtractionWatermarkRead> {
  const compute = () =>
    resolveCorpusNamespaceRoots({
      config: options.config,
      propagateDiscoveryErrors: true,
    });
  if (options.rootsCache) {
    const { roots, refreshError } = options.rootsCache.getResolvedRootsStatus(compute);
    if (refreshError !== undefined) {
      return readFailure(`namespace watermark enumeration failed: ${errorMessage(refreshError)}`);
    }
    return roots ?? readFailure("namespace watermark enumeration unavailable: namespace root cache is warming");
  }
  try {
    return await compute();
  } catch (error) {
    return readFailure(`namespace watermark enumeration failed: ${errorMessage(error)}`);
  }
}

function isReadFailure(value: CorpusNamespaceRoot[] | ExtractionWatermarkRead): value is ExtractionWatermarkRead {
  return !Array.isArray(value);
}

function newerWatermark(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(candidateMs)) return current;
  if (current === null) return candidate;
  const currentMs = Date.parse(current);
  return !Number.isFinite(currentMs) || candidateMs > currentMs ? candidate : current;
}

export async function readAggregateExtractionWatermark(
  options: AggregateExtractionWatermarkOptions
): Promise<ExtractionWatermarkRead> {
  if (!resolveNamespaceCapabilities(options.config).namespaces) {
    return readWatermark(options.rootStorage, "root store");
  }

  const resolved = await resolveRoots(options);
  if (isReadFailure(resolved)) return resolved;

  const rootDir = path.resolve(options.rootStorage.dir);
  const seenDirs = new Set<string>([rootDir]);
  const targets: CorpusNamespaceRoot[] = [];
  for (const root of resolved) {
    const resolvedDir = path.resolve(root.rootDir);
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);
    targets.push(root);
  }

  const rootRead = await readWatermark(options.rootStorage, "root store");
  if (rootRead.readFailed) return rootRead;
  let lastExtractionAt = rootRead.lastExtractionAt;

  for (const target of targets) {
    let storage: ExtractionWatermarkStorage;
    try {
      storage = await options.storageForNamespace(target.namespace, target.rootDir);
    } catch (error) {
      return readFailure(
        `namespace "${target.namespace}" watermark storage unavailable: ${errorMessage(error)}`,
        rootRead.rootStats
      );
    }
    const namespaceRead = await readWatermark(storage, `namespace "${target.namespace}"`);
    if (namespaceRead.readFailed) {
      return readFailure(
        namespaceRead.readError ?? `namespace "${target.namespace}" watermark unreadable`,
        rootRead.rootStats
      );
    }
    lastExtractionAt = newerWatermark(lastExtractionAt, namespaceRead.lastExtractionAt);
  }

  return {
    lastExtractionAt,
    readFailed: false,
    ...(rootRead.rootStats ? { rootStats: rootRead.rootStats } : {}),
  };
}
