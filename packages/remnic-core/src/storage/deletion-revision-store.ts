import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveSafeStoragePath } from "../storage-paths.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock, type HeldFileLockController } from "../utils/serialize-mutations.js";
import { log } from "../logger.js";

type DeletionRevisionMetadata = {
  version: 1;
  deletions: Array<{ path: string; mtimeMs: number }>;
};

type InvalidationCommitMetadata = {
  version: 1;
  commits: Array<{ memoryId: string; fingerprint: string; committedAt: number }>;
};

type InvalidationCommit = { fingerprint: string; committedAt: number };

type ManagedStoragePathGuard = (filePath: string, method: string) => string;

export type DeletionRevisionStoreOptions = {
  baseDir: string;
  deletionRevisionMetadataPath: string;
  invalidationCommitMetadataPath: string;
  deletionRevisionLockPath: string;
  assertManagedStoragePath: ManagedStoragePathGuard;
};

const DELETION_REVISION_MAX_MTIME_MS = 8_640_000_000_000_000;
const DELETION_REVISION_LOCK_STALE_MS = 60_000;
const DELETION_REVISION_LOCK_MAX_WAIT_MS = 120_000;
const INVALIDATION_COMMIT_MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const INVALIDATION_PROOF_QUARANTINE_MAX_IDS = 1024;

function canonicalizeInvalidationEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeInvalidationEvidence(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalizeInvalidationEvidence((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function invalidationCommitFingerprint(memory: Pick<MemoryFile, "content" | "frontmatter">): string {
  const frontmatter = { ...memory.frontmatter };
  delete frontmatter.accessCount;
  delete frontmatter.lastAccessed;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalizeInvalidationEvidence({
          content: memory.content,
          frontmatter,
        }),
      ),
    )
    .digest("hex");
}

/**
 * #2813 (P1): revision identity stamped onto an Error thrown by a
 * compare-and-swap write AFTER the durable mutation landed (a post-commit
 * step failed). Body equality cannot attribute a standing body — a
 * concurrent writer's identical deterministic merge is byte-for-byte the
 * same — so throw-path ownership must come from this receipt, never from
 * comparing content afterward.
 */
export function markCasCommittedRevision(err: unknown, revision: string): void {
  if (err instanceof Error) {
    (err as Error & { casCommittedRevision?: string }).casCommittedRevision = revision;
  }
}

export function casCommittedRevisionOf(err: unknown): string | undefined {
  return err instanceof Error
    ? (err as Error & { casCommittedRevision?: string }).casCommittedRevision
    : undefined;
}

/**
 * #2813 (P1, round 3): the CAS receipt identity — the revision the next
 * content write stamps into `frontmatter.updated`. NOT a bare wall-clock
 * read: the stamp is strictly greater than the standing record's previous
 * revision (max(clock, prev + 1ms)), and because it is persisted IN the
 * record each serialized CAS re-reads its predecessor's stamp and steps past
 * it, two commits to the same target can never share a receipt — not within
 * one millisecond, not across a backward clock step. It is a per-target
 * monotonic sequence wearing ISO-8601 clothes.
 */
export function nextCasRevisionIso(previous: string | undefined, now = new Date()): string {
  const previousMs = previous !== undefined ? new Date(previous).getTime() : Number.NaN;
  if (Number.isFinite(previousMs) && now.getTime() <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return now.toISOString();
}

/**
 * #2813 P1 (round 5, #2807): the revision EVERY semantic frontmatter write
 * persists. `writeMemoryFrontmatter` merges caller patches via
 * `{...frontmatter, ...patch}`, and `patch.updated` is ADVISORY event
 * time — never revision identity. A semantic patch that omits it
 * (correction retirement, lifecycle status flips) still mutates the
 * record, so it still advances the revision: a timestamp-less write that
 * preserved the standing revision left a retired record carrying a live
 * CAS receipt, and the receipt's owner "recognised" the foreign record
 * during rollback and restored its body over the retirement metadata.
 * Access telemetry (`accessCount`/`lastAccessed` — exactly the fields the
 * CAS fingerprint strips) is NOT semantic: it preserves the standing
 * revision so an access bump cannot invalidate a pending conditional
 * write. The clamp keeps the on-disk sequence monotonic:
 *   - no proposed revision, access-only (or empty) patch → the standing
 *     revision stands (a non-semantic write moves nothing);
 *   - no proposed revision, any semantic field → `nextCasRevisionIso` over
 *     the standing revision: every semantic mutation is a new revision;
 *   - a proposal strictly past the standing revision → honored exactly;
 *   - anything else (stale, equal, unparseable) → `nextCasRevisionIso`
 *     over the standing revision: strictly past it, never lower, never
 *     a reuse of a receipt any CAS already issued.
 * `standing` must be the record's CURRENT on-disk revision, never the
 * caller's (possibly pre-CAS) snapshot.
 */
const ACCESS_ONLY_FRONTMATTER_FIELDS: Record<string, true> = {
  accessCount: true,
  lastAccessed: true,
};

export function frontmatterWriteRevision(
  standing: string | undefined,
  patch: Partial<MemoryFrontmatter>,
  now = new Date(),
): string {
  const { updated: proposed } = patch;
  if (proposed === undefined) {
    const keys = Object.keys(patch);
    const nonSemantic = keys.every((key) => ACCESS_ONLY_FRONTMATTER_FIELDS[key] === true);
    return nonSemantic ? (standing ?? nextCasRevisionIso(standing, now)) : nextCasRevisionIso(standing, now);
  }
  const standingMs = standing !== undefined ? new Date(standing).getTime() : Number.NaN;
  const proposedMs = new Date(proposed).getTime();
  if (Number.isFinite(proposedMs) && (!Number.isFinite(standingMs) || proposedMs > standingMs)) {
    return proposed;
  }
  return nextCasRevisionIso(standing, now);
}

/**
 * Runs a compare-and-swap write's post-commit steps. The durable mutation
 * has already landed by the time `run` executes, so any throw it raises is
 * stamped with the commit receipt — callers must attribute the standing
 * body by that identity, never by body equality (#2813 P1).
 */
export async function withCasCommitReceipt<T>(revision: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    markCasCommittedRevision(err, revision);
    throw err;
  }
}

function isValidInvalidationCommitTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= INVALIDATION_COMMIT_MAX_TIMESTAMP_MS
  );
}

function isValidInvalidationCommitFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isValidMemoryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isValidDeletionRevisionPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

function deletionRevisionPathIdentity(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase();
}

export class DeletionRevisionStore {
  private readonly options: DeletionRevisionStoreOptions;
  private readonly invalidationProofQuarantine = new Set<string>();
  private invalidationProofQuarantineFull = false;
  private invalidationProofQuarantineFullAt: number | null = null;

  constructor(options: DeletionRevisionStoreOptions) {
    this.options = options;
  }
  private quarantineInvalidationProof(memoryId: string): void {
    if (this.invalidationProofQuarantineFull) {
      const nextBoundary = Date.now() + 1;
      this.invalidationProofQuarantineFullAt = Math.max(
        this.invalidationProofQuarantineFullAt ?? 0,
        nextBoundary,
      );
      return;
    }
    if (this.invalidationProofQuarantine.has(memoryId)) return;
    if (this.invalidationProofQuarantine.size >= INVALIDATION_PROOF_QUARANTINE_MAX_IDS) {
      this.invalidationProofQuarantineFull = true;
      this.invalidationProofQuarantineFullAt = Date.now() + 1;
      return;
    }
    this.invalidationProofQuarantine.add(memoryId);
  }
  private async resolveConfiguredStoragePath(targetPath: string): Promise<string> {
    const baseDir = path.resolve(this.options.baseDir);
    const relativePath = path.relative(baseDir, path.resolve(targetPath));
    return resolveSafeStoragePath(baseDir, relativePath);
  }

  private async resolveManagedStoragePath(filePath: string, method: string): Promise<{
    target: string;
    relativePath: string;
  }> {
    const assertedPath = this.options.assertManagedStoragePath(filePath, method);
    const target = await this.resolveConfiguredStoragePath(assertedPath);
    const relativePath = path.relative(path.resolve(this.options.baseDir), target).split(path.sep).join("/");
    return { target, relativePath };
  }

  private parseDeletionRevisionMetadata(raw: string): Map<string, number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Deletion revision metadata is invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Deletion revision metadata is invalid.");
    }
    const root = parsed as Record<string, unknown>;
    if (
      Object.keys(root).sort().join(",") !== "deletions,version" ||
      root.version !== 1 ||
      !Array.isArray(root.deletions)
    ) {
      throw new Error("Deletion revision metadata is invalid.");
    }
    const revisions = new Map<string, number>();
    const pathByIdentity = new Map<string, string>();
    for (const rawEntry of root.deletions) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new Error("Deletion revision metadata is invalid.");
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(",") !== "mtimeMs,path" ||
        !isValidDeletionRevisionPath(entry.path) ||
        typeof entry.mtimeMs !== "number" ||
        !Number.isFinite(entry.mtimeMs) ||
        entry.mtimeMs < 0 ||
        entry.mtimeMs > DELETION_REVISION_MAX_MTIME_MS ||
        revisions.has(entry.path)
      ) {
        throw new Error("Deletion revision metadata is invalid.");
      }
      const identity = deletionRevisionPathIdentity(entry.path);
      if (pathByIdentity.has(identity)) {
        throw new Error("Deletion revision metadata is invalid.");
      }
      pathByIdentity.set(identity, entry.path);
      revisions.set(entry.path, entry.mtimeMs);
    }
    return new Map([...revisions.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  }
  private async readDeletionRevisionMetadata(): Promise<Map<string, number>> {
    const metadataPath = await this.resolveConfiguredStoragePath(this.options.deletionRevisionMetadataPath);
    let raw: string;
    try {
      raw = await readFile(metadataPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return new Map();
      throw new Error("Deletion revision metadata is unavailable.");
    }
    return this.parseDeletionRevisionMetadata(raw);
  }

  private async writeDeletionRevisionMetadata(
    revisions: ReadonlyMap<string, number>,
    lock: HeldFileLockController,
  ): Promise<void> {
    const metadataPath = await this.resolveConfiguredStoragePath(this.options.deletionRevisionMetadataPath);
    const deletions = [...revisions.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([entryPath, mtimeMs]) => ({ path: entryPath, mtimeMs }));
    const metadata: DeletionRevisionMetadata = { version: 1, deletions };
    const temporaryPath = await this.resolveConfiguredStoragePath(
      `${metadataPath}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (!(await lock.refresh())) {
        throw new Error("Deletion revision metadata lock was lost.");
      }
      const renameTarget = await this.resolveConfiguredStoragePath(this.options.deletionRevisionMetadataPath);
      await rename(temporaryPath, renameTarget);
    } finally {
      if (handle !== null) {
        await handle.close().catch((error: unknown) => {
          log.warn("failed to close deletion revision metadata temporary file", error);
        });
      }
      const cleanupPath = await this.resolveConfiguredStoragePath(temporaryPath).catch((error: unknown) => {
        log.warn("failed to resolve deletion revision metadata temporary file for cleanup", error);
        return null;
      });
      if (cleanupPath !== null) {
        await unlink(cleanupPath).catch((error: unknown) => {
          if (!isErrnoCode(error, "ENOENT")) {
            log.warn("failed to clean up deletion revision metadata temporary file", error);
          }
        });
      }
    }
  }

  private async withDeletionRevisionLock<T>(task: (lock: HeldFileLockController) => Promise<T>): Promise<T> {
    const lockPath = await this.resolveConfiguredStoragePath(this.options.deletionRevisionLockPath);
    return withHeldFileLock(
      lockPath,
      {
        staleMs: DELETION_REVISION_LOCK_STALE_MS,
        maxWaitMs: DELETION_REVISION_LOCK_MAX_WAIT_MS,
      },
      async (acquired, lock) => {
        if (!acquired) throw new Error("Deletion revision metadata lock is unavailable.");
        return task(lock);
      },
    );
  }

  async readDeletionRevisions(): Promise<ReadonlyMap<string, number>> {
    return this.withDeletionRevisionLock(async () => this.readDeletionRevisionMetadata());
  }

  private parseInvalidationCommitMetadata(raw: string): Map<string, InvalidationCommit> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalidation commit metadata is invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalidation commit metadata is invalid.");
    }
    const root = parsed as Record<string, unknown>;
    if (
      Object.keys(root).sort().join(",") !== "commits,version" ||
      root.version !== 1 ||
      !Array.isArray(root.commits)
    ) {
      throw new Error("Invalidation commit metadata is invalid.");
    }
    const commits = new Map<string, InvalidationCommit>();
    for (const rawEntry of root.commits) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new Error("Invalidation commit metadata is invalid.");
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(",") !== "committedAt,fingerprint,memoryId" ||
        !isValidMemoryId(entry.memoryId) ||
        !isValidInvalidationCommitFingerprint(entry.fingerprint) ||
        !isValidInvalidationCommitTimestamp(entry.committedAt) ||
        commits.has(entry.memoryId)
      ) {
        throw new Error("Invalidation commit metadata is invalid.");
      }
      commits.set(entry.memoryId, {
        fingerprint: entry.fingerprint,
        committedAt: entry.committedAt,
      });
    }
    return commits;
  }

  private async readInvalidationCommitMetadata(): Promise<Map<string, InvalidationCommit>> {
    const metadataPath = await this.resolveConfiguredStoragePath(this.options.invalidationCommitMetadataPath);
    let raw: string;
    try {
      raw = await readFile(metadataPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return new Map();
      throw new Error("Invalidation commit metadata is unavailable.");
    }
    return this.parseInvalidationCommitMetadata(raw);
  }

  private async writeInvalidationCommitMetadata(
    commits: ReadonlyMap<string, InvalidationCommit>,
    lock: HeldFileLockController,
  ): Promise<void> {
    const metadataPath = await this.resolveConfiguredStoragePath(this.options.invalidationCommitMetadataPath);
    const entries = [...commits.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([memoryId, value]) => ({
        memoryId,
        fingerprint: value.fingerprint,
        committedAt: value.committedAt,
      }));
    const metadata: InvalidationCommitMetadata = { version: 1, commits: entries };
    const temporaryPath = await this.resolveConfiguredStoragePath(
      `${metadataPath}.${process.pid}.${randomUUID()}.tmp`,
    );
    const metadataDir = await this.resolveConfiguredStoragePath(path.dirname(metadataPath));
    let handle: FileHandle | null = null;
    let renamed = false;
    try {
      await mkdir(metadataDir, { recursive: true });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (!(await lock.refresh())) {
        throw new Error("Invalidation commit metadata lock was lost.");
      }
      const renameTarget = await this.resolveConfiguredStoragePath(this.options.invalidationCommitMetadataPath);
      await rename(temporaryPath, renameTarget);
      renamed = true;
    } finally {
      if (handle !== null) {
        await handle.close().catch((error: unknown) => {
          log.warn("failed to close invalidation commit metadata temporary file", error);
        });
      }
      const cleanupPath = await this.resolveConfiguredStoragePath(temporaryPath).catch((error: unknown) => {
        log.warn("failed to resolve invalidation commit metadata temporary file for cleanup", error);
        return null;
      });
      if (cleanupPath !== null) {
        await unlink(cleanupPath).catch((error: unknown) => {
          if (!isErrnoCode(error, "ENOENT")) {
            log.warn(
              `failed to clean up invalidation commit metadata temporary file after ${renamed ? "commit" : "failure"}`,
              error,
            );
          }
        });
      }
    }
  }

  async hasCommittedInvalidation(memory: Pick<MemoryFile, "content" | "frontmatter">): Promise<boolean> {
    const memoryId = memory.frontmatter.id;
    const fingerprint = invalidationCommitFingerprint(memory);
    return this.withDeletionRevisionLock(async () => {
      const entry = (await this.readInvalidationCommitMetadata()).get(memoryId);
      if (entry?.fingerprint !== fingerprint) return false;
      if (this.invalidationProofQuarantine.has(memoryId)) return false;
      if (!this.invalidationProofQuarantineFull) return true;
      const fullAt = this.invalidationProofQuarantineFullAt;
      return fullAt !== null && entry.committedAt >= fullAt;
    });
  }

  async recordCommittedInvalidation(memory: MemoryFile): Promise<void> {
    const fingerprint = invalidationCommitFingerprint(memory);
    await this.withDeletionRevisionLock(async (lock) => {
      const fullAt = this.invalidationProofQuarantineFullAt;
      const committedAt = fullAt === null ? Date.now() : Math.max(Date.now(), fullAt + 1);
      const commits = await this.readInvalidationCommitMetadata();
      commits.set(memory.frontmatter.id, {
        fingerprint,
        committedAt,
      });
      await this.writeInvalidationCommitMetadata(commits, lock);
      this.invalidationProofQuarantine.delete(memory.frontmatter.id);
    });
  }

  async clearCommittedInvalidation(memory: Pick<MemoryFile, "content" | "frontmatter">): Promise<void> {
    const memoryId = memory.frontmatter.id;
    this.quarantineInvalidationProof(memoryId);
    const fingerprint = invalidationCommitFingerprint(memory);
    let cleared = false;
    try {
      await this.withDeletionRevisionLock(async (lock) => {
        const commits = await this.readInvalidationCommitMetadata();
        const current = commits.get(memoryId);
        if (current?.fingerprint !== fingerprint) return;
        commits.delete(memoryId);
        await this.writeInvalidationCommitMetadata(commits, lock);
      });
      cleared = true;
    } finally {
      if (cleared) this.invalidationProofQuarantine.delete(memoryId);
    }
  }

  async recordReplicatedDeletionRevision(filePath: string, mtimeMs: number): Promise<void> {
    const { relativePath } = await this.resolveManagedStoragePath(
      filePath,
      "storage.recordReplicatedDeletionRevision",
    );
    if (
      typeof mtimeMs !== "number" ||
      !Number.isFinite(mtimeMs) ||
      mtimeMs < 0 ||
      mtimeMs > DELETION_REVISION_MAX_MTIME_MS
    ) {
      throw new Error("Deletion revision timestamp is invalid.");
    }
    if (!isValidDeletionRevisionPath(relativePath)) {
      throw new Error("Deletion revision path is invalid.");
    }
    await this.withDeletionRevisionLock(async (lock) => {
      const revisions = await this.readDeletionRevisionMetadata();
      const identity = deletionRevisionPathIdentity(relativePath);
      let existingPath: string | undefined;
      for (const candidatePath of revisions.keys()) {
        if (deletionRevisionPathIdentity(candidatePath) === identity) {
          existingPath = candidatePath;
          break;
        }
      }
      const existingMtimeMs = existingPath === undefined ? undefined : revisions.get(existingPath);
      if (existingMtimeMs !== undefined && existingMtimeMs >= mtimeMs) return;
      const updated = new Map(revisions);
      if (existingPath !== undefined) updated.delete(existingPath);
      updated.set(relativePath, mtimeMs);
      await this.writeDeletionRevisionMetadata(updated, lock);
    });
  }

  async writeManagedStorageFile(filePath: string, write: () => Promise<void>): Promise<void> {
    const { relativePath } = await this.resolveManagedStoragePath(filePath, "storage.writeManagedStorageFile");
    if (!isValidDeletionRevisionPath(relativePath)) {
      throw new Error("Deletion revision path is invalid.");
    }
    await this.withDeletionRevisionLock(async (lock) => {
      const before = await this.readDeletionRevisionMetadata();
      const identity = deletionRevisionPathIdentity(relativePath);
      const existingPath = [...before.keys()].find(
        (candidatePath) => deletionRevisionPathIdentity(candidatePath) === identity,
      );
      await write();
      if (existingPath === undefined) return;
      const updated = new Map(before);
      updated.delete(existingPath);
      await this.writeDeletionRevisionMetadata(updated, lock);
    });
  }

  async deleteManagedStorageFile(filePath: string, deletionMtimeMs?: number | null): Promise<boolean> {
    const { target, relativePath } = await this.resolveManagedStoragePath(
      filePath,
      "storage.deleteManagedStorageFile",
    );
    if (
      deletionMtimeMs !== undefined &&
      deletionMtimeMs !== null &&
      (typeof deletionMtimeMs !== "number" ||
        !Number.isFinite(deletionMtimeMs) ||
        deletionMtimeMs < 0 ||
        deletionMtimeMs > DELETION_REVISION_MAX_MTIME_MS)
    ) {
      throw new Error("Deletion revision timestamp is invalid.");
    }
    return this.withDeletionRevisionLock(async (lock) => {
      const safeTarget = await this.resolveConfiguredStoragePath(target);
      try {
        await lstat(safeTarget);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return false;
        throw error;
      }
      if (!isValidDeletionRevisionPath(relativePath)) {
        throw new Error("Deletion revision path is invalid.");
      }
      const revision = deletionMtimeMs === null ? undefined : (deletionMtimeMs ?? Date.now());
      const before = await this.readDeletionRevisionMetadata();
      const identity = deletionRevisionPathIdentity(relativePath);
      let existingPath: string | undefined;
      for (const candidatePath of before.keys()) {
        if (deletionRevisionPathIdentity(candidatePath) === identity) {
          existingPath = candidatePath;
          break;
        }
      }
      const existing = existingPath === undefined ? undefined : before.get(existingPath);
      const changed =
        (existingPath !== undefined && existingPath !== relativePath) ||
        (revision === undefined ? existing !== undefined : existing !== revision);
      if (changed) {
        const updated = new Map(before);
        if (existingPath !== undefined) updated.delete(existingPath);
        if (revision !== undefined) updated.set(relativePath, revision);
        await this.writeDeletionRevisionMetadata(updated, lock);
      }
      try {
        const unlinkTarget = await this.resolveConfiguredStoragePath(target);
        await unlink(unlinkTarget);
        return true;
      } catch (error) {
        if (changed) await this.writeDeletionRevisionMetadata(before, lock);
        if (isErrnoCode(error, "ENOENT")) return false;
        throw error;
      }
    });
  }
}
