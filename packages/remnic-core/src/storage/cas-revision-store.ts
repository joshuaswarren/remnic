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
};

type CasRevisionMetadata = {
  version: 1;
  revisions: Array<{ path: string; revision: string }>;
};

const CAS_REVISION_LOCK_STALE_MS = 60_000;
const CAS_REVISION_LOCK_MAX_WAIT_MS = 120_000;

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

  private getShardInfo(relativePath: string): { shardPath: string; lockPath: string } {
    const hash = createHash("sha256").update(relativePath).digest("hex");
    const shardDir = path.join(this.baseDir, ".offline-sync", "cas-revisions");
    const shardPath = path.join(shardDir, `${hash}.json`);
    const lockPath = path.join(shardDir, `${hash}.json.lock`);
    return { shardPath, lockPath };
  }

  private async readStandingRevision(relativePath: string): Promise<string | undefined> {
    const { shardPath } = this.getShardInfo(relativePath);
    try {
      const raw = await readFile(shardPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).version === 1 &&
        (parsed as Record<string, unknown>).path === relativePath &&
        typeof (parsed as Record<string, unknown>).revision === "string" &&
        ((parsed as Record<string, unknown>).revision as string).length > 0
      ) {
        return (parsed as Record<string, unknown>).revision as string;
      }
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        log.warn(`CasRevisionStore failed to read shard for ${relativePath}: ${error}`);
        return undefined;
      }
    }
    try {
      const legacyMap = await this.readLegacyMetadata();
      return legacyMap.get(relativePath);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        log.warn(`CasRevisionStore failed to read legacy metadata for ${relativePath}: ${error}`);
      }
      return undefined;
    }
  }

  private async writeShard(
    relativePath: string,
    revision: string,
    lock: HeldFileLockController,
  ): Promise<void> {
    const { shardPath } = this.getShardInfo(relativePath);
    const payload: CasRevisionShard = { version: 1, path: relativePath, revision };
    const temporaryPath = `${shardPath}.${process.pid}.${randomUUID()}.tmp`;
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

  /** Mint the NEXT revision token for the target and durably record it:
   * strictly greater than the standing token (max(clock, prev + 1ms)), so
   * two commits can never share a receipt — not within one millisecond, not
   * across a backward clock step. Sharded per-target for O(1) mutations. */
  async commitRevision(filePath: string): Promise<string> {
    const relativePath = await this.resolveRelativePath(filePath);
    const { lockPath } = this.getShardInfo(relativePath);
    return await withHeldFileLock(
      lockPath,
      { staleMs: CAS_REVISION_LOCK_STALE_MS, maxWaitMs: CAS_REVISION_LOCK_MAX_WAIT_MS },
      async (acquired, lock) => {
        if (!acquired) throw new Error("CAS revision lock is unavailable.");
        const standing = await this.readStandingRevision(relativePath);
        const next = nextCasRevisionIso(standing);
        await this.writeShard(relativePath, next, lock);
        return next;
      },
    );
  }
}
