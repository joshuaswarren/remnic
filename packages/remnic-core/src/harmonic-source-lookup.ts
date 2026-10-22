import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { throwIfAborted } from "./abort-error.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-store.js";
import { readProjectedMemoryPaths } from "./memory-projection-batch.js";
import { SecureStoreLockedError } from "./secure-store/secure-fs.js";
import { isPathInsideStorageRoot, isSafeLegacyPathSegment } from "./storage-paths.js";
import { isRecord } from "./store-contract.js";
import type { StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";
import { RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";

const LOOKUP_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 4096;
type PathEntry = { path: string | null; expiresAt: number };

/** Direct and cached probes must retain the walk's realpath containment check. */
export async function readHarmonicSourceMemory(
  storage: StorageManager,
  rootReal: string,
  filePath: string,
  abortSignal?: AbortSignal,
): Promise<MemoryFile | null> {
  throwIfAborted(abortSignal, "harmonic retrieval aborted");
  if (!existsSync(filePath)) return null;
  try {
    if (!isPathInsideStorageRoot(rootReal, await realpath(filePath))) return null;
    return await storage.readMemoryByPath(filePath);
  } catch (err) {
    throwIfAborted(abortSignal, "harmonic retrieval aborted");
    if (err instanceof SecureStoreLockedError) throw err;
    return null;
  }
}

function isCorpusPath(memoryDir: string, filePath: string): boolean {
  if (!isPathInsideStorageRoot(memoryDir, filePath)) return false;
  const [dir] = path.relative(memoryDir, filePath).split(path.sep);
  return dir === "cold" || RECALL_FALLBACK_DIRS.includes(dir);
}

/** A cache miss is not authoritative: unreadable/invalid cache state keeps the walk. */
async function readPathCache(
  filePath: string, rebuiltAt: string, corpusVersion: string, nowMs: number,
): Promise<Map<string, PathEntry>> {
  try {
    const raw = await readJsonFile(filePath);
    if (!isRecord(raw) || raw.rebuiltAt !== rebuiltAt || raw.corpusVersion !== corpusVersion || !Array.isArray(raw.entries)) return new Map();
    const entries = new Map<string, PathEntry>();
    for (const row of raw.entries) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [id, storedPath, expiresAt] = row;
      if (typeof id !== "string" || (storedPath !== null && typeof storedPath !== "string")) continue;
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt > nowMs + LOOKUP_TTL_MS) continue;
      entries.set(id, { path: storedPath, expiresAt });
    }
    return entries;
  } catch {
    return new Map();
  }
}

/** Resolve only unresolved ids; persist paths/absence, never memory content. */
export async function readUnresolvedHarmonicSources(options: {
  storage: StorageManager;
  rootReal: string;
  rebuiltAt: string;
  sourceMemoryIds: string[];
  nowMs: number;
  abortSignal?: AbortSignal;
}): Promise<Map<string, MemoryFile>> {
  const { storage, rootReal, rebuiltAt, nowMs, abortSignal } = options;
  throwIfAborted(abortSignal, "harmonic retrieval aborted");
  const corpusVersion = storage.getCorpusScanVersion();
  const stateDir = path.join(storage.dir, "state");
  const cachePath = path.join(stateDir, "harmonic-source-paths.json");
  const stateReal = await realpath(stateDir).catch(() => null);
  const safeCache = stateReal !== null && isPathInsideStorageRoot(rootReal, stateReal);
  const cache = safeCache ? await readPathCache(cachePath, rebuiltAt, corpusVersion, nowMs) : new Map<string, PathEntry>();
  const found = new Map<string, MemoryFile>();
  const pending = new Set<string>();
  for (const id of options.sourceMemoryIds) {
    throwIfAborted(abortSignal, "harmonic retrieval aborted");
    const entry = cache.get(id);
    if (entry?.path === null) continue;
    if (entry?.path) {
      const candidate = path.resolve(storage.dir, entry.path);
      const memory = isCorpusPath(storage.dir, candidate)
        ? await readHarmonicSourceMemory(storage, rootReal, candidate, abortSignal) : null;
      if (memory?.frontmatter.id === id) {
        found.set(id, memory);
        continue;
      }
    }
    pending.add(id);
  }
  if (pending.size === 0) return found;

  // Opaque legacy ids previously used the full scan, including edited projected files.
  const inspectProjected = [...pending].some((id) => !isSafeLegacyPathSegment(id));
  const projectedPaths = readProjectedMemoryPaths(storage.dir);
  const walked = [
    ...(await storage.collectActiveMemoryPaths({ abortSignal, propagateReadErrors: true })),
    ...(await storage.collectColdMemoryPaths({ abortSignal, propagateReadErrors: true })),
  ];
  for (const filePath of walked) {
    throwIfAborted(abortSignal, "harmonic retrieval aborted");
    // Existing projected files need no parse unless their filename names a wanted id.
    // New/imported files must be keyed by frontmatter id, not their basename (#3188).
    if (!inspectProjected && !pending.has(path.basename(filePath, ".md")) && projectedPaths?.has(filePath)) continue;
    const memory = await readHarmonicSourceMemory(storage, rootReal, filePath, abortSignal);
    if (!memory) continue;
    const id = memory.frontmatter.id;
    if (pending.has(id)) {
      found.set(id, memory);
      cache.set(id, { path: path.relative(storage.dir, filePath), expiresAt: nowMs + LOOKUP_TTL_MS });
    }
  }
  for (const id of pending) {
    if (!found.has(id)) cache.set(id, { path: null, expiresAt: nowMs + LOOKUP_TTL_MS });
  }
  throwIfAborted(abortSignal, "harmonic retrieval aborted");
  // A concurrent mutation must not publish absence for a different corpus epoch.
  if (storage.getCorpusScanVersion() === corpusVersion) {
    try {
      await mkdir(stateDir, { recursive: true });
      if (isPathInsideStorageRoot(rootReal, await realpath(stateDir))) {
        throwIfAborted(abortSignal, "harmonic retrieval aborted");
        // ponytail: atomic last-writer-wins cache; contention can repeat a walk, not lose sources.
        await writeJsonFileAtomic(cachePath, {
          rebuiltAt, corpusVersion,
          entries: [...cache].slice(-MAX_CACHE_ENTRIES).map(([id, entry]) => [id, entry.path, entry.expiresAt]),
        });
      }
    } catch {
      throwIfAborted(abortSignal, "harmonic retrieval aborted");
      // Cache publication is optional; resolved memories remain usable on a read-only store.
    }
  }
  return found;
}
