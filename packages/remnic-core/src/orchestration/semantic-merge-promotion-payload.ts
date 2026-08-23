/**
 * Merged-target promotion payload builder (issue #2330, rounds final/N+18).
 * Sibling of semantic-merge-persist.ts — extracted there so that file stays
 * within its file-size ratchet. Everything here derives from the re-read
 * COMMITTED record; nothing reads the incoming extraction.
 */

import { parseOriginClass } from "../security/origin-authority.js";
import { log } from "../logger.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import type { StorageManager } from "../index.js";
import type {
  ImportanceScore,
  MemoryFile,
  MemoryFrontmatter,
  MemorySubject,
  ProvenanceSource,
} from "../types.js";

/**
 * The merged-target promotion payload (final round): EVERY field the
 * shared/profile copy is stamped from, taken wholesale off the re-read
 * committed record — no field on the promotion path reads the incoming
 * extraction. `origin` is normalized through `parseOriginClass` so an
 * unstamped legacy target promotes as `unknown`, the fence's
 * least-privilege default, and never falls back to the extraction's own
 * origin. Absent optional fields stay absent: a target without temporal
 * bounds or attributes promotes a copy without them. The record's
 * confidence is the downgraded min(incoming, target) value the merge
 * patch stamped (final round A), so the copy stamps that same value. The
 * tool-scope marker and owning connector ride along (finding A) so the
 * promotion's withhold gate evaluates the record's committed scope, not a
 * fresh content-heuristic guess over the merged body.
 */
export interface MergedTargetPromotionPayload {
  category: string;
  content: string;
  confidence: number;
  tags: string[];
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
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
  /** Normalized committed origin; never undefined, so the envelope's extraction fallback cannot fire. */
  origin: string;
  sources?: ProvenanceSource[];
  provenance?: "verified" | "unverified" | "none";
  subject?: MemorySubject;
  /** The committed target's own write provenance label. */
  source: string;
  /** Committed tool-scope marker + owning connector (finding A): the copy must
   * stay withheld from the shared namespace exactly like the record it copies.
   * Re-running the content heuristics over the merged body is not equivalent —
   * the judge-composed text can drop the tool references that earned the
   * target its marker at write time, and without the connector the heuristic
   * returns false outright. */
  toolScoped?: true;
  sourceConnector?: string;
  /**
   * The committed record's CAS revision token at payload-build time (round
   * N+15 A, #2807) — the dedicated sidecar identity, never public
   * `frontmatter.updated`. The payload is a CACHE: before promoting it, the
   * caller re-reads the record and confirms the token AND body still match —
   * a writer that merged the same target again in between makes this
   * payload stale, and a stale body must never be promoted or become the
   * reconciliation canon.
   */
  committedRevision?: string;
  /** #2813 (P1 B): sha256 hex digest of the durable memory file when committed. */
  committedDigest?: string;
}

/**
 * #2807 (finding 1): the builder's null has two meanings the caller must
 * not conflate. A REFUSED payload (degraded merge, target replaced
 * mid-flight, retired record) means "no promotion is warranted" — the
 * caller's destructive reconciliation may proceed on that conclusion. A
 * payload that is UNKNOWN because the post-commit reread itself failed
 * means no such conclusion was reached, so `readFailed` preserves the
 * failure reason across the call boundary.
 */
export interface MergedTargetPromotionResult {
  payload: MergedTargetPromotionPayload | null;
  /** True when `payload` is null because the reread threw OR the CAS receipt
   * sidecar was unreadable (#2813 P1 A) — the payload is unknown, not refused. */
  readFailed: boolean;
}

/**
 * Re-read the committed merge target (cold-aware id lookup — the same
 * resolver the merge itself used) and derive the promotion payload solely
 * from that record. Returns a null payload when the record can no longer
 * ground the promotion (deleted, its body was replaced after the merge
 * committed, or a concurrent lifecycle operation archived/superseded it
 * between the merge commit and this reread — promoting from a retired
 * record would resurrect content that operation retired, final round B),
 * and null for a degraded merge whose provenance patch never landed (round
 * N+7 A) — the gate every trust-elevating consumer routes through; callers
 * then skip the promotion fail-open — the merge itself stands. Round N+18
 * (B): the reread itself is isolated fail-open — a locked secure store or
 * a corpus read I/O error resolves to a null payload with `readFailed:
 * true` and a logged warn rather than a rejection, because the merge has
 * already committed and the hash-index repair makes any retry dedupe
 * against the committed body; an uncaught throw here would strand every
 * remaining durable effect (thread episode, temporal/tag refresh, harmonic
 * construction, graph rebuild, behavior signals, artifact write). #2807:
 * the failure reason rides out on the result so reconciliation can tell an
 * unknown payload from a refused one.
 */
export async function buildMergedTargetPromotionPayload(
  storage: StorageManager,
  merge: { targetId: string; mergedContent: string; provenancePatched: boolean },
): Promise<MergedTargetPromotionResult> {
  // Round N+7 (A): a degraded merge's record still holds its pre-merge
  // confidence, provenance, sources, and hash — a copy built off it would
  // publish incoming claims under that stronger metadata. No promotion may
  // be constructed from an unpatched provenance record.
  if (!merge.provenancePatched) {
    log.warn(
      `semantic-merge: skipping merged-target promotion for ${merge.targetId} — provenance patch did not land; the record still holds pre-merge trust metadata`,
    );
    return { payload: null, readFailed: false };
  }
  let committed: MemoryFile | null;
  try {
    committed = await storage.getMemoryByIdIncludingArchived(merge.targetId);
  } catch (err) {
    // Round N+18 (B): fail-open with a notice, like the artifact helper.
    log.warn(
      `semantic-merge: merged-target promotion reread failed for ${merge.targetId} (non-fatal; promotion skipped, the committed merge stands): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { payload: null, readFailed: true };
  }
  if (!committed || committed.content !== merge.mergedContent) {
    return { payload: null, readFailed: false };
  }
  // Final round (B): the including-archived lookup still returns a retired
  // record, and body equality alone cannot tell a concurrent archive or
  // supersede apart from a live target. Recompute the status from the
  // committed record itself and refuse to promote unless it is still
  // active.
  if (inferMemoryStatus(committed.frontmatter, committed.path) !== "active") {
    return { payload: null, readFailed: false };
  }
  const fm = committed.frontmatter;
  // #2813 (P1 B): promotion reads record metadata and digest, then receipt.
  // Compare record snapshot digest to receipt's committed digest to catch
  // interleaving metadata writers with same body/new metadata.
  const snapshotDigest =
    typeof storage.readDurableFileDigest === "function"
      ? await storage.readDurableFileDigest(committed.path).catch(() => null)
      : null;
  const receipt = await readPromotionReceiptStatus(storage, committed.path);
  if (!receipt.available) {
    log.warn(
      `semantic-merge: merged-target promotion refused for ${merge.targetId} — the CAS revision receipt for ${committed.path} is unavailable (${receipt.reason}); promotion and reconciliation retry on the next merge`,
    );
    return { payload: null, readFailed: true };
  }
  if (
    receipt.committedDigest !== undefined &&
    snapshotDigest !== null &&
    snapshotDigest !== receipt.committedDigest
  ) {
    log.warn(
      `semantic-merge: merged-target promotion refused for ${merge.targetId} — record snapshot digest (${snapshotDigest}) does not match committed receipt digest (${receipt.committedDigest}); record metadata was mutated concurrently`,
    );
    return { payload: null, readFailed: true };
  }
  return {
    payload: {
      category: fm.category,
      content: committed.content,
      confidence: fm.confidence,
      tags: fm.tags ?? [],
      sourceMemoryId: fm.id,
      origin: parseOriginClass(fm.origin),
      source: fm.source,
      ...(fm.entityRef !== undefined ? { entityRef: fm.entityRef } : {}),
      ...(fm.structuredAttributes !== undefined
        ? { structuredAttributes: { ...fm.structuredAttributes } }
        : {}),
      ...(fm.importance !== undefined ? { importance: fm.importance } : {}),
      ...(fm.intentGoal !== undefined ? { intentGoal: fm.intentGoal } : {}),
      ...(fm.intentActionType !== undefined ? { intentActionType: fm.intentActionType } : {}),
      ...(fm.intentEntityTypes !== undefined
        ? { intentEntityTypes: [...fm.intentEntityTypes] }
        : {}),
      ...(fm.memoryKind !== undefined ? { memoryKind: fm.memoryKind } : {}),
      ...(fm.valid_at !== undefined ? { validAt: fm.valid_at } : {}),
      ...(fm.invalid_at !== undefined ? { invalidAt: fm.invalid_at } : {}),
      ...(fm.observedAt !== undefined ? { observedAt: fm.observedAt } : {}),
      ...(fm.eventTimeSource !== undefined ? { eventTimeSource: fm.eventTimeSource } : {}),
      ...(fm.sources && fm.sources.length > 0
        ? { sources: fm.sources.map((source) => ({ ...source })) }
        : {}),
      ...(fm.provenance !== undefined ? { provenance: fm.provenance } : {}),
      ...(fm.subject !== undefined ? { subject: fm.subject } : {}),
      ...(fm.toolScoped === true ? { toolScoped: true as const } : {}),
      ...(fm.sourceConnector !== undefined ? { sourceConnector: fm.sourceConnector } : {}),
      ...(receipt.revision !== undefined ? { committedRevision: receipt.revision } : {}),
      ...(receipt.committedDigest !== undefined
        ? { committedDigest: receipt.committedDigest }
        : snapshotDigest !== null
          ? { committedDigest: snapshotDigest }
          : {}),
    },
    readFailed: false,
  };
}

/** #2813 (P1 A): read the standing receipt as a three-way truth for the
 * promotion path. Present and absent are usable identities (absent = the
 * target predates the sidecar); unavailable is not. A storage whose status
 * probe itself throws reads as unavailable — never as absence. */
export async function readPromotionReceiptStatus(
  storage: Pick<StorageManager, "readCasRevisionStatus">,
  filePath: string,
): Promise<
  | { available: true; revision: string | undefined; committedDigest?: string }
  | { available: false; reason: string }
> {
  try {
    const status = await storage.readCasRevisionStatus(filePath);
    if (status.status === "unavailable") return { available: false, reason: status.reason };
    return {
      available: true,
      revision: status.status === "present" ? status.revision : undefined,
      committedDigest: status.status === "present" ? status.committedDigest : undefined,
    };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
