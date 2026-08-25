import { log } from "../logger.js";
import {
  CasRevisionStore,
  type CasRevisionReadStatus,
  type CasRevisionTransaction,
} from "./cas-revision-store.js";

/**
 * StorageManager CAS receipt host (#2813 / #2807).
 * Owns fail-open reads, lazy pending recovery, durable digest, and begin-revision.
 * Tests patch the inherited CasRevisionStore seam on `casRevisions`.
 */
export class CasRevisionHost extends CasRevisionStore {
  /** Standing CAS revision token — receipt identity, never public `updated` (#2807). Fail-open on read errors. */
  async readCasRevision(filePath: string): Promise<string | undefined> {
    try {
      return await this.readRevision(filePath);
    } catch (err) {
      log.warn(`storage.readCasRevision failed for ${filePath}: ${err}`);
      return undefined;
    }
  }

  /** #2813 (P1 A): truthful CAS receipt probe — distinguishes a genuinely
   * ABSENT receipt (target predates the sidecar; `undefined` semantics stay
   * correct) from an UNAVAILABLE one (unreadable shard: receipt identity is
   * unknown). Transactional callers that must refuse on unknown identity
   * route here; `readCasRevision` stays fail-open for advisory reads.
   * #2807 (P1): a PENDING marker left by a crash is lazily recovered on
   * this first read when its evidence is decisive; a reserve-only marker
   * may belong to a live writer and defers to the path-locked write path,
   * and ambiguity stays `unavailable` with an actionable reason. */
  async readCasRevisionStatus(filePath: string): Promise<CasRevisionReadStatus> {
    const status = await this.readRevisionStatus(filePath);
    if (status.status !== "unavailable" || !/pending/i.test(status.reason)) return status;
    // #2807: an evidenced PENDING marker (its write already landed) is
    // lazily recovered here. A reserve-only marker may belong to a LIVE
    // transaction — this read holds no capture path lock — so it is left
    // for the path-locked write path, which cannot race the owner.
    try {
      const outcome = await this.recoverPendingRevision(filePath, {
        onlyWithWriteEvidence: true,
      });
      if (outcome === "reserved") return status;
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return await this.readRevisionStatus(filePath);
  }

  async readDurableFileDigest(filePath: string): Promise<string | null> {
    try {
      return await this.digestDurableFile(filePath);
    } catch (err) {
      log.warn(`storage.readDurableFileDigest failed for ${filePath}: ${err}`);
      return null;
    }
  }

  /** #2807 (P1): reconcile any crash-orphaned PENDING marker for this
   * target BEFORE the next semantic mutation reserves a new token —
   * otherwise a crashed reservation would make the memory permanently
   * unwritable. Decisive evidence heals; ambiguity throws so the
   * mutation fails closed with the actionable recovery error. */
  async beginRevision(
    pathname: string,
    expectedContent?: string | Buffer | null,
  ): Promise<CasRevisionTransaction> {
    await this.recoverPendingRevision(pathname);
    return await this.beginRevisionTransaction(pathname, expectedContent);
  }

  /** #2837: best-effort post-deletion sweep of the target's receipt shard.
   * The durable memory file is already gone, so a failed sweep must never
   * fail the deletion itself — it logs instead. A PENDING shard (crash
   * recovery evidence) and a foreign shard (another target's receipt) are
   * kept, with a warning naming the recovery path. */
  async sweepShardAfterDeletion(filePath: string): Promise<void> {
    try {
      const outcome = await this.removeRevisionShard(filePath);
      if (outcome === "pending") {
        log.warn(
          `CAS revision shard for ${filePath} kept after memory deletion: a pending reservation stands — run recovery before the path is reused`,
        );
      } else if (outcome === "foreign") {
        log.warn(
          `CAS revision shard for ${filePath} kept after memory deletion: the shard names another target`,
        );
      }
    } catch (err) {
      log.warn(`failed to sweep CAS revision shard for deleted memory ${filePath}: ${err}`);
    }
  }
}
