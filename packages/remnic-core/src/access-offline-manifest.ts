import * as nodePath from "node:path";
import { offlineSyncStorageForSnapshot } from "./offline-sync-impression-drain.js";
import { iterateOfflineSyncSnapshotFileRecords } from "./offline-sync.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  CONTENT_HASH_NORMALIZER_VERSION,
  IDENTITY_RESOLUTION_VERSION,
  RECONCILE_MANIFEST_FORMAT,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifest,
  type ReconcileManifestFile,
  type ReconcileMemoryIdentity,
  type ReconcileMemoryParser,
  buildReconcileManifestFile,
  citationTemplateFingerprint,
  isCachedIdentityReusable,
  isReconcileMemoryIdentity,
} from "./reconcile/manifest.js";
import { createPersistedSupportPassportPrivateFileExclusion } from "./support-passport/card-projection.js";

export interface OfflineSyncManifestRequest {
  includeTranscripts?: boolean;
  signal?: AbortSignal;
}

export interface OfflineSyncManifestStreamResponse extends Omit<ReconcileManifest, "files"> {
  namespace: string;
  files: AsyncIterable<ReconcileManifestFile>;
}

export interface ServerIdentityCacheEntry {
  path: string;
  sha256: string;
  memory?: ReconcileMemoryIdentity;
  /** Stamped on sha-only entries so an upgrade re-parses them. */
  normalizerVersion?: number;
  identityResolutionVersion?: number;
  /** Stat identity the exclusion classification was computed against. */
  statIdentity?: string;
  /** Persisted support-passport private-memory classification for statIdentity. */
  excluded?: boolean;
}

export function planServerIdentityCacheWrite(input: {
  persisted: ReadonlyMap<string, ServerIdentityCacheEntry>;
  yieldedPaths: ReadonlySet<string>;
  retainedPaths?: ReadonlySet<string>;
  streamCompleted: boolean;
  cacheDirty: boolean;
}): { shouldWrite: boolean; entries: ServerIdentityCacheEntry[] } {
  const entries = input.streamCompleted
    ? [...input.persisted.values()].filter(
        (entry) => input.yieldedPaths.has(entry.path) || input.retainedPaths?.has(entry.path)
      )
    : [...input.persisted.values()];
  return { shouldWrite: input.cacheDirty || entries.length !== input.persisted.size, entries };
}

function serverIdentityCachePath(storageDir: string): string {
  return nodePath.join(storageDir, ".remnic", "state", "converge-identity-cache.json");
}

async function loadServerIdentityCache(
  storageDir: string,
  citationTemplate?: string
): Promise<Map<string, ServerIdentityCacheEntry>> {
  const cache = new Map<string, ServerIdentityCacheEntry>();
  try {
    const raw = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(serverIdentityCachePath(storageDir), "utf8"))
    ) as {
      citationTemplate?: string;
      files?: unknown[];
    };
    if (raw.citationTemplate !== citationTemplateFingerprint(citationTemplate)) return cache;
    for (const candidate of raw.files ?? []) {
      const entry = candidate as Partial<ServerIdentityCacheEntry> | null;
      if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") continue;
      if (entry.memory !== undefined && !isReconcileMemoryIdentity(entry.memory)) continue;
      if (entry.statIdentity !== undefined && typeof entry.statIdentity !== "string") continue;
      if (entry.excluded !== undefined && typeof entry.excluded !== "boolean") continue;
      if (entry.normalizerVersion !== undefined && typeof entry.normalizerVersion !== "number") continue;
      if (entry.identityResolutionVersion !== undefined && typeof entry.identityResolutionVersion !== "number") {
        continue;
      }
      cache.set(entry.path, {
        path: entry.path,
        sha256: entry.sha256,
        ...(entry.memory ? { memory: entry.memory } : {}),
        ...(entry.memory
          ? {}
          : {
              ...(typeof entry.normalizerVersion === "number" ? { normalizerVersion: entry.normalizerVersion } : {}),
              ...(typeof entry.identityResolutionVersion === "number"
                ? { identityResolutionVersion: entry.identityResolutionVersion }
                : {}),
            }),
        ...(entry.statIdentity !== undefined && entry.excluded !== undefined
          ? { statIdentity: entry.statIdentity, excluded: entry.excluded }
          : {}),
      });
    }
  } catch {
    // missing or corrupt cache: cold build
  }
  return cache;
}

const serverIdentityCacheWriteLocks = new Map<string, Promise<void>>();

async function withServerIdentityCacheWriteLock(cachePath: string, write: () => Promise<void>): Promise<void> {
  const previous = serverIdentityCacheWriteLocks.get(cachePath) ?? Promise.resolve();
  const next = previous.then(write, write);
  serverIdentityCacheWriteLocks.set(cachePath, next);
  try {
    await next;
  } finally {
    if (serverIdentityCacheWriteLocks.get(cachePath) === next) {
      serverIdentityCacheWriteLocks.delete(cachePath);
    }
  }
}

export async function mergeServerIdentityCacheEntries(
  fs: typeof import("node:fs/promises"),
  cachePath: string,
  entries: readonly ServerIdentityCacheEntry[],
  citationTemplate: string | undefined,
  dropped: ReadonlySet<string> = new Set()
): Promise<ServerIdentityCacheEntry[]> {
  const merged = new Map(entries.map((entry) => [entry.path, entry]));
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
      citationTemplate?: string;
      files?: unknown[];
    };
    if (raw.citationTemplate === citationTemplateFingerprint(citationTemplate)) {
      for (const candidate of raw.files ?? []) {
        const entry = candidate as Partial<ServerIdentityCacheEntry> | null;
        if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") continue;
        if (entry.memory !== undefined && !isReconcileMemoryIdentity(entry.memory)) continue;
        if (dropped.has(entry.path) || merged.has(entry.path)) continue;
        merged.set(entry.path, {
          path: entry.path,
          sha256: entry.sha256,
          ...(entry.memory ? { memory: entry.memory } : {}),
          ...(entry.memory
            ? {}
            : {
                ...(typeof entry.normalizerVersion === "number" ? { normalizerVersion: entry.normalizerVersion } : {}),
                ...(typeof entry.identityResolutionVersion === "number"
                  ? { identityResolutionVersion: entry.identityResolutionVersion }
                  : {}),
              }),
          ...(entry.statIdentity !== undefined && entry.excluded !== undefined
            ? { statIdentity: entry.statIdentity, excluded: entry.excluded }
            : {}),
        });
      }
    }
  } catch {
    // missing or unreadable current cache: the write set stands alone
  }
  return [...merged.values()];
}

export function retainExcludedClassifications(input: {
  persisted: Map<string, ServerIdentityCacheEntry>;
  classifications: ReadonlyMap<string, { statIdentity: string; excluded: boolean }>;
  yieldedPaths: ReadonlySet<string>;
}): { retained: Set<string>; changed: boolean } {
  const retained = new Set<string>();
  let changed = false;
  for (const [pathName, classification] of input.classifications) {
    if (input.yieldedPaths.has(pathName)) continue;
    retained.add(pathName);
    const entry = input.persisted.get(pathName) ?? { path: pathName, sha256: "" };
    if (entry.statIdentity === classification.statIdentity && entry.excluded === classification.excluded) {
      continue;
    }
    input.persisted.set(pathName, {
      ...entry,
      statIdentity: classification.statIdentity,
      excluded: classification.excluded,
    });
    changed = true;
  }
  return { retained, changed };
}

export async function createOfflineSyncManifestStream(
  orchestrator: Orchestrator,
  namespace: string,
  userExcludeRegexps: RegExp[],
  options: OfflineSyncManifestRequest,
  parseMemory: ReconcileMemoryParser
): Promise<OfflineSyncManifestStreamResponse> {
  const storage = await offlineSyncStorageForSnapshot(orchestrator, namespace);
  const citationTemplate = orchestrator.config.inlineSourceAttributionFormat;
  const identityCache = await loadServerIdentityCache(storage.dir, citationTemplate);
  const classificationUpdates = new Map<string, { statIdentity: string; excluded: boolean }>();
  const snapshotFiles = iterateOfflineSyncSnapshotFileRecords({
    root: storage.dir,
    includeContent: false,
    includeTranscripts: options.includeTranscripts !== false,
    readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
    signal: options.signal,
    userExcludeRegexps,
    excludeFile: createPersistedSupportPassportPrivateFileExclusion(storage, identityCache, classificationUpdates),
  });
  return {
    namespace,
    format: RECONCILE_MANIFEST_FORMAT,
    schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
    files: (async function* () {
      let cacheDirty = false;
      let streamCompleted = false;
      const persistedEntries = new Map(identityCache);
      const yieldedPaths = new Set<string>();
      const retainedPaths = new Set<string>();
      const flush = async (): Promise<void> => {
        const { shouldWrite, entries } = planServerIdentityCacheWrite({
          persisted: persistedEntries,
          yieldedPaths,
          retainedPaths,
          streamCompleted,
          cacheDirty,
        });
        if (!shouldWrite) return;
        try {
          const fs = await import("node:fs/promises");
          const cachePath = serverIdentityCachePath(storage.dir);
          await withServerIdentityCacheWriteLock(cachePath, async () => {
            const written = new Set(entries.map((entry) => entry.path));
            const dropped = streamCompleted
              ? new Set([...identityCache.keys()].filter((pathName) => !written.has(pathName)))
              : new Set<string>();
            const merged = await mergeServerIdentityCacheEntries(
              fs,
              cachePath,
              entries,
              citationTemplate,
              dropped
            );
            await fs.mkdir(nodePath.dirname(cachePath), { recursive: true });
            const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
            await fs.writeFile(
              tmp,
              JSON.stringify({ citationTemplate: citationTemplateFingerprint(citationTemplate), files: merged })
            );
            await fs.rename(tmp, cachePath);
          });
        } catch {
          // cache persistence is best-effort
        }
      };
      try {
        const applyClassification = (path: string, sha256: string): void => {
          const classification = classificationUpdates.get(path);
          if (classification === undefined) return;
          const entry = persistedEntries.get(path) ?? { path, sha256 };
          if (entry.statIdentity === classification.statIdentity && entry.excluded === classification.excluded) {
            return;
          }
          persistedEntries.set(path, {
            ...entry,
            ...(entry.memory ? { memory: entry.memory } : {}),
            statIdentity: classification.statIdentity,
            excluded: classification.excluded,
          });
          cacheDirty = true;
        };
        for await (const file of snapshotFiles) {
          yieldedPaths.add(file.path);
          const cached = identityCache.get(file.path);
          if (
            cached !== undefined &&
            cached.sha256.toLowerCase() === file.sha256.toLowerCase() &&
            isCachedIdentityReusable(cached)
          ) {
            applyClassification(file.path, file.sha256);
            yield {
              ...file,
              ...(cached.memory
                ? { memory: cached.memory }
                : {
                    normalizerVersion: cached.normalizerVersion,
                    identityResolutionVersion: cached.identityResolutionVersion,
                  }),
            };
            continue;
          }
          const built = await buildReconcileManifestFile(
            file,
            async ({ path }) => storage.readOfflineSyncFile(nodePath.join(storage.dir, path)),
            parseMemory,
            citationTemplate
          );
          const previous = persistedEntries.get(built.path);
          if (previous?.sha256 !== built.sha256 || (built.memory !== undefined && previous?.memory !== built.memory)) {
            cacheDirty = true;
          }
          if (built.memory === undefined && built.normalizerVersion === undefined) {
            yield built;
            continue;
          }
          persistedEntries.set(built.path, {
            path: built.path,
            sha256: built.sha256,
            ...(built.memory !== undefined
              ? { memory: built.memory }
              : {
                  normalizerVersion: built.normalizerVersion,
                  identityResolutionVersion: built.identityResolutionVersion,
                }),
          });
          applyClassification(built.path, built.sha256);
          yield built;
        }
        streamCompleted = true;
      } finally {
        const retained = retainExcludedClassifications({
          persisted: persistedEntries,
          classifications: classificationUpdates,
          yieldedPaths,
        });
        for (const pathName of retained.retained) retainedPaths.add(pathName);
        if (retained.changed) cacheDirty = true;
        await flush();
      }
    })(),
  };
}
