import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveSafeStoragePath } from "../storage-paths.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock, type HeldFileLockController } from "../utils/serialize-mutations.js";
import { log } from "../logger.js";
import { isValidManagedStoragePath, nextCasRevisionIso } from "./deletion-revision-store.js";

type CasRevisionShard = {
  version: 1;
  path: string;
  revision: string;
  /** Two-phase receipt state (#2813 P1 C). Absent on pre-two-phase shards,
   * which read as committed. */
  state?: "pending" | "committed";
  /** The standing COMMITTED token the pending reservation replaced. An
   * abort restores it, so a discarded reservation never erases the
   * target's receipt history. */
  previous?: string;
  /** #2807 crash-recovery evidence, pending markers only. sha256 of the
   * durable memory file's BYTES — a fingerprint, never memory content.
   * `baselineDigest` is the fingerprint captured at reserve time; null
   * means the file was absent. Absent on legacy pending markers, which
   * carry no evidence. */
  baselineDigest?: string | null;
  /** #2807: the fingerprint the durable file shows once the reserved
   * write has landed; recorded by `writeLanded` before `commit` publishes.
   * null means the file was absent when the write landed. May also be
   * pre-recorded at reserve from the caller's expected bytes. */
  expectedDigest?: string | null;
  /** True after `writeLanded()` verifies the durable write. New pending
   * markers write false. Absent on legacy pending shards: those treat
   * a present `expectedDigest` as already landed. */
  writeLanded?: boolean;
  /** #2813 (P1 B): sha256 hex digest of the durable memory file when committed. */
  committedDigest?: string | null;
};

type CasRevisionMetadata = {
  version: 1;
  revisions: Array<{ path: string; revision: string }>;
};

/** #2813 (P1 A): truthful outcome of a standing-receipt read.
 * - `present` — the target's standing receipt token.
 * - `absent` — no receipt was ever minted (a pre-sidecar legacy record, or
 *   a fresh target); `undefined` semantics stay correct for those.
 * - `unavailable` — the sidecar could not be read (unreadable, unsafe, or
 *   PENDING finalization), so receipt identity is UNKNOWN. The fail-open
 *   `readRevision` collapses this into `undefined`; callers that transact
 *   on receipt identity MUST refuse instead. */
export type CasRevisionReadStatus =
  | { status: "present"; revision: string; committedDigest?: string }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

/** #2813 (P1 C): a write-ahead receipt transaction. `pendingRevision` is a
 * RESERVATION, never ownership: no reader may attribute the record from it
 * while the marker is pending. `commit` publishes the COMMITTED receipt
 * after the durable memory write lands; `abort` discards the reservation
 * (restoring the previous standing token) when the write failed. If
 * `commit` itself fails after the write, the pending marker REMAINS so
 * readers report recovery-needed and promotion/rollback refuse until
 * {@link CasRevisionStore.reconcilePendingRevision} runs with the known
 * write outcome or {@link CasRevisionStore.recoverPendingRevision} decides
 * from the recorded evidence (#2807). */
export interface CasRevisionTransaction {
  readonly pendingRevision: string;
  /** #2807: record the durable file's post-write fingerprint in the
   * PENDING marker — the crash evidence recovery compares. Call immediately
   * after the durable write lands, before `commit`. */
  writeLanded(): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

type CasShardView =
  | { kind: "missing" }
  | { kind: "foreign" }
  | { kind: "committed"; revision: string; committedDigest?: string; foreign: boolean }
  | {
      kind: "pending";
      revision: string;
      previous?: string;
      foreign: boolean;
      baselineDigest?: string | null;
      expectedDigest?: string | null;
      writeLanded?: boolean;
    };

const CAS_REVISION_LOCK_STALE_MS = 60_000;
const CAS_REVISION_LOCK_MAX_WAIT_MS = 120_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isDigestOrNullOrUndefined(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && SHA256_HEX.test(value);
}

function pendingWriteHasLanded(view: {
  writeLanded?: boolean;
  expectedDigest?: string | null;
}): boolean {
  if (view.writeLanded === true) return true;
  if (view.writeLanded === false) return false;
  return view.expectedDigest !== undefined;
}


/**
 * #2813 (P1, #2807 CI repair): durable per-target CAS receipt identity,
 * SEPARATE from public `frontmatter.updated` (business/event time — the
 * support-passport contract keeps caller values verbatim). A receipt minted
 * here is unique and strictly monotonic per target across content commits
 * and semantic frontmatter writes; rollback ownership compares ONLY this
 * token. Attribution scope is per-path in-process serialization (the
 * capture locks around every CAS); the memory files themselves carry no
 * cross-process write lock, so a cross-process same-path race keeps the
 * last-write-wins outcome the corpus already has.
 *
 * Receipts publish through a TWO-PHASE transaction (#2813 P1 C), because
 * neither single-phase ordering is safe: mint-before-write publishes
 * ownership for a write that can still fail, and mint-after-write leaves a
 * written record with no receipt. Under the per-target shard lock:
 *   1. reserve — the next token is minted and durably recorded as a
 *      PENDING marker (write-ahead), carrying the standing token it
 *      replaced;
 *   2. write — the caller performs the durable memory write;
 *   3. publish — the marker is atomically rewritten COMMITTED.
 * A failed write aborts the reservation (restoring the previous token); a
 * failed publish leaves the PENDING marker standing, which readers must
 * treat as unavailable/recovery-needed — never ownership, never absence —
 * so promotion and rollback refuse until recovery reconciles.
 *
 * Every sidecar path (shard, lock, temporary) is resolved through
 * {@link resolveSafeStoragePath} (#2813 P1 A): a symlinked
 * `.offline-sync/cas-revisions` directory — or any symlinked ancestor that
 * escapes the memory root — is rejected before any lock, read, rename, or
 * unlink, so sidecar traffic can never be redirected outside the root.
 */
export class CasRevisionStore {
  private readonly baseDir: string;
  private readonly legacyMetadataPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    // Legacy global metadata location for backward-compatible fallback reads.
    this.legacyMetadataPath = path.join(baseDir, ".offline-sync", "cas-revisions.v1.json");
  }

  private parseCasRevisionMetadata(raw: string): Map<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("CAS revision metadata is invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CAS revision metadata is invalid.");
    }
    const root = parsed as Record<string, unknown>;
    if (
      Object.keys(root).sort().join(",") !== "revisions,version" ||
      root.version !== 1 ||
      !Array.isArray(root.revisions)
    ) {
      throw new Error("CAS revision metadata is invalid.");
    }
    const revisions = new Map<string, string>();
    for (const rawEntry of root.revisions) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new Error("CAS revision metadata is invalid.");
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(",") !== "path,revision" ||
        typeof entry.path !== "string" ||
        !isValidManagedStoragePath(entry.path) ||
        typeof entry.revision !== "string" ||
        entry.revision.length === 0 ||
        revisions.has(entry.path)
      ) {
        throw new Error("CAS revision metadata is invalid.");
      }
      revisions.set(entry.path, entry.revision);
    }
    return revisions;
  }

  private async readLegacyMetadata(): Promise<Map<string, string>> {
    const baseDir = path.resolve(this.baseDir);
    const legacyPath = await resolveSafeStoragePath(baseDir, path.relative(baseDir, this.legacyMetadataPath));
    let raw: string;
    try {
      raw = await readFile(legacyPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return new Map();
      throw new Error("CAS revision metadata is unavailable.");
    }
    return this.parseCasRevisionMetadata(raw);
  }

  /** #2813 (P1 A): every sidecar path is resolved (and symlink-audited)
   * inside the memory root before it is used for a lock, read, rename, or
   * unlink. A symlinked `.offline-sync`, `.offline-sync/cas-revisions`, or
   * shard file makes this throw, so no sidecar traffic can follow a link
   * out of the root. */
  private async getSafeShardInfo(relativePath: string): Promise<{ shardPath: string; lockPath: string }> {
    const baseDir = path.resolve(this.baseDir);
    const hash = createHash("sha256").update(relativePath).digest("hex");
    const shardPath = await resolveSafeStoragePath(baseDir, ".offline-sync", "cas-revisions", `${hash}.json`);
    const lockPath = await resolveSafeStoragePath(baseDir, ".offline-sync", "cas-revisions", `${hash}.json.lock`);
    return { shardPath, lockPath };
  }

  private async readShardView(shardPath: string, relativePath: string): Promise<CasShardView> {
    let raw: string;
    try {
      raw = await readFile(shardPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return { kind: "missing" };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("CAS revision shard is unreadable.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "foreign" };
    }
    const root = parsed as Record<string, unknown>;
    if (root.state !== undefined) {
      // Two-phase shard: strict shape. A state-bearing shard that does not
      // validate is corruption — unavailability, never a usable identity.
      if (
        root.version !== 1 ||
        typeof root.path !== "string" ||
        typeof root.revision !== "string" ||
        root.revision.length === 0 ||
        (root.state !== "pending" && root.state !== "committed") ||
        (root.previous !== undefined &&
          (typeof root.previous !== "string" || root.previous.length === 0)) ||
        !isDigestOrNullOrUndefined(root.baselineDigest) ||
        !isDigestOrNullOrUndefined(root.expectedDigest) ||
        (root.writeLanded !== undefined && typeof root.writeLanded !== "boolean")
      ) {
        throw new Error("CAS revision shard is unreadable.");
      }
      const foreign = root.path !== relativePath;
      const committedDigest =
        typeof root.committedDigest === "string" ? root.committedDigest : undefined;
      return root.state === "pending"
        ? {
            kind: "pending",
            revision: root.revision,
            previous: root.previous,
            foreign,
            baselineDigest: root.baselineDigest as string | null | undefined,
            expectedDigest: root.expectedDigest as string | null | undefined,
            ...(typeof root.writeLanded === "boolean" ? { writeLanded: root.writeLanded } : {}),
          }
        : { kind: "committed", revision: root.revision, committedDigest, foreign };
    }
    // Pre-two-phase shard: a full-shape match reads as committed; anything
    // else keeps the legacy fall-through (legacy metadata, then absence).
    if (
      root.version === 1 &&
      root.path === relativePath &&
      typeof root.revision === "string" &&
      root.revision.length > 0
    ) {
      const committedDigest =
        typeof root.committedDigest === "string" ? root.committedDigest : undefined;
      return { kind: "committed", revision: root.revision, committedDigest, foreign: false };
    }
    return { kind: "foreign" };
  }

  private async readStandingRevision(relativePath: string): Promise<string | undefined> {
    try {
      return (await this.readStandingRevisionStrict(relativePath))?.revision;
    } catch (error) {
      log.warn(`CasRevisionStore failed to read standing revision for ${relativePath}: ${error}`);
      return undefined;
    }
  }

  /** #2813 (P1 A): strict core of {@link readStandingRevision}. Returns
   * undefined ONLY when no receipt exists for the target — the shard is
   * absent (or names another target) and the legacy metadata holds no
   * entry. THROWS when the standing receipt cannot be determined: an
   * unreadable or corrupt shard, a PENDING reservation awaiting
   * finalization or recovery, or unreadable or invalid legacy metadata.
   * Fail-open callers collapse the throw into undefined; truthful callers
   * ({@link readRevisionStatus}) report `unavailable` so a transaction can
   * refuse instead of mistaking the failure for absence. */
  private async readStandingRevisionStrict(
    relativePath: string,
  ): Promise<{ revision: string; committedDigest?: string } | undefined> {
    const { shardPath } = await this.getSafeShardInfo(relativePath);
    const view = await this.readShardView(shardPath, relativePath);
    if (view.kind === "pending") {
      throw new Error(
        `CAS revision receipt for ${relativePath} is pending finalization (recovery needed).`,
      );
    }
    if (view.kind === "committed" && !view.foreign) {
      return { revision: view.revision, committedDigest: view.committedDigest };
    }
    const legacyMap = await this.readLegacyMetadata();
    const legacyRev = legacyMap.get(relativePath);
    return legacyRev === undefined ? undefined : { revision: legacyRev };
  }

  private async writeShard(
    shardPath: string,
    relativePath: string,
    revision: string,
    lock: HeldFileLockController,
    state: "pending" | "committed",
    previous?: string,
    evidence?: {
      baselineDigest?: string | null;
      expectedDigest?: string | null;
      committedDigest?: string | null;
      writeLanded?: boolean;
    },
  ): Promise<void> {
    let payload: CasRevisionShard;
    if (state === "committed") {
      payload = { version: 1, path: relativePath, revision, state };
      if (evidence?.committedDigest !== undefined) {
        payload.committedDigest = evidence.committedDigest;
      }
    } else {
      payload = { version: 1, path: relativePath, revision, state };
      if (previous !== undefined) payload.previous = previous;
      if (evidence !== undefined) {
        if (evidence.baselineDigest !== undefined) payload.baselineDigest = evidence.baselineDigest;
        if (evidence.expectedDigest !== undefined) payload.expectedDigest = evidence.expectedDigest;
        if (evidence.writeLanded !== undefined) payload.writeLanded = evidence.writeLanded;
      }
    }
    const baseDir = path.resolve(this.baseDir);
    const temporaryPath = await resolveSafeStoragePath(
      baseDir,
      path.relative(baseDir, `${shardPath}.${process.pid}.${randomUUID()}.tmp`),
    );
    let handle: FileHandle | null = null;
    try {
      await mkdir(path.dirname(shardPath), { recursive: true });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (!(await lock.refresh())) {
        throw new Error("CAS revision shard lock was lost.");
      }
      await rename(temporaryPath, shardPath);
    } finally {
      if (handle !== null) {
        await handle.close().catch((error: unknown) => {
          log.warn("failed to close CAS revision shard temporary file", error);
        });
      }
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isErrnoCode(error, "ENOENT")) {
          log.warn("failed to clean up CAS revision shard temporary file", error);
        }
      });
    }
  }

  private async resolveRelativePath(filePath: string): Promise<string> {
    const baseDir = path.resolve(this.baseDir);
    const target = await resolveSafeStoragePath(baseDir, path.relative(baseDir, path.resolve(baseDir, filePath)));
    return path.relative(baseDir, target).split(path.sep).join("/");
  }

  private async withShardLock<T>(
    relativePath: string,
    task: (lock: HeldFileLockController) => Promise<T>,
  ): Promise<T> {
    const { lockPath } = await this.getSafeShardInfo(relativePath);
    return await withHeldFileLock(
      lockPath,
      { staleMs: CAS_REVISION_LOCK_STALE_MS, maxWaitMs: CAS_REVISION_LOCK_MAX_WAIT_MS },
      async (acquired, lock) => {
        if (!acquired) throw new Error("CAS revision lock is unavailable.");
        return await task(lock);
      },
    );
  }

  /** The target's standing revision token, or undefined when no receipt was
   * ever minted for it. Fail-open on storage/read errors. */
  async readRevision(filePath: string): Promise<string | undefined> {
    try {
      const relativePath = await this.resolveRelativePath(filePath);
      return await this.readStandingRevision(relativePath);
    } catch (error) {
      log.warn(`CasRevisionStore.readRevision failed for ${filePath}: ${error}`);
      return undefined;
    }
  }

  /** #2813 (P1 A): the truthful standing-receipt read. `absent` means no
   * receipt was ever minted for the target — undefined semantics stay
   * correct for those records. `unavailable` means the sidecar could not
   * be read OR a reservation is pending finalization; callers that
   * transact on receipt identity MUST refuse rather than treat the
   * failure as absence. */
  async readRevisionStatus(filePath: string): Promise<CasRevisionReadStatus> {
    try {
      const relativePath = await this.resolveRelativePath(filePath);
      const standing = await this.readStandingRevisionStrict(relativePath);
      return standing === undefined
        ? { status: "absent" }
        : {
            status: "present",
            revision: standing.revision,
            ...(standing.committedDigest !== undefined
              ? { committedDigest: standing.committedDigest }
              : {}),
          };
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** #2813 (P1 C): reserve the NEXT revision token as a durable PENDING
   * marker under the target's shard lock — the write-ahead record of a
   * receipt transaction. The token is strictly greater than the standing
   * token (max(clock, prev + 1ms)), so two commits can never share a
   * receipt — not within one millisecond, not across a backward clock
   * step. Refuses while another reservation is pending (recovery needed)
   * or the standing receipt cannot be determined. The caller MUST either
   * `commit` after its durable write lands or `abort` when it fails.
   * #2807: the marker records the reserve-time fingerprint (`baselineDigest`)
   * and optional expected post-write fingerprint (`expectedDigest`) with
   * `writeLanded: false`. {@link recoverPendingRevision} decides crashes
   * before or after the memory write from that evidence. */
  async beginRevisionTransaction(
    filePath: string,
    expectedContent?: string | Buffer | null,
  ): Promise<CasRevisionTransaction> {
    const relativePath = await this.resolveRelativePath(filePath);
    return await this.withShardLock(relativePath, async (lock) => {
      const standingInfo = await this.readStandingRevisionStrict(relativePath);
      const standing = standingInfo?.revision;
      const next = nextCasRevisionIso(standing);
      const baselineDigest = await this.digestDurableFile(relativePath);
      const expectedDigest =
        expectedContent != null ? this.digestContent(expectedContent) : undefined;
      const { shardPath } = await this.getSafeShardInfo(relativePath);
      await this.writeShard(shardPath, relativePath, next, lock, "pending", standing, {
        baselineDigest,
        ...(expectedDigest !== undefined ? { expectedDigest } : {}),
        writeLanded: false,
      });
      return {
        pendingRevision: next,
        writeLanded: () => this.recordPendingWriteLanded(relativePath, next),
        commit: () => this.finalizeRevisionTransaction(relativePath, next, "commit"),
        abort: () => this.finalizeRevisionTransaction(relativePath, next, "abort"),
      };
    });
  }

  public digestContent(content: string | Buffer): string {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return createHash("sha256").update(bytes).digest("hex");
  }

  public async digestDurableFile(filePath: string): Promise<string | null> {
    const relativePath = await this.resolveRelativePath(filePath);
    const baseDir = path.resolve(this.baseDir);
    const target = await resolveSafeStoragePath(baseDir, relativePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw new Error(
        `CAS revision evidence: durable memory file ${relativePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** #2807: mark the reserved write as landed. Verifies a pre-recorded
   * expected digest against the durable file, or records the file digest
   * when none was reserved. Sets `writeLanded: true`. Idempotent. */
  private async recordPendingWriteLanded(relativePath: string, token: string): Promise<void> {
    await this.withShardLock(relativePath, async (lock) => {
      const { shardPath } = await this.getSafeShardInfo(relativePath);
      const view = await this.readShardView(shardPath, relativePath);
      if (view.kind !== "pending" || view.foreign || view.revision !== token) {
        throw new Error(
          `CAS revision evidence recording refused for ${relativePath}: the pending marker does not match the reserved token.`,
        );
      }
      if (pendingWriteHasLanded(view) && view.writeLanded !== false) return;
      const currentDigest = await this.digestDurableFile(relativePath);
      if (view.expectedDigest !== undefined && currentDigest !== view.expectedDigest) {
        throw new Error(
          `CAS revision evidence recording refused for ${relativePath}: the durable file does not match the reserved expected digest.`,
        );
      }
      await this.writeShard(shardPath, relativePath, token, lock, "pending", view.previous, {
        baselineDigest: view.baselineDigest === undefined ? null : view.baselineDigest,
        expectedDigest: view.expectedDigest !== undefined ? view.expectedDigest : currentDigest,
        writeLanded: true,
      });
    });
  }

  private async finalizeRevisionTransaction(
    relativePath: string,
    token: string,
    outcome: "commit" | "abort",
  ): Promise<void> {
    await this.withShardLock(relativePath, async (lock) => {
      const { shardPath } = await this.getSafeShardInfo(relativePath);
      const view = await this.readShardView(shardPath, relativePath);
      if (view.kind === "pending" && !view.foreign && view.revision === token) {
        if (outcome === "commit") {
          const committedDigest =
            view.expectedDigest ?? (await this.digestDurableFile(relativePath));
          await this.writeShard(shardPath, relativePath, token, lock, "committed", undefined, {
            committedDigest,
          });
        } else if (view.previous !== undefined) {
          await this.writeShard(shardPath, relativePath, view.previous, lock, "committed");
        } else {
          await unlink(shardPath);
        }
        return;
      }
      if (outcome === "commit" && view.kind === "committed" && !view.foreign && view.revision === token) {
        return;
      }
      if (outcome === "abort" && view.kind === "missing") {
        return;
      }
      throw new Error(
        `CAS revision transaction ${outcome} refused for ${relativePath}: the pending marker does not match the reserved token.`,
      );
    });
  }

  /** #2813 (P1 C): recovery for a reservation left PENDING by a crash or a
   * failed publication. The caller supplies the KNOWN outcome of the
   * durable memory write: `fileWriteLanded` publishes the pending token as
   * the COMMITTED receipt; otherwise the reservation is discarded and the
   * previous standing token restored. Idempotent — an already-committed or
   * absent shard is reported, not mutated. */
  async reconcilePendingRevision(
    filePath: string,
    fileWriteLanded: boolean,
  ): Promise<"reconciled" | "committed" | "absent"> {
    const relativePath = await this.resolveRelativePath(filePath);
    return await this.withShardLock(relativePath, async (lock) => {
      const { shardPath } = await this.getSafeShardInfo(relativePath);
      const view = await this.readShardView(shardPath, relativePath);
      if (view.kind === "committed") return "committed";
      if (view.kind !== "pending") return "absent";
      if (view.foreign) {
        throw new Error(
          `CAS revision pending marker for ${relativePath} names another target; manual recovery is required.`,
        );
      }
      if (fileWriteLanded) {
        const committedDigest =
          view.expectedDigest ?? (await this.digestDurableFile(relativePath));
        await this.writeShard(shardPath, relativePath, view.revision, lock, "committed", undefined, {
          committedDigest,
        });
      } else if (view.previous !== undefined) {
        await this.writeShard(shardPath, relativePath, view.previous, lock, "committed");
      } else {
        await unlink(shardPath);
      }
      return "reconciled";
    });
  }

  /** #2807 (P1): evidence-based recovery for a reservation left PENDING by
   * a crash between reserve and finalize. Under the shard lock, the durable
   * file's current fingerprint is compared against the marker:
   * - matches `expectedDigest` → publish the pending token as COMMITTED;
   * - matches `baselineDigest` (including both absent) → abort and restore;
   * - anything else THROWS. Recovery never guesses.
   *
   * `onlyWithWriteEvidence` is the unlocked read path. A marker whose write
   * has not landed (`writeLanded` false, or legacy with no expectedDigest)
   * may belong to a live writer, so it returns `reserved`. A landed marker
   * whose file no longer matches `expectedDigest` throws ambiguity. */
  async recoverPendingRevision(
    filePath: string,
    options?: { onlyWithWriteEvidence?: boolean },
  ): Promise<"committed" | "aborted" | "absent" | "reserved"> {
    const relativePath = await this.resolveRelativePath(filePath);
    return await this.withShardLock(relativePath, async (lock) => {
      const { shardPath } = await this.getSafeShardInfo(relativePath);
      const view = await this.readShardView(shardPath, relativePath);
      if (view.kind === "missing" || view.kind === "foreign") return "absent";
      if (view.kind === "committed") return view.foreign ? "absent" : "committed";
      if (view.foreign) {
        throw new Error(
          `CAS revision pending marker for ${relativePath} names another target; manual recovery is required.`,
        );
      }
      const currentDigest = await this.digestDurableFile(relativePath);
      const landed = pendingWriteHasLanded(view);
      if (options?.onlyWithWriteEvidence && !landed) {
        return "reserved";
      }
      if (view.expectedDigest !== undefined && currentDigest === view.expectedDigest) {
        await this.writeShard(shardPath, relativePath, view.revision, lock, "committed", undefined, {
          committedDigest: view.expectedDigest,
        });
        return "committed";
      }
      if (options?.onlyWithWriteEvidence) {
        const evidence =
          view.expectedDigest === undefined
            ? "the pending marker carries no crash evidence (written by an older version)"
            : "the durable file matches neither the expected commit fingerprint nor the reserve-time baseline";
        throw new Error(
          `CAS revision recovery for ${relativePath} is ambiguous: ${evidence} (pending token ${view.revision}` +
            `${view.previous !== undefined ? `, previous ${view.previous}` : ""}). ` +
            `Inspect the durable file and the shard at ${shardPath}, then run ` +
            `reconcilePendingRevision with the known write outcome. Refusing to guess.`,
        );
      }
      if (view.baselineDigest !== undefined && currentDigest === view.baselineDigest) {
        if (view.previous !== undefined) {
          await this.writeShard(shardPath, relativePath, view.previous, lock, "committed");
        } else {
          await unlink(shardPath);
        }
        return "aborted";
      }
      const evidence =
        view.baselineDigest === undefined && view.expectedDigest === undefined
          ? "the pending marker carries no crash evidence (written by an older version)"
          : "the durable file matches neither the expected commit fingerprint nor the reserve-time baseline";
      throw new Error(
        `CAS revision recovery for ${relativePath} is ambiguous: ${evidence} (pending token ${view.revision}` +
          `${view.previous !== undefined ? `, previous ${view.previous}` : ""}). ` +
          `Inspect the durable file and the shard at ${shardPath}, then run ` +
          `reconcilePendingRevision with the known write outcome. Refusing to guess.`,
      );
    });
  }
}
