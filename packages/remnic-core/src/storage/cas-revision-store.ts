import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveSafeStoragePath } from "../storage-paths.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock, type HeldFileLockController } from "../utils/serialize-mutations.js";
import { log } from "../logger.js";
import { isValidManagedStoragePath, nextCasRevisionIso } from "./deletion-revision-store.js";

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
  private readonly revisionMetadataPath: string;
  private readonly revisionLockPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    // Same sidecar home as the deletion-revision metadata: `<baseDir>/.offline-sync/`.
    this.revisionMetadataPath = path.join(baseDir, ".offline-sync", "cas-revisions.v1.json");
    this.revisionLockPath = path.join(baseDir, ".offline-sync", "cas-revisions.v1.json.lock");
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

  private async metadataPath(): Promise<string> {
    const baseDir = path.resolve(this.baseDir);
    return await resolveSafeStoragePath(baseDir, path.relative(baseDir, this.revisionMetadataPath));
  }

  private async readMetadata(): Promise<Map<string, string>> {
    let raw: string;
    try {
      raw = await readFile(await this.metadataPath(), "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return new Map();
      throw new Error("CAS revision metadata is unavailable.");
    }
    return this.parseCasRevisionMetadata(raw);
  }

  private async writeMetadata(
    revisions: ReadonlyMap<string, string>,
    lock: HeldFileLockController,
  ): Promise<void> {
    const metadataPath = await this.metadataPath();
    const entries = [...revisions.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([entryPath, revision]) => ({ path: entryPath, revision }));
    const metadata: CasRevisionMetadata = { version: 1, revisions: entries };
    const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | null = null;
    try {
      await mkdir(path.dirname(metadataPath), { recursive: true });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (!(await lock.refresh())) {
        throw new Error("CAS revision metadata lock was lost.");
      }
      await rename(temporaryPath, metadataPath);
    } finally {
      if (handle !== null) {
        await handle.close().catch((error: unknown) => {
          log.warn("failed to close CAS revision metadata temporary file", error);
        });
      }
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isErrnoCode(error, "ENOENT")) {
          log.warn("failed to clean up CAS revision metadata temporary file", error);
        }
      });
    }
  }

  private async withRevisionLock<T>(task: (lock: HeldFileLockController) => Promise<T>): Promise<T> {
    return withHeldFileLock(
      this.revisionLockPath,
      { staleMs: CAS_REVISION_LOCK_STALE_MS, maxWaitMs: CAS_REVISION_LOCK_MAX_WAIT_MS },
      async (acquired, lock) => {
        if (!acquired) throw new Error("CAS revision metadata lock is unavailable.");
        return task(lock);
      },
    );
  }

  private async resolveRelativePath(filePath: string): Promise<string> {
    const baseDir = path.resolve(this.baseDir);
    const target = await resolveSafeStoragePath(baseDir, path.relative(baseDir, path.resolve(baseDir, filePath)));
    return path.relative(baseDir, target).split(path.sep).join("/");
  }

  /** The target's standing revision token, or undefined when no receipt was
   * ever minted for it. */
  async readRevision(filePath: string): Promise<string | undefined> {
    const relativePath = await this.resolveRelativePath(filePath);
    return await this.withRevisionLock(async () => (await this.readMetadata()).get(relativePath));
  }

  /** Mint the NEXT revision token for the target and durably record it:
   * strictly greater than the standing token (max(clock, prev + 1ms)), so
   * two commits can never share a receipt — not within one millisecond, not
   * across a backward clock step. Any receipt minted earlier stops matching
   * the standing token, which is exactly the ownership signal the rollback
   * comparison needs. Entries persist for the corpus's lifetime (one per
   * target path, replaced in place) — bounded like any index, and a stale
   * entry for a deleted path can only make an old receipt mismatch. */
  async commitRevision(filePath: string): Promise<string> {
    const relativePath = await this.resolveRelativePath(filePath);
    return await this.withRevisionLock(async (lock) => {
      const revisions = await this.readMetadata();
      const next = nextCasRevisionIso(revisions.get(relativePath));
      revisions.set(relativePath, next);
      await this.writeMetadata(revisions, lock);
      return next;
    });
  }
}
