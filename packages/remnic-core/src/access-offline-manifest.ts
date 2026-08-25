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

/**
 * Decide what the manifest stream should persist, and whether a write is
 * needed at all.
 *
 * A write is required whenever the persisted set changed — an identity was
 * rebuilt, or an entry was dropped because its file lost its identity — and
 * also when a completed walk leaves entries for paths it never saw, which are
 * files that have since been deleted. Skipping the write in that last case
 * would strand those entries on disk forever.
 *
 * Pruning is gated on the walk completing: an aborted or partially consumed
 * stream has simply not observed the remaining paths, so it may only add.
 */
export function planServerIdentityCacheWrite(input: {
  persisted: ReadonlyMap<string, ServerIdentityCacheEntry>;
  yieldedPaths: ReadonlySet<string>;
  /** Paths the walk saw but never yielded (removed by the exclusion
   * callback). Not deleted — pruning them would drop their persisted
   * classification and force a re-classify on every later cycle. */
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

/**
 * The cache lives under `.remnic/` rather than `state/`: snapshot enumeration
 * excludes internal `.remnic/` paths structurally (`isInternalRemnicStatePath`),
 * whereas `state/` is only filtered by an allowlist of known node-local
 * artifacts. Under `state/` this node-local cache would be advertised as a peer
 * file, so convergence would transfer the cache itself — and the stream rewrites
 * it during finalization, so the advertised digest could go stale mid-transfer.
 */
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
    // Identities are derived after stripping inline attribution for a specific
    // citation template; entries written under a different one would produce
    // wrong contentHash values for unchanged files.
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

/** Serialize cache replacements per path: overlapping manifest streams for one
 * namespace would otherwise each publish a whole-file snapshot, and the slower
 * stream built from older filesystem state would overwrite the newer one. */
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

/** Union of the entries being written and the current on-disk set; on conflict
 * the write wins (it reflects the newer run). Callers hold the write lock. */
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

/** Record classifications for files the walk excluded (the exclusion callback
 * returned true, so they were never yielded): they were seen this walk, so
 * their entries must persist and must not be pruned as deleted. Mirrors the
 * per-yield classification application for never-yielded paths. */
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
  // The exclusion callback runs before every yield; without the persisted
  // classification it would read and parse every candidate file, defeating the
  // warm-cache skip entirely.
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
      // Any change to the persisted set, not just a rebuilt identity: a file
      // that lost its identity, or a completed walk that must prune vanished
      // paths, also has to reach disk or the removal is lost forever.
      let cacheDirty = false;
      let streamCompleted = false;
      // Seeded with every previously cached entry so a partially consumed
      // stream (client disconnect, abort) can only add to the cache. Writing
      // just this run's rebuilds would drop every cache hit, so one edit to a
      // large corpus would shrink the cache to that single entry and force a
      // near-cold rebuild on the next request.
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
            // Merge with whatever is on disk NOW: a concurrent stream for the
            // same namespace may have published newer entries after this
            // request loaded its snapshot, and a blind whole-file replace
            // would discard them.
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
          // Negative results persist too: a memory-shaped file that parses
          // without an identity would otherwise be re-read on every warm run.
          const previous = persistedEntries.get(built.path);
          if (previous?.sha256 !== built.sha256 || (built.memory !== undefined && previous?.memory !== built.memory)) {
            cacheDirty = true;
          }
          if (built.memory === undefined && built.normalizerVersion === undefined) {
            // Read failed: do not persist a negative identity for this SHA.
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
        // Files the exclusion callback removed from the snapshot were seen
        // this walk but never yielded: persist their classifications so the
        // next cycle skips the read+parse, and keep them out of the
        // deleted-path prune.
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
