/**
 * Post-persist entity-reference repair (issue #2213), extracted from
 * storage.ts (#1520 god-file ratchet).
 *
 * Every store-mediated writer that persists an `entityRef` resolves it at
 * the write; when the canonical-id journal moves ACROSS the write (a peer
 * migration publishing between resolve and persist), the repair re-resolves
 * from the caller's ORIGINAL ref and rewrites through the blocked-capture
 * surface. On repair failure the caller-declared rollback runs BEFORE the
 * error propagates (AGENTS.md §14): a caller that reports failure must
 * leave disk in the state peers/caches were told about.
 */
import { unlink } from "node:fs/promises";
import { log } from "../logger.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import * as entityRefs from "./entity-canonical-id-references.js";
import {
  applyTombstoneResurrectionGate,
  type TombstoneMatch,
  type TombstoneStore,
} from "../lifecycle/tombstones.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import { ContentHashIndex } from "./content-hash-index.js";
import { rewriteProjectedMemoryEntityReference } from "../memory-projection-mutations.js";

export interface EntityRefRepairDeps {
  readonly stateDir: string;
  readonly baseDir: string;
  currentHistoricalIds(): Readonly<Record<string, string>>;
  serializeFrontmatter(fm: MemoryFrontmatter): string;
  writeTombstoneBlockedMemory(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
  ): Promise<void>;
  invalidateAllMemoriesCache(): void;
  getTombstoneStore(): Promise<TombstoneStore>;
  tombstonesEnabled(): boolean;
  tombstonesNamespace(): string;
}

export interface EntityRefRepairOptions {
  /** Re-run the add-only resurrection gate under the FINAL ref before the
   * rewrite (chunk writes, where `body` IS the hash source). */
  regateFact?: boolean;
  /** Rollback: rewrite this pre-mutation record on repair failure. */
  onFailRestore?: MemoryFile;
  /** Rollback: unlink a file this mutation created on repair failure. */
  onFailRemove?: string;
}

export class EntityRefRepair {
  constructor(private readonly deps: EntityRefRepairDeps) {}

  /**
   * Shared lookup+apply core for the write-time resurrection gate (#1579 /
   * #2213): fail-open, add-only; writeMemory's gate + chunk-repair re-gate
   * consult this one implementation (rule 43).
   */
  async gate(
    fm: MemoryFrontmatter,
    hashSource: string,
    structuredAttributes?: Record<string, string>,
  ): Promise<TombstoneMatch | null> {
    if (!this.deps.tombstonesEnabled()) return null;
    try {
      const store = await this.deps.getTombstoneStore();
      // Pass EVERY derived key (thread Ociag/Oci-W): emitters register one
      // tombstone per key, so the block can be on any of them.
      const supersessionKeys =
        fm.entityRef && structuredAttributes
          ? supersessionKeysForFact({ entityRef: fm.entityRef, structuredAttributes })
          : [];
      const match = applyTombstoneResurrectionGate(store, fm, {
        normalizedText: ContentHashIndex.normalizeContent(hashSource),
        supersessionKeys,
        namespace: this.deps.tombstonesNamespace(),
      });
      if (match) {
        log.info(
          `tombstone: blocked resurrection of fact ${fm.id} (tier=${match.matchedTier}, tombstone=${match.tombstoneId}, reason=${match.reason})`
        );
      }
      return match;
    } catch (err) {
      // Fail-open (rule 34): a lookup error must not block the write.
      log.warn(`tombstone lookup failed for fact ${fm.id} (fail-open): ${err}`);
      return null;
    }
  }

  /** Post-persist repair delegate — see the references module for semantics. */
  async repair(
    filePath: string,
    fm: MemoryFrontmatter,
    rawRef: string,
    refIds: Readonly<Record<string, string>>,
    body: string,
    opts: EntityRefRepairOptions = {},
  ): Promise<void> {
    const refBeforeRepair = fm.entityRef;
    try {
      await entityRefs.repairEntityRefAfterJournalMove({
        stateDir: this.deps.stateDir,
        currentIds: () => this.deps.currentHistoricalIds(),
        idsAtResolve: refIds,
        rawRef,
        frontmatter: fm,
        rewrite: async () => {
          if (opts.regateFact && fm.category === "fact") {
            await this.gate(fm, body, undefined);
          }
          // Blocked-capture surface: a repair rewrite of a tombstone-blocked
          // record must keep TombstoneBlockedCaptureIndex consistent.
          await this.deps.writeTombstoneBlockedMemory(
            filePath,
            `${this.deps.serializeFrontmatter(fm)}\n\n${body}\n`,
            fm,
            body,
          );
          this.deps.invalidateAllMemoriesCache();
        },
      });
    } catch (err) {
      if (opts.onFailRestore) {
        await this.restore(opts.onFailRestore);
      } else if (opts.onFailRemove) {
        await unlink(opts.onFailRemove).catch(() => undefined);
        this.deps.invalidateAllMemoriesCache();
      }
      throw err;
    }
    await this.syncProjection(fm.id, refBeforeRepair, fm.entityRef);
  }

  /**
   * Restore a record's pre-mutation bytes through the blocked-capture
   * surface when a post-persist repair fails (§14).
   */
  async restore(before: MemoryFile): Promise<void> {
    try {
      await this.deps.writeTombstoneBlockedMemory(
        before.path,
        `${this.deps.serializeFrontmatter(before.frontmatter)}\n\n${before.content}\n`,
        before.frontmatter,
        before.content,
      );
    } catch (restoreErr) {
      log.warn(`failed to restore ${before.frontmatter.id} after repair failure: ${restoreErr}`);
    }
    this.deps.invalidateAllMemoriesCache();
  }

  /**
   * Projection rows written under the pre-repair claimant cannot be restored
   * once the mapping is parked (Codex P1). Fail-open: projection is rebuildable.
   */
  async syncProjection(
    memoryId: string,
    refBefore: string | undefined,
    refAfter: string | undefined,
  ): Promise<void> {
    if (typeof refBefore !== "string" || typeof refAfter !== "string" || refBefore === refAfter) return;
    try {
      await rewriteProjectedMemoryEntityReference(this.deps.baseDir, memoryId, refBefore, refAfter);
    } catch (err) {
      log.warn(`projection entityRef sync failed for ${memoryId}: ${err}`);
    }
  }
}
