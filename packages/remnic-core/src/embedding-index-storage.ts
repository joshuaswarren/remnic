/**
 * File-level storage for the embedding fallback index (issue #3146).
 *
 * Two single-generation layouts, exactly one authoritative at a time:
 *   - `legacy`:  the single `state/embeddings.json` file, used while the
 *     whole index serializes within `resolveIndexFileCharLimit()` chars;
 *   - `sharded`: the published `state/embeddings/` directory of hash-assigned
 *     shard files, migrated to ONE-WAY and ATOMICALLY (stage a complete shard
 *     set, publish with a single directory rename, demote the legacy file to
 *     a non-authoritative recovery artifact). Generations never merge, so a
 *     crash cannot resurrect deleted entries or drop published ones.
 *
 * This module owns files, budgets, and durable diagnostics only — no index
 * caching or provider logic (that lives in `embedding-fallback.ts`).
 */
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import { readEnvVar } from "./runtime/env.js";

export type EmbeddingProviderType = "openai" | "local" | "host";

export type EmbeddingIndexEntry = {
  vector: number[];
  path: string;
};

export type EmbeddingIndexFile = {
  version: 1;
  provider: EmbeddingProviderType;
  model: string;
  entries: Record<string, EmbeddingIndexEntry>;
};

export type EmbeddingIndexIdentity = Pick<EmbeddingIndexFile, "provider" | "model">;

/** Outcome of reading one managed index file (legacy or shard). */
export type ManagedIndexRead =
  | { outcome: "ok"; file: EmbeddingIndexFile }
  | { outcome: "absent" }
  | { outcome: "foreign" }
  | { outcome: "unreadable"; reason: string };

/** Which generation owns the index right now. */
export type IndexLayout = "empty" | "legacy" | "sharded";

/**
 * Thrown when an embedding index (or one of its shards) cannot be persisted
 * within the per-file serialization budget. Issue #3146: index files are
 * materialized as single V8 strings, so a JSON document at or past
 * `bufferConstants.MAX_STRING_LENGTH` chars makes every read and write throw
 * `RangeError: Invalid string length`. The index is sharded before that
 * ceiling; this tagged error is reserved for the residual case where even
 * one shard cannot hold the payload (e.g. a single entry with an enormous
 * vector), so callers can classify it as recoverable-with-record instead of
 * an opaque background failure.
 */
export class EmbeddingIndexCapacityError extends Error {
  override readonly name = "EmbeddingIndexCapacityError" as const;
  constructor(
    message: string,
    readonly memoryId?: string,
  ) {
    super(message);
  }
}

/**
 * Thrown when an index file that should be authoritative cannot be read
 * (I/O error, over-budget size, unparseable JSON). Mutation paths fail
 * CLOSED on this: they must not continue with a fresh empty index and
 * pretend the previous vectors were loaded — the file is left untouched in
 * place for recovery. Read-only paths (recall) fail open to empty results
 * and record the reason durably.
 */
export class EmbeddingIndexStorageError extends Error {
  override readonly name = "EmbeddingIndexStorageError" as const;
}

/** Durable diagnostic row describing the last failed embedding-index write. */
export interface EmbeddingIndexWriteFailure {
  ts: string;
  kind: "capacity" | "io";
  message: string;
  memoryId?: string;
}

/**
 * Durable embedding-index diagnostics (issue #3146), persisted at
 * `<memoryDir>/state/embedding-fallback-status.json` and surfaced through
 * console_state, so background ingestion failures are visible to operators
 * instead of only ever appearing as log lines.
 */
export interface EmbeddingIndexStatusFile {
  version: 1;
  /** Cumulative count of failed index writes since the file was created. */
  failureCount: number;
  /** Active write failure; cleared by the next successful save. */
  lastWriteFailure?: EmbeddingIndexWriteFailure;
  /** Set when an unreadable index file was detected instead of overwritten. */
  lastReadRecovery?: { ts: string; message: string };
  lastSuccessAt?: string;
}

/**
 * Per-file serialization budget (JSON-string chars) for WRITES of the legacy
 * `state/embeddings.json` file and of every shard under `state/embeddings/`.
 * The 16MiB margin keeps the write round-trip clear of the V8 single-string
 * ceiling even with UTF-8 byte/count skew and small header growth. Override
 * per environment (tests, headroom tuning) via
 * `REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT`.
 *
 * READS are gated by the HARD ceiling (`resolveIndexHardReadCharLimit`),
 * never by this budget: a legacy index written by an older version may
 * legitimately sit between the soft budget and the hard ceiling (the
 * reported production file does), and it must still load and migrate.
 */
const DEFAULT_INDEX_FILE_CHAR_LIMIT =
  bufferConstants.MAX_STRING_LENGTH - 16 * 1024 * 1024;

/**
 * Hard single-string ceiling for READS: files at or above this size are not
 * attempted (a readFile would throw `RangeError: Invalid string length`);
 * their bytes are preserved in place and mutations fail closed with an
 * actionable error. Defaults to the V8 maximum; tests inject a small value
 * via `REMNIC_EMBEDDING_INDEX_HARD_READ_LIMIT_CHARS`.
 */
function resolveIndexHardReadCharLimit(): number {
  const soft = resolveIndexFileCharLimit();
  const raw = readEnvVar("REMNIC_EMBEDDING_INDEX_HARD_READ_LIMIT_CHARS");
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= soft) return parsed;
  }
  return bufferConstants.MAX_STRING_LENGTH;
}

/** Hash shards under `state/embeddings/` used once the budget is exceeded. */
const SHARD_COUNT = 64;

const SHARD_FILE_PATTERN = /^shard-\d{4}\.json$/;

export function resolveIndexFileCharLimit(): number {
  const raw = readEnvVar("REMNIC_EMBEDDING_INDEX_FILE_CHAR_LIMIT");
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1024) return parsed;
  }
  return DEFAULT_INDEX_FILE_CHAR_LIMIT;
}

function shardFileName(shardIndex: number): string {
  return `shard-${String(shardIndex).padStart(4, "0")}.json`;
}

/**
 * Fixed transaction backup path for identity replacements. A fixed (not
 * per-process) name is what makes the rename gap recoverable: whatever
 * process restarts after a crash finds the demoted former generation here
 * and rolls it back into place.
 */
function replacementBackupPath(shardDir: string): string {
  return path.join(path.dirname(shardDir), "embeddings.pre-replace.tmp");
}

/**
 * Stable FNV-1a shard assignment: an entry always hashes to the same shard,
 * so an update or removal never needs a manifest to find its file.
 */
export function shardIndexOf(memoryId: string, shardCount: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < memoryId.length; i++) {
    hash ^= memoryId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % shardCount;
}

/**
 * A shard file named `shard-NNNN.json` must only contain ids that hash to
 * that shard: a misplaced copy would be loaded today and silently resurrect
 * stale vectors after the computed shard is rewritten (issue #3148, round 6).
 * Throws the tagged storage error so mutations fail closed and recall fails
 * open at its boundary.
 */
export function validateShardMembership(shardName: string, file: EmbeddingIndexFile): void {
  const match = /^shard-(\d{4})\.json$/.exec(shardName);
  if (!match) return; // not a shard file (legacy documents have no constraint)
  const shardIndex = Number(match[1]);
  for (const id of Object.keys(file.entries)) {
    if (shardIndexOf(id, SHARD_COUNT) !== shardIndex) {
      throw new EmbeddingIndexStorageError(
        `refusing embedding index shard ${shardName}: id ${id} hashes to shard ${shardIndexOf(id, SHARD_COUNT)}, not ${shardIndex}; file preserved in place`,
      );
    }
  }
}

export function isInvalidStringLengthError(err: unknown): boolean {
  return err instanceof RangeError && /invalid string length/i.test(err.message);
}

/**
 * Parse and FULLY validate one serialized index document (legacy or shard).
 * The single read boundary shared by disk reads and offline-sync pulls: a
 * document with a valid header but a malformed body (`entries` not a plain
 * record, or an entry whose `path` is not a string / whose `vector` is not a
 * finite-number array) is `unreadable`, not `ok` — recall fails open on the
 * tagged reason, mutations fail closed, and the bytes are never overwritten
 * (issue #3148 review, round 4).
 */
export function parseEmbeddingIndexDocument(raw: string): ManagedIndexRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      outcome: "unreadable",
      reason: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Partial<EmbeddingIndexFile>).version !== 1 ||
    typeof (parsed as Partial<EmbeddingIndexFile>).provider !== "string" ||
    typeof (parsed as Partial<EmbeddingIndexFile>).model !== "string" ||
    ((parsed as Partial<EmbeddingIndexFile>).model as string).length === 0
  ) {
    return { outcome: "foreign" };
  }
  // An unsupported identity must fail closed like any other malformed
  // document: recall cannot serve it and mutations must not adopt it as
  // authoritative (issue #3148, round 6).
  if (
    (parsed as Partial<EmbeddingIndexFile>).provider !== "openai" &&
    (parsed as Partial<EmbeddingIndexFile>).provider !== "local" &&
    (parsed as Partial<EmbeddingIndexFile>).provider !== "host"
  ) {
    return { outcome: "foreign" };
  }
  const entries = (parsed as Partial<EmbeddingIndexFile>).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {
      outcome: "unreadable",
      reason: "entries must be a plain record of memory id -> entry",
    };
  }
  for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { outcome: "unreadable", reason: `entry ${id} must be an object` };
    }
    const candidate = entry as Partial<EmbeddingIndexEntry>;
    if (typeof candidate.path !== "string") {
      return { outcome: "unreadable", reason: `entry ${id}.path must be a string` };
    }
    if (!Array.isArray(candidate.vector)) {
      return { outcome: "unreadable", reason: `entry ${id}.vector must be an array` };
    }
    for (const component of candidate.vector) {
      if (!Number.isFinite(component)) {
        return {
          outcome: "unreadable",
          reason: `entry ${id}.vector must contain only finite numbers`,
        };
      }
    }
  }
  return { outcome: "ok", file: parsed as EmbeddingIndexFile };
}

/**
 * Group a complete index into per-shard entry records using the stable FNV
 * assignment. Shared by `persist()` and the offline-sync generation
 * transaction so a converted generation shards identically everywhere.
 */
export function shardEntriesForIndex(
  index: EmbeddingIndexFile,
): Map<number, Record<string, EmbeddingIndexEntry>> {
  const groups = new Map<number, Record<string, EmbeddingIndexEntry>>();
  for (const id of Object.keys(index.entries)) {
    const shardIndex = shardIndexOf(id, SHARD_COUNT);
    const group = groups.get(shardIndex);
    if (group) group[id] = index.entries[id];
    else groups.set(shardIndex, { [id]: index.entries[id] });
  }
  return groups;
}

/**
 * Serialize one shard, translating a ceiling overflow into a tagged,
 * recoverable capacity error. Exported for the offline-sync generation
 * transaction, which stages incoming generations through the same budget.
 */
export function serializeEmbeddingShard(
  index: EmbeddingIndexFile,
  shardIndex: number,
  entries: Record<string, EmbeddingIndexEntry>,
  limit: number = resolveIndexFileCharLimit(),
): string {
  let body: string;
  try {
    body = JSON.stringify({
      version: 1 as const,
      provider: index.provider,
      model: index.model,
      entries,
    });
  } catch (err) {
    throw new EmbeddingIndexCapacityError(
      `embedding index shard ${shardFileName(shardIndex)} exceeded the single-string ceiling while serializing: ${err instanceof Error ? err.message : String(err)}`,
      largestEntryId(entries) || undefined,
    );
  }
  if (body.length > limit) {
    const worstId = largestEntryId(entries);
    const worstLength = worstId && entries[worstId] ? JSON.stringify(entries[worstId]).length : 0;
    throw new EmbeddingIndexCapacityError(
      `embedding index shard ${shardFileName(shardIndex)} needs ${body.length} chars, over the ${limit}-char single-file limit; largest entry ${worstId || "(unknown)"} serializes to ${worstLength} chars`,
      worstId || undefined,
    );
  }
  return body;
}

function largestEntryId(entries: Record<string, EmbeddingIndexEntry>): string {
  let worstId = "";
  let worstLength = 0;
  for (const [id, entry] of Object.entries(entries)) {
    let length: number;
    try {
      length = JSON.stringify(entry).length;
    } catch {
      return id;
    }
    if (length > worstLength) {
      worstLength = length;
      worstId = id;
    }
  }
  return worstId;
}

/**
 * Optional canonical secure-store IO for the daemon. When provided (both
 * halves), file content is read/written through the SAME
 * StorageManager-backed contract offline sync uses: canonical-path AAD,
 * secure-key-aware, atomic. Shard STAGING writes carry the FINAL published
 * path so the post-publish rename keeps the ciphertext decryptable; dirty
 * shard, status, and legacy writes are their own canonical final path.
 * When omitted, the store behaves exactly as before (raw plaintext fs).
 * The diagnostics status file is intentionally ALWAYS plain: it holds no
 * memory content (failure strings/counts only) and console_state reads it
 * without unlocking the store.
 */
export interface EmbeddingIndexStoreIo {
  readUtf8(filePath: string): Promise<string>;
  writeUtf8(filePath: string, contents: string, opts?: { finalAadFilePath?: string }): Promise<void>;
}

export class EmbeddingIndexFileStore {
  constructor(
    private readonly indexPath: string,
    private readonly shardDir: string,
    private readonly statusPath: string,
    private readonly io?: EmbeddingIndexStoreIo,
  ) {
    if (io && (Boolean(io.readUtf8) !== Boolean(io.writeUtf8))) {
      throw new EmbeddingIndexStorageError(
        "embedding index store io requires both readUtf8 and writeUtf8; a half-wired io would mix encrypted and plaintext files",
      );
    }
  }

  /** Legacy single-file layout path (public for error messages). */
  get legacyPath(): string {
    return this.indexPath;
  }

  /** Record an unreadable-authoritative-file reason (both read and mutation paths). */
  async recordIndexStatusForLoad(reason: string): Promise<void> {
    await this.recordIndexStatus({
      lastReadRecovery: { ts: new Date().toISOString(), message: reason },
    });
  }

  /**
   * Which generation owns the index right now. The published
   * `state/embeddings/` directory IS the layout marker: until it exists the
   * legacy file is authoritative; from the atomic rename onward it never
   * merges again.
   */
  async detectLayout(): Promise<IndexLayout> {
    // An interrupted identity replacement leaves the published directory
    // absent with the fixed transaction backup still on disk (the publish
    // rename never completed). Report SHARDED for that gap: the backup holds
    // the authoritative generation, so neither the legacy file nor a fresh
    // index may win, and reads fail open to empty until the mutation queue
    // performs the rollback. The rollback itself only ever runs inside
    // persist() — a write — so read paths never race an in-flight
    // replacement with a recovery rename (issue #3148 review).
    try {
      await stat(this.shardDir);
      return "sharded";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // The pointer exists but cannot be stat'ed — fail towards the
        // published generation so its readers surface the I/O error.
        log.warn(`embedding index: shard dir stat failed (${err instanceof Error ? err.message : String(err)}); assuming sharded layout`);
        return "sharded";
      }
      if (await this.replacementBackupExists()) return "sharded";
      return this.legacyOrEmptyLayout();
    }
  }

  /**
   * Roll the fixed transaction backup back into the published position.
   * Returns true when a rollback happened.
   */
  private async replacementBackupExists(): Promise<boolean> {
    const backupPath = replacementBackupPath(this.shardDir);
    try {
      await stat(backupPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      // An unreadable backup must not be silently treated as absent —
      // that would permit the legacy fallback over a generation we cannot
      // inspect (issue #3148 review, round 1).
      throw new EmbeddingIndexStorageError(
        `cannot stat embedding index replacement backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The fixed transaction backup is a path with well-known semantics; a
   * planted symlink must never be restored into the published position (it
   * would point the generation outside the memory dir) nor removed through
   * as if it were the former generation. Symlinks are rejected outright.
   */
  private async assertBackupNotSymlink(backupPath: string): Promise<void> {
    const info = await lstat(backupPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    });
    if (info?.isSymbolicLink()) {
      throw new EmbeddingIndexStorageError(
        `embedding index replacement backup is a symlink; refusing to touch it: ${backupPath}`,
      );
    }
  }

  /**
   * Mutation-queue entry point: roll the fixed transaction backup back into
   * the published position after an interrupted replacement. Returns true
   * when a rollback happened. Only fires in the actual rename gap
   * (published directory absent); callers must invalidate any cached index
   * view when this returns true.
   */
  async recoverIfInterrupted(): Promise<boolean> {
    // Only the rename gap (published directory absent) is recoverable. When
    // the directory is present - including after a crash that followed a
    // successful publish - the generation on disk is already authoritative
    // and renaming the backup onto it would fail with EEXIST (issue #3148
    // review, round 2).
    try {
      await stat(this.shardDir);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`embedding index: recovery skipped because shard dir stat failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    const backupPath = replacementBackupPath(this.shardDir);
    if (!(await this.replacementBackupExists())) return false;
    await this.assertBackupNotSymlink(backupPath);
    await rename(backupPath, this.shardDir);
    log.warn(
      `embedding index: recovered interrupted replacement; former generation restored from ${backupPath}`,
    );
    await this.recordIndexStatus({
      lastReadRecovery: {
        ts: new Date().toISOString(),
        message: "interrupted identity replacement rolled back to the former generation",
      },
    });
    return true;
  }

  private async legacyOrEmptyLayout(): Promise<IndexLayout> {
    try {
      await stat(this.indexPath);
      return "legacy";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "empty";
      throw err;
    }
  }

  /** Header identity of the authoritative generation, read leniently. */
  async identityFromDisk(): Promise<EmbeddingIndexIdentity | null> {
    const layout = await this.detectLayout();
    if (layout === "sharded") {
      // Shard files are bounded by the per-file budget, so the identity
      // probe never reads a ceiling-sized string.
      for (const name of await this.readShardNames()) {
        const read = await this.readFileAt(path.join(this.shardDir, name));
        if (read.outcome === "ok") {
          return { provider: read.file.provider, model: read.file.model };
        }
      }
      return null;
    }
    if (layout === "legacy") {
      const read = await this.readFileAt(this.indexPath);
      if (read.outcome === "ok") {
        return { provider: read.file.provider, model: read.file.model };
      }
    }
    return null;
  }

  /**
   * Load every readable shard into `merged`. Returns the generation identity.
   * Unreadable shards record durable diagnostics; `strict` additionally
   * fails the mutation closed.
   */
  async readShardGenerationInto(
    merged: Record<string, EmbeddingIndexEntry>,
  ): Promise<EmbeddingIndexIdentity | null> {
    let identity: EmbeddingIndexIdentity | null = null;
    for (const name of await this.readShardNames()) {
      const read = await this.readFileAt(path.join(this.shardDir, name));
      if (read.outcome !== "ok") {
        if (read.outcome === "unreadable") {
          await this.recordIndexStatus({
            lastReadRecovery: { ts: new Date().toISOString(), message: `${name}: ${read.reason}` },
          });
          throw new EmbeddingIndexStorageError(
            `refusing to continue from unreadable embedding index shard ${name}: ${read.reason}`,
          );
        }
        await this.recordIndexStatus({
          lastReadRecovery: { ts: new Date().toISOString(), message: `${name}: unrecognized index format` },
        });
        throw new EmbeddingIndexStorageError(
          `refusing to continue from malformed embedding index shard ${name} (unrecognized format); file preserved in place`,
        );
      }
      validateShardMembership(name, read.file);
      const shardIdentity = { provider: read.file.provider, model: read.file.model };
      if (!identity) identity = shardIdentity;
      if (!sameIndexIdentity(shardIdentity, identity)) {
        // A partial rewrite from this map would silently drop the foreign
        // shard's entries, so even recall must not serve this generation.
        throw new EmbeddingIndexStorageError(
          `refusing to continue from mixed-identity embedding index generation: ${name} is ${shardIdentity.provider}/${shardIdentity.model} but the generation identity is ${identity.provider}/${identity.model}; files preserved in place`,
        );
      }
      Object.assign(merged, read.file.entries);
    }
    return identity;
  }

  async readLegacy(): Promise<ManagedIndexRead> {
    return this.readFileAt(this.indexPath);
  }

  /**
   * Read one managed index file (legacy or shard). The file is never
   * modified or moved here: an unreadable file stays in place for recovery
   * and is reported through the returned outcome (mutation paths fail
   * closed on it; read-only paths fail open and record the reason).
   */
  async readFileAt(filePath: string): Promise<ManagedIndexRead> {
    const hardLimit = resolveIndexHardReadCharLimit();
    let size = 0;
    try {
      size = (await stat(filePath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "absent" };
      return { outcome: "unreadable", reason: `stat failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Reads are gated by the HARD single-string ceiling only — NOT by the
    // soft write budget — so a legacy index from an older version sitting
    // between the two still loads and migrates (issue #3146). Byte size is
    // only a conservative bound for UTF-8 (bytes ≥ chars): at or below it a
    // readFile is guaranteed materializable; past it the file MAY still be
    // readable as a string, but refusing is the safe side. An over-ceiling
    // file is preserved in place; the caller decides fail-open (recall) or
    // fail-closed (mutation).
    if (size > hardLimit) {
      return {
        outcome: "unreadable",
        reason: `file is ${size} bytes, over the ${hardLimit}-char hard single-string read ceiling (V8 RangeError territory); bytes preserved in place — move or prune the file to recover`,
      };
    }
    let raw: string;
    try {
      raw = this.io
        ? await this.io.readUtf8(filePath)
        : await readFile(filePath, "utf-8");
    } catch (err) {
      return { outcome: "unreadable", reason: `read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return parseEmbeddingIndexDocument(raw);
  }

  private async readShardNames(): Promise<string[]> {
    try {
      return (await readdir(this.shardDir))
        .filter((name) => SHARD_FILE_PATTERN.test(name))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      // The published generation exists but cannot be enumerated. Treating
      // it as empty would let a mutation overwrite shards it never saw, so
      // this must propagate — strict mutation fails closed, recall fails
      // open at its boundary (issue #3146 review).
      throw new EmbeddingIndexStorageError(
        `cannot enumerate embedding index shard directory ${this.shardDir}: ${err instanceof Error ? `${err.message} (${(err as NodeJS.ErrnoException).code ?? "unknown"})` : String(err)}`,
      );
    }
  }

  /**
   * Persist the index. Layout decisions, in order:
   *   - published generation: rewrite only the shards this mutation touched;
   *   - legacy/empty generation and the whole index fits one bounded JSON
   *     string: stay the single `state/embeddings.json` file;
   *   - over budget: ONE-WAY migration — stage a complete shard set, publish
   *     it with a single directory rename, then rename the legacy file aside
   *     as a non-authoritative recovery artifact (issue #3146).
   */
  async persist(
    index: EmbeddingIndexFile,
    opts: { touchedIds?: readonly string[]; memoryId?: string } = {},
  ): Promise<void> {
    const stateDir = path.dirname(this.indexPath);
    await mkdir(stateDir, { recursive: true });
    await this.cleanForeignStagingDirs();
    // NOTE: interrupted-replacement recovery runs in the mutation wrapper
    // (EmbeddingFallback.enqueueIndexMutation) BEFORE this method, so the
    // caller's index already reflects the restored generation.

    const groups = shardEntriesForIndex(index);

    const layout = await this.detectLayout();

    if (layout === "sharded") {
      const limit = resolveIndexFileCharLimit();
      // An identity change on a published generation (a sharded host index
      // replaced by a fallback provider, or a host-model change) must
      // publish a COMPLETE replacement: the dirty-shard fast path would
      // rewrite only the touched shard under the new identity and leave the
      // former identity's shards in place — a mixed generation that every
      // later load rejects (codex P1, PR #3148).
      const diskIdentity = await this.identityFromDisk();
      const identityChanged =
        diskIdentity !== null &&
        (diskIdentity.provider !== index.provider || diskIdentity.model !== index.model);
      if (identityChanged) {
        await this.publishReplacementGeneration(index, groups, limit);
        return;
      }
      const dirtyShards = opts.touchedIds?.length
        ? new Set(opts.touchedIds.map((id) => shardIndexOf(id, SHARD_COUNT)))
        : null;
      // Serialize every touched shard BEFORE writing anything so a capacity
      // failure cannot leave a partial rewrite.
      const targets = dirtyShards ? [...dirtyShards] : [...groups.keys()];
      const payloads = targets
        .filter((shardIndex) => groups.has(shardIndex))
        .map((shardIndex) => ({
          shardIndex,
          body: serializeEmbeddingShard(index, shardIndex, groups.get(shardIndex)!, limit),
        }));
      for (const payload of payloads) {
        await this.writeAtomicFile(
          path.join(this.shardDir, shardFileName(payload.shardIndex)),
          payload.body,
        );
      }
      // A dirty shard with no remaining entries (its last entry was just
      // removed) must be removed from disk, not silently skipped.
      for (const shardIndex of targets) {
        if (!groups.has(shardIndex)) {
          await rm(path.join(this.shardDir, shardFileName(shardIndex)), { force: true });
        }
      }
      return;
    }

    let whole: string | null;
    try {
      whole = JSON.stringify(index);
    } catch (err) {
      if (!isInvalidStringLengthError(err)) throw err;
      whole = null;
    }
    const limit = resolveIndexFileCharLimit();
    if (whole !== null && whole.length <= limit) {
      await this.writeAtomicFile(this.indexPath, whole);
      return;
    }

    // One-way migration. Until the publish rename, the legacy file stays
    // authoritative; afterwards the published directory is the only
    // generation and the legacy file is demoted to a recovery artifact.
    const stagingDir = path.join(
      stateDir,
      `embeddings.staging.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(stagingDir, { recursive: true });
    try {
      await this.stageShardSet(stagingDir, index, groups, limit);
      // Atomic publish: the directory appearing IS the layout marker.
      await this.publishSwappedGeneration(stagingDir);
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    await rename(
      this.indexPath,
      `${this.indexPath}.pre-migration.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ).catch(() => undefined);
  }

  /**
   * Replace a published generation wholesale after a provider/model identity
   * change (replacement semantics — the former entries are obsolete by
   * definition). Crash-safe by the same construction as the migration: the
   * COMPLETE new-identity set is staged and validated first (old bytes are
   * not touched until staging succeeds), then published atomically through
   * `publishSwappedGeneration`.
   */
  private async publishReplacementGeneration(
    index: EmbeddingIndexFile,
    groups: Map<number, Record<string, EmbeddingIndexEntry>>,
    limit: number,
  ): Promise<void> {
    const stateDir = path.dirname(this.indexPath);
    const stagingDir = path.join(
      stateDir,
      `embeddings.staging.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(stagingDir, { recursive: true });
    try {
      await this.stageShardSet(stagingDir, index, groups, limit);
      await this.publishSwappedGeneration(stagingDir);
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Write a complete shard set into a staging directory. Every shard is
   * serialized before the first write, so a capacity failure cannot leave a
   * partial stage behind.
   */
  private async stageShardSet(
    stagingDir: string,
    index: EmbeddingIndexFile,
    groups: Map<number, Record<string, EmbeddingIndexEntry>>,
    limit: number,
  ): Promise<void> {
    const payloads = [...groups]
      .filter(([, entries]) => Object.keys(entries).length > 0)
      .map(([shardIndex, entries]) => ({
        shardIndex,
        body: serializeEmbeddingShard(index, shardIndex, entries, limit),
      }));
    for (const payload of payloads) {
      const finalAadFilePath = path.join(this.shardDir, shardFileName(payload.shardIndex));
      await this.writeAtomicFile(
        path.join(stagingDir, shardFileName(payload.shardIndex)),
        payload.body,
        { finalAadFilePath },
      );
    }
  }

  /**
   * Atomically publish a fully staged generation directory as THE published
   * generation. The former published directory is demoted to the FIXED
   * transaction backup and the staging dir is renamed in with a single
   * rename; if the publish rename fails the former generation is rolled
   * back, and if the process dies in the rename gap `detectLayout()` /
   * `recoverIfInterrupted()` perform the same rollback on next use.
   * Shared by the mutation-side migration/replacement and the offline-sync
   * generation transaction (issue #3148, round 4) so there is exactly one
   * swap state machine. Staging-dir cleanup stays with the caller.
   */
  async publishSwappedGeneration(stagingDir: string): Promise<void> {
    // The replacement is published: the backup is obsolete disk. A cleanup
    // failure is non-fatal (the next replacement removes it) but must stay
    // visible.
    const backupPath = replacementBackupPath(this.shardDir);
    await this.assertBackupNotSymlink(backupPath);
    await rm(backupPath, { recursive: true, force: true });
    let demoted = false;
    try {
      await stat(this.shardDir);
      await rename(this.shardDir, backupPath);
      demoted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      await rename(stagingDir, this.shardDir);
    } catch (err) {
      if (demoted) await rename(backupPath, this.shardDir).catch(() => undefined);
      throw err;
    }
    await rm(backupPath, { recursive: true, force: true }).catch((err) => {
      log.warn(`embedding index: could not remove replacement backup ${backupPath}: ${err}`);
    });
  }

  /** Remove staging dirs orphaned by crashed migrations. A foreign dir younger than the grace window may belong to a live writer mid-migration, so only older dirs are removed (issue #3148 review, round 3). */
  private static readonly STAGING_CLEANUP_GRACE_MS = 10 * 60 * 1000;

  private async cleanForeignStagingDirs(): Promise<void> {
    const stateDir = path.dirname(this.indexPath);
    let names: string[] = [];
    try {
      names = await readdir(stateDir);
    } catch {
      return;
    }
    const ownPrefix = `embeddings.staging.tmp-${process.pid}-`;
    const cutoff = Date.now() - EmbeddingIndexFileStore.STAGING_CLEANUP_GRACE_MS;
    for (const name of names) {
      if (!name.startsWith("embeddings.staging.tmp-") || name.startsWith(ownPrefix)) continue;
      try {
        const stats = await stat(path.join(stateDir, name));
        if (stats.mtimeMs > cutoff) continue;
      } catch {
        continue;
      }
      await rm(path.join(stateDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Temp-file + rename write. The temp name carries `.tmp-` so offline sync
   * ignores in-flight files under `state/`. With a wired io, the write goes
   * through the canonical secure-store contract instead, optionally binding
   * the ciphertext to the FINAL published path (staged shards).
   */
  private async writeAtomicFile(
    filePath: string,
    contents: string,
    opts?: { finalAadFilePath?: string; bypassSecureIo?: boolean },
  ): Promise<void> {
    if (this.io && opts?.bypassSecureIo !== true) {
      await this.io.writeUtf8(filePath, contents, opts?.finalAadFilePath === undefined ? undefined : { finalAadFilePath: opts.finalAadFilePath });
      return;
    }
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await writeFile(tempPath, contents, "utf-8");
      await rename(tempPath, filePath);
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Record the outcome of one index mutation durably. This is diagnostics,
   * NOT recovery: write failures are recorded and then re-thrown by the
   * caller so the extraction/consolidation task fails explicitly instead of
   * declaring success over an index that could not be persisted (issue
   * #3146).
   */
  async recordIndexWriteOutcome(err: unknown, memoryId?: string): Promise<void> {
    if (!err) {
      await this.recordIndexStatus({
        lastWriteFailure: null,
        lastSuccessAt: new Date().toISOString(),
      });
      return;
    }
    const kind: EmbeddingIndexWriteFailure["kind"] =
      err instanceof EmbeddingIndexCapacityError || isInvalidStringLengthError(err)
        ? "capacity"
        : "io";
    await this.recordIndexStatus({
      failureCountIncrement: 1,
      lastWriteFailure: {
        ts: new Date().toISOString(),
        kind,
        message: err instanceof Error ? err.message : String(err),
        ...(memoryId ? { memoryId } : {}),
      },
    });
  }

  /**
   * Merge diagnostic state into `state/embedding-fallback-status.json`.
   * Best-effort: a diagnostics failure never masks the real outcome.
   */
  private async recordIndexStatus(
    patch: {
      failureCountIncrement?: number;
      lastWriteFailure?: EmbeddingIndexWriteFailure | null;
      lastReadRecovery?: { ts: string; message: string };
      lastSuccessAt?: string;
    },
  ): Promise<void> {
    try {
      let current: EmbeddingIndexStatusFile = { version: 1, failureCount: 0 };
      try {
        const parsed = JSON.parse(await readFile(this.statusPath, "utf-8")) as Partial<EmbeddingIndexStatusFile>;
        if (parsed && typeof parsed === "object" && typeof parsed.failureCount === "number") {
          current = { ...parsed, version: 1, failureCount: parsed.failureCount };
        }
      } catch {
        // Absent or unreadable status starts fresh; the index files own the truth.
      }
      const next: EmbeddingIndexStatusFile = { ...current };
      if (patch.failureCountIncrement) next.failureCount += patch.failureCountIncrement;
      if (patch.lastWriteFailure !== undefined) {
        if (patch.lastWriteFailure === null) delete next.lastWriteFailure;
        else next.lastWriteFailure = patch.lastWriteFailure;
      }
      if (patch.lastReadRecovery !== undefined) next.lastReadRecovery = patch.lastReadRecovery;
      if (patch.lastSuccessAt !== undefined) next.lastSuccessAt = patch.lastSuccessAt;
      // The status file is ALWAYS plain (non-secret diagnostics: failure
      // strings and counts only). It bypasses the secure io so console_state
      // keeps reading it on locked stores and failure counts never reset.
      await mkdir(path.dirname(this.statusPath), { recursive: true });
      await this.writeAtomicFile(this.statusPath, JSON.stringify(next), { bypassSecureIo: true });
    } catch (err) {
      log.debug(`embedding fallback status write failed: ${err}`);
    }
  }
}

function sameIndexIdentity(
  left: EmbeddingIndexIdentity,
  right: EmbeddingIndexIdentity,
): boolean {
  return left.provider === right.provider && left.model === right.model;
}
