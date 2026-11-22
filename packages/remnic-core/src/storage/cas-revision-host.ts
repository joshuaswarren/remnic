import { log } from "../logger.js";
import {
  CasRevisionStore,
  type CasRevisionReadStatus,
  type CasRevisionTransaction,
} from "./cas-revision-store.js";

export class CasRevisionHost extends CasRevisionStore {
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

  async beginRevision(
    pathname: string,
    expectedContent?: string | Buffer | null,
  ): Promise<CasRevisionTransaction> {
    await this.recoverPendingRevision(pathname);
    return await this.beginRevisionTransaction(pathname, expectedContent);
  }

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
