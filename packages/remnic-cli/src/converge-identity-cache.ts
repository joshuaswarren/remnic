import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ReconcileManifest,
  type ReconcileMemoryIdentity,
  CONTENT_HASH_NORMALIZER_VERSION,
  IDENTITY_RESOLUTION_VERSION,
  citationTemplateFingerprint,
  isReconcileMemoryIdentity,
} from "@remnic/core/reconcile/manifest.js";

export interface ConvergeIdentityCacheEntry {
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

const cacheWriteLocks = new Map<string, Promise<void>>();

/** Serialize cache replacements per path; concurrent plans for the same
 * (peer, namespace) would otherwise each publish a whole-file snapshot where
 * the slower one clobbers the newer. */
async function withCacheWriteLock(cachePath: string, write: () => Promise<void>): Promise<void> {
  const previous = cacheWriteLocks.get(cachePath) ?? Promise.resolve();
  const next = previous.then(write, write);
  cacheWriteLocks.set(cachePath, next);
  try {
    await next;
  } finally {
    if (cacheWriteLocks.get(cachePath) === next) cacheWriteLocks.delete(cachePath);
  }
}

interface ConvergeIdentityCacheFile {
  citationTemplate?: string;
  files?: unknown[];
}

/** Load the persistent parsed-identity cache for a (peer, namespace) pair.
 * Entries are keyed by path and validated by content sha at use time (the
 * manifest builder checks `cached.sha256 === file.sha256` plus normalizer
 * and identity-resolution versions), so a stale or corrupt file can only
 * cost a cold re-parse, never a wrong identity.
 *
 * The whole cache is discarded when it was written under a different citation
 * template: `contentHash` is derived after stripping inline attribution for
 * that template, so reusing those identities would change duplicate and
 * conflict decisions without any file changing. Entries whose `memory` is not
 * a well-formed identity are dropped rather than trusted — the file is
 * untrusted JSON, and a malformed entry must degrade to a cold parse instead
 * of throwing on the hit path. */
export async function loadConvergeIdentityCache(
  cachePath: string | undefined,
  citationTemplate?: string
): Promise<Map<string, ConvergeIdentityCacheEntry>> {
  const cache = new Map<string, ConvergeIdentityCacheEntry>();
  if (!cachePath) return cache;
  try {
    const raw = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as ConvergeIdentityCacheFile;
    if (raw.citationTemplate !== citationTemplateFingerprint(citationTemplate)) return cache;
    for (const candidate of raw.files ?? []) {
      const entry = candidate as Partial<ConvergeIdentityCacheEntry> | null;
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

/** Persist the parsed identities of a built manifest atomically.
 *
 * The manifest carries every file in the namespace — cache hits re-yielded
 * with their cached identity as well as freshly parsed ones — so writing it
 * whole preserves hits instead of shrinking the cache to the files that
 * happened to change on this run.
 *
 * A warm run with zero misses re-yields the loaded entries verbatim — same
 * object references, since `buildReconcileManifest` copies the cached identity
 * through — so an unchanged corpus would otherwise re-serialize and rewrite a
 * potentially multi-megabyte file on every plan/watch cycle. Pass the loaded
 * cache and the write is skipped when nothing changed. */
export async function saveConvergeIdentityCache(
  cachePath: string | undefined,
  manifest: ReconcileManifest,
  citationTemplate?: string,
  loaded?: ReadonlyMap<string, ConvergeIdentityCacheEntry>,
  classifications?: ReadonlyMap<string, { statIdentity: string; excluded: boolean }>
): Promise<void> {
  if (!cachePath) return;
  // Negative results persist too: a memory-shaped file that parses without an
  // identity would otherwise be re-read on every warm run.
  const files: ConvergeIdentityCacheEntry[] = manifest.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    ...(file.memory !== undefined
      ? { memory: file.memory }
      : file.normalizerVersion !== undefined && file.identityResolutionVersion !== undefined
        ? {
            normalizerVersion: file.normalizerVersion,
            identityResolutionVersion: file.identityResolutionVersion,
          }
        : {}),
  }));
  const inManifest = new Set(files.map((entry) => entry.path));
  for (const entry of files) {
    const classification = classifications?.get(entry.path);
    if (classification === undefined) continue;
    entry.statIdentity = classification.statIdentity;
    entry.excluded = classification.excluded;
  }
  // Files the snapshot iterator excluded are classified but never reach the
  // manifest. Persist their classifications as standalone entries — the walk
  // saw them this cycle, so this resurrects nothing deleted and changes no
  // identity decision; it only lets the next cycle's exclusion callback skip
  // the read+parse. Their sha never matches a live file, so a later re-include
  // is a cache miss and cold re-parse.
  for (const [pathName, classification] of classifications ?? []) {
    if (inManifest.has(pathName)) continue;
    files.push({
      ...(loaded?.get(pathName) ?? { path: pathName, sha256: "" }),
      statIdentity: classification.statIdentity,
      excluded: classification.excluded,
    });
  }
  if (
    loaded !== undefined &&
    loaded.size === files.length &&
    files.every((entry) => {
      const previous = loaded.get(entry.path);
      if (previous === undefined) return false;
      if (previous.sha256 !== entry.sha256) return false;
      if (previous.memory !== entry.memory) return false;
      if ((previous.normalizerVersion ?? undefined) !== (entry.normalizerVersion ?? undefined)) return false;
      if ((previous.identityResolutionVersion ?? undefined) !== (entry.identityResolutionVersion ?? undefined)) {
        return false;
      }
      if ((previous.statIdentity ?? undefined) !== (entry.statIdentity ?? undefined)) return false;
      return (previous.excluded ?? undefined) === (entry.excluded ?? undefined);
    })
  ) {
    return;
  }
  try {
    await withCacheWriteLock(cachePath, async () => {
      // Merge with the current on-disk set under the lock: another run may
      // have published entries after this one loaded its snapshot.
      const merged = new Map(files.map((entry) => [entry.path, entry]));
      const dropped = new Set(
        [...(loaded?.keys() ?? [])].filter((pathName) => !merged.has(pathName))
      );
      try {
        const raw = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as {
          citationTemplate?: string;
          files?: unknown[];
        };
        if (raw.citationTemplate === citationTemplateFingerprint(citationTemplate)) {
          for (const candidate of raw.files ?? []) {
            const entry = candidate as Partial<ConvergeIdentityCacheEntry> | null;
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
                    ...(typeof entry.normalizerVersion === "number"
                      ? { normalizerVersion: entry.normalizerVersion }
                      : {}),
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
        // missing or corrupt current cache: the write set stands alone
      }
      const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(
        tmp,
        JSON.stringify({
          citationTemplate: citationTemplateFingerprint(citationTemplate),
          files: [...merged.values()],
        })
      );
      await fs.promises.rename(tmp, cachePath);
    });
  } catch {
    // best-effort; a failed write only costs a cold build
  }
}
