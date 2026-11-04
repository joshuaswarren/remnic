/**
 * Promotion destination writes under the fact-dedup commit window (codex P2,
 * PRRT_kwDORJXyws6zzdG4 / #3311). The persist-time promotion gates run
 * OUTSIDE the window that serializes source writes, so with
 * extractionQueueConcurrency > 1 two sessions promoting the same fact from
 * different source namespaces can both gate-miss and both write the shared
 * destination — duplicate active copies, because writeMemory mints a fresh id
 * per write and does not coalesce active duplicates. This module wraps each
 * promotion destination write in `persistUnderFactDedupWindow` keyed on the
 * DESTINATION storage dir and rechecks with the same connector/content
 * predicate the promotion gates confirm with, so a twin promotion committed
 * between the gate and the write is suppressed instead of duplicated.
 *
 * Split out of extraction-persist.ts for the structural ratchet (#1995);
 * behavior is a verbatim move of the wrapped writes the persist closure
 * previously inlined.
 */

import { ContentHashIndex, type StorageManager } from "../index.js";
import { log } from "../logger.js";
import type { ImportanceScore, MemoryFile, MemoryFrontmatter, ProvenanceSource } from "../types.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";
import type { SealedWriteExtras } from "../storage.js";
import { normalizeStoredHashSource } from "./extraction-persist-citation.js";
import { readActiveMemoriesBothTiers } from "./extraction-persist-promotion.js";
import { normalizeSupersessionKey } from "../temporal-supersession.js";
import { persistUnderFactDedupWindow, type FactDedupWindowOutcome } from "./fact-dedup-window.js";

/**
 * The promotion fields the windowed write and its suppression-path bounds
 * backfill read. Structurally satisfied by both promotion closures' options
 * objects in extraction-persist.ts (profile-target and shared).
 */
export interface PromotionDedupWriteFields {
  category: string;
  sourceMemoryId: string;
  importance?: ImportanceScore;
  intentGoal?: string;
  intentActionType?: string;
  intentEntityTypes?: string[];
  memoryKind?: MemoryFrontmatter["memoryKind"];
  validAt?: string;
  invalidAt?: string;
  observedAt?: string;
  eventTimeSource?: "extracted" | "assumed";
  sources?: ProvenanceSource[];
  provenance?: "verified" | "unverified" | "none";
  toolScoped?: true;
}

export interface PromotionDedupWriteArgs {
  /** Promotion DESTINATION storage — the commit window is keyed on its dir. */
  destination: StorageManager;
  /** Composed sealed envelope for the promoted copy. */
  envelope: SealedMemoryEnvelope;
  /** The promotion closure's options (read structurally). */
  promotion: PromotionDedupWriteFields;
  /** Fact hash-key content (attrs-suffixed); pre-citation raw for others. */
  dedupContent: string;
  rawContent: string;
  /** promotionWithholdsToolScope() result (shared) / forwarded marker (profile). */
  toolScoped: boolean;
  /** Raw source connector: trimmed for the recheck, raw for bounds backfill. */
  connector: string | undefined;
  citationEnabled: boolean;
  citationTemplate: string;
  /** lifecycleCaps.temporalSupersession on the shared path; false on the
   *  profile path (its gate predicate has no entity filter). When true AND the
   *  envelope carries an entityRef with non-empty surviving attrs, the recheck
   *  additionally requires the same entity (PR #402 Uybg guard parity). */
  sameEntityGuardEnabled: boolean;
  /** Envelope-surviving structured attributes (PR #402 Uybg guard input). */
  survivingAttrs?: Record<string, string> | null;
  backfillTemporalBoundsOnDedupHit: ExtractionPersistDeps["backfillTemporalBoundsOnDedupHit"];
}

type ExtractionPersistDeps = {
  backfillTemporalBoundsOnDedupHit: (
    targetStorage: StorageManager,
    dedupContent: string,
    bounds: {
      invalidAt?: string;
      validFrom?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
    },
    entityRef?: string,
    sourceConnector?: string,
  ) => Promise<void>;
};

/**
 * In-window race confirm for a promotion destination: same connector/content
 * predicate the promotion gates confirm with (`readActiveMemoriesBothTiers` +
 * citation-aware stored normalization vs the normalized dedup key). The
 * optional entity key mirrors the shared supersession branch's same-entity
 * guard (PR #402 Uybg) so cross-entity same-content facts stay distinct.
 * Fail-open on scan error: an unverifiable state never suppresses.
 */
export async function confirmPromotionRaceDuplicate(args: {
  storage: StorageManager;
  dedupContent: string;
  category: string;
  connector: string | undefined;
  citationEnabled: boolean;
  citationTemplate: string;
  entityKeyNorm?: string;
}): Promise<boolean> {
  try {
    const allMems = await readActiveMemoriesBothTiers(args.storage);
    const nc = args.connector?.trim() || undefined;
    const incomingNormalized = ContentHashIndex.normalizeContent(args.dedupContent);
    return allMems.some((m: MemoryFile) => {
      if (m.frontmatter.category !== args.category) return false;
      if ((m.frontmatter.status ?? "active") !== "active") return false;
      if (
        normalizeStoredHashSource(m.content ?? "", args.citationEnabled, args.citationTemplate) !==
        incomingNormalized
      )
        return false;
      if (args.entityKeyNorm !== undefined) {
        if (!m.frontmatter.entityRef) return false;
        if (normalizeSupersessionKey(m.frontmatter.entityRef) !== args.entityKeyNorm) return false;
      }
      return (m.frontmatter.sourceConnector?.trim() || undefined) === nc;
    });
  } catch (err) {
    log.warn(
      `promotion race recheck scan failed for ${args.storage.dir}; writing fail-open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Presence-iff-set extras, byte-equivalent to the conditional spreads the
 * persist closure previously inlined at both promotion call sites.
 */
function buildPromotionWriteOptions(args: PromotionDedupWriteArgs): SealedWriteExtras {
  const { promotion } = args;
  const writeOptions: SealedWriteExtras = {
    importance: promotion.importance,
    lineage: [promotion.sourceMemoryId],
    sourceMemoryId: promotion.sourceMemoryId,
    intentGoal: promotion.intentGoal,
    intentActionType: promotion.intentActionType,
    intentEntityTypes: promotion.intentEntityTypes,
    memoryKind: promotion.memoryKind,
    contentHashSource: promotion.category === "fact" ? args.dedupContent : args.rawContent,
  };
  if (promotion.invalidAt) writeOptions.invalidAt = promotion.invalidAt;
  // #1578 — forward bi-temporal bounds + ingestion provenance.
  if (promotion.observedAt) writeOptions.observedAt = promotion.observedAt;
  if (promotion.eventTimeSource) writeOptions.eventTimeSource = promotion.eventTimeSource;
  if (promotion.sources && promotion.sources.length > 0) writeOptions.sources = promotion.sources;
  if (promotion.provenance) writeOptions.provenance = promotion.provenance;
  if (args.toolScoped) writeOptions.toolScoped = true;
  return writeOptions;
}

/**
 * Run one promotion destination write inside the destination-dir fact-dedup
 * commit window: recheck (facts only; the same confirm the persist-time gate
 * used, now under the lock) and suppress as a duplicate when a concurrent
 * promotion committed the same content first. A suppressed promotion backfills
 * temporal bounds onto the winning copy (#1671 parity with the gates' skip
 * paths) and reports `{ suppressed: true }`. Lock contention throws
 * fail-closed to the caller — never an unlocked write; the durable source
 * fact is unaffected.
 */
export async function writePromotionUnderFactDedupWindow(
  args: PromotionDedupWriteArgs,
): Promise<FactDedupWindowOutcome<Awaited<ReturnType<StorageManager["writeSealedMemory"]>>>> {
  const { destination, envelope, promotion } = args;
  const entityKeyNorm =
    args.sameEntityGuardEnabled &&
    envelope.entityRef &&
    args.survivingAttrs &&
    Object.keys(args.survivingAttrs).length > 0
      ? normalizeSupersessionKey(envelope.entityRef)
      : undefined;
  const outcome = await persistUnderFactDedupWindow(
    destination.dir,
    () =>
      promotion.category === "fact"
        ? confirmPromotionRaceDuplicate({
            storage: destination,
            dedupContent: args.dedupContent,
            category: promotion.category,
            connector: args.connector,
            citationEnabled: args.citationEnabled,
            citationTemplate: args.citationTemplate,
            entityKeyNorm,
          })
        : Promise.resolve(false),
    () => destination.writeSealedMemory(envelope, buildPromotionWriteOptions(args)),
  );
  if (outcome.suppressed) {
    log.info(`dedup: raced promotion duplicate suppressed in fact-dedup window for ${destination.dir}`);
    if (promotion.invalidAt || promotion.validAt) {
      await args.backfillTemporalBoundsOnDedupHit(
        destination,
        args.dedupContent,
        {
          invalidAt: promotion.invalidAt,
          // #1707 thread 2 — carry the corrected start bound.
          validFrom: promotion.validAt,
          observedAt: promotion.observedAt,
          eventTimeSource: promotion.eventTimeSource,
        },
        envelope.entityRef,
        args.connector,
      );
    }
  }
  return outcome;
}
