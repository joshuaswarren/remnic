import path from "node:path";
import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import { ContentHashIndex, type StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import { normalizeStoredHashSource } from "./extraction-persist-citation.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import { log } from "../logger.js";

/**
 * Fact-dedup commit window (codex P2, #1526): with extractionQueueConcurrency
 * > 1 (or daemon + external drain workers), two sessions can both pass the
 * content-hash check at persist time and both write, producing duplicate
 * active copies — the persist-time checks run well before the write, and
 * writeMemory mints a fresh id per write. This module serializes the short
 * "final recheck → write" window per storage dir (in-process chain +
 * fail-closed cross-process fact-dedup.lock, mirroring the profile/meta lock
 * shape: bounded, no LLM or corpus-scale work planned inside, throw BEFORE
 * any read/write when the lock is not acquired). The persist-time check stays
 * OUTSIDE the window exactly like the consolidation LLM call stays outside
 * commitConsolidatedProfile.
 */

interface FactDedupMatchOptions {
  readonly category: string;
  readonly contentHashDedupKey: string;
  readonly connector?: string;
  readonly citationEnabled: boolean;
  readonly citationTemplate: string;
}

function matchesActiveConnectorDuplicate(memory: MemoryFile, opts: FactDedupMatchOptions): boolean {
  if (memory.frontmatter.category !== opts.category) return false;
  if ((memory.frontmatter.status ?? "active") !== "active") return false;
  // Thread 5 (QPDE5): for procedures the hash is keyed on the full
  // body (title + steps via buildProcedurePersistBody), so compare
  // against contentHashDedupKey — not the canonical title-only form.
  // Thread 3 (QO42V): facts with structuredAttributes get an appended
  // [Attributes: ...] suffix in the stored body that the hash key lacks;
  // strip it before comparing so same-connector enriched facts dedup
  // correctly.
  if (normalizeStoredHashSource(stripAttributesSuffix(memory.content ?? ""), opts.citationEnabled, opts.citationTemplate) !==
    ContentHashIndex.normalizeContent(opts.contentHashDedupKey)) return false;
  return (memory.frontmatter.sourceConnector?.trim() || undefined) === opts.connector;
}

/**
 * Connector-aware duplicate confirm: same final semantics as the persist-time
 * check — an authoritative index miss is a clean NOT-duplicate, a hash hit or
 * a non-authoritative/failed lookup must be confirmed against the hot+cold
 * corpus (same category, active, same normalized content, same connector),
 * and a corpus-scan failure fails OPEN so an unverifiable state cannot
 * silently drop content.
 */
export async function confirmActiveFactDuplicate(
  storage: StorageManager,
  opts: FactDedupMatchOptions,
): Promise<boolean> {
  try {
    // One lookup returns the MISS together with the authority behind it, so a
    // stale MISS is never paired with authority from another moment: any
    // second read of authority can rebuild the index and bless it (#3312).
    const lookup = await storage.lookupContentHash(opts.contentHashDedupKey);
    if (!lookup.present && lookup.authoritative) return false;
  } catch {
    // Dedup lookup failed (e.g. the authoritative rebuild could not run). Do
    // NOT fail-open into a possible duplicate — confirm against the corpus.
  }
  try {
    // #2016 cold-tier finding: the authoritative content-hash rebuild unions
    // the HOT and COLD tiers, so a cold-only active copy must still confirm
    // the duplicate and suppress the redundant hot write.
    const [hotMems, coldMems] = await Promise.all([
      storage.readAllMemories(),
      storage.readAllColdMemories(),
    ]);
    return hotMems.some((m) => matchesActiveConnectorDuplicate(m, opts)) ||
      coldMems.some((m) => matchesActiveConnectorDuplicate(m, opts));
  } catch (err) {
    log.warn(
      `connector-aware dedup scan failed for storage ${storage.dir}; writing fail-open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export type FactDedupWindowOutcome<T> = { suppressed: true } | { suppressed: false; result: T };

/**
 * Run `write` inside the per-dir fact-dedup window: recheck `recheck` (the
 * SAME confirm used at persist time, now under the lock) and suppress as a
 * duplicate when a concurrent session committed the same content first;
 * otherwise write. Lock contention throws (fail closed) — never an unlocked
 * write; the extraction retry path retains the accepted turns.
 */
export async function persistUnderFactDedupWindow<T>(
  storageDir: string,
  recheck: () => Promise<boolean>,
  write: () => Promise<T>,
): Promise<FactDedupWindowOutcome<T>> {
  return serializeMutations(`fact-dedup:${storageDir}`, () =>
    withHeldFileLock(
      path.join(storageDir, "fact-dedup.lock"),
      // Bounded: the window holds one corpus confirm + one memory write, not a
      // scan-length lock (catalog round 5 adoption note).
      { staleMs: 5_000, maxWaitMs: 2_000, pollMs: 50 },
      async (acquired) => {
        if (!acquired) {
          throw new Error(`fact write skipped: fact-dedup.lock not acquired (${storageDir})`);
        }
        if (await recheck()) return { suppressed: true };
        return { suppressed: false, result: await write() };
      },
    ),
  );
}
