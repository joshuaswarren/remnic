import * as fs from "node:fs";
import * as path from "node:path";
import type { ReconcileManifest, ReconcileMemoryIdentity } from "@remnic/core/reconcile/manifest.js";

export interface ConvergeIdentityCacheEntry {
  path: string;
  sha256: string;
  memory?: ReconcileMemoryIdentity;
}

/** Load the persistent parsed-identity cache for a (peer, namespace) pair.
 * Entries are keyed by path and validated by content sha at use time (the
 * manifest builder checks `cached.sha256 === file.sha256` plus normalizer
 * and identity-resolution versions), so a stale or corrupt file can only
 * cost a cold re-parse, never a wrong identity. */
export async function loadConvergeIdentityCache(
  cachePath: string | undefined
): Promise<Map<string, ConvergeIdentityCacheEntry>> {
  const cache = new Map<string, ConvergeIdentityCacheEntry>();
  if (!cachePath) return cache;
  try {
    const raw = JSON.parse(await fs.promises.readFile(cachePath, "utf8")) as {
      files?: ConvergeIdentityCacheEntry[];
    };
    for (const entry of raw.files ?? []) {
      if (typeof entry?.path === "string" && typeof entry.sha256 === "string") cache.set(entry.path, entry);
    }
  } catch {
    // missing or corrupt cache: cold build
  }
  return cache;
}

/** Persist the parsed identities of a built manifest atomically. */
export async function saveConvergeIdentityCache(
  cachePath: string | undefined,
  manifest: ReconcileManifest
): Promise<void> {
  if (!cachePath) return;
  const files: ConvergeIdentityCacheEntry[] = manifest.files
    .filter((file) => file.memory !== undefined)
    .map((file) => ({ path: file.path, sha256: file.sha256, memory: file.memory }));
  const tmp = `${cachePath}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ files }));
    await fs.promises.rename(tmp, cachePath);
  } catch {
    // best-effort; a failed write only costs a cold build
  }
}
