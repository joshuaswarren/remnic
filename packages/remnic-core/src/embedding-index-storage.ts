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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

export function isInvalidStringLengthError(err: unknown): boolean {
  return err instanceof RangeError && /invalid string length/i.test(err.message);
}

export class EmbeddingIndexFileStore {
  constructor(
    private readonly indexPath: string,
    private readonly shardDir: string,
    private readonly statusPath: string,
  ) {}

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
    // rename never completed). Roll the former generation back BEFORE layout
    // selection: its vectors stay authoritative and a stray legacy file
    // cannot resurrect over them (issue #3146 review).
    let shardDirPresent = false;
    try {
      await stat(this.shardDir);
      shardDirPresent = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // The pointer exists but cannot be stat'ed — fail towards the
        // published generation so its readers surface the I/O error.
        return "sharded";
      }
      if (await this.rollbackInterruptedReplacement()) {
        log.warn(
          `embedding index: recovered interrupted replacement; former generation restored from ${replacementBackupPath(this.shardDir)}`,
        );
        await this.recordIndexStatus({
          lastReadRecovery: {
            ts: new Date().toISOString(),
            message: "interrupted identity replacement rolled back to the former generation",
          },
        });
        // The rollback IS the layout decision: the restored generation is
        // authoritative on THIS call — falling through would let a stray
        // legacy file win (issue #3148 review, round 1).
        return "sharded";
      }
    }
    if (shardDirPresent) return "sharded";
    return this.legacyOrEmptyLayout();
  }

  /**
   * Roll the fixed transaction backup back into the published position.
   * Returns true when a rollback happened.
   */
  private async rollbackInterruptedReplacement(): Promise<boolean> {
    const backupPath = replacementBackupPath(this.shardDir);
    let backupPresent = false;
    try {
      await stat(backupPath);
      backupPresent = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // An unreadable backup must not be silently treated as absent —
        // that would permit the legacy fallback over a generation we cannot
        // inspect (issue #3148 review, round 1).
        throw new EmbeddingIndexStorageError(
          `cannot stat embedding index replacement backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!backupPresent) return false;
    await rename(backupPath, this.shardDir);
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
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      return { outcome: "unreadable", reason: `read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
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
      parsed &&
      typeof parsed === "object" &&
      (parsed as Partial<EmbeddingIndexFile>).version === 1 &&
      typeof (parsed as Partial<EmbeddingIndexFile>).provider === "string" &&
      typeof (parsed as Partial<EmbeddingIndexFile>).model === "string" &&
      (parsed as Partial<EmbeddingIndexFile>).entries &&
      typeof (parsed as Partial<EmbeddingIndexFile>).entries === "object"
    ) {
      return { outcome: "ok", file: parsed as EmbeddingIndexFile };
    }
    return { outcome: "foreign" };
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

    const groups = new Map<number, Record<string, EmbeddingIndexEntry>>();
    for (const id of Object.keys(index.entries)) {
      const shardIndex = shardIndexOf(id, SHARD_COUNT);
      const group = groups.get(shardIndex);
      if (group) group[id] = index.entries[id];
      else groups.set(shardIndex, { [id]: index.entries[id] });
    }

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
          body: this.serializeShard(index, shardIndex, groups.get(shardIndex)!, limit),
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
      for (const [shardIndex, entries] of groups) {
        if (Object.keys(entries).length === 0) continue;
        await this.writeAtomicFile(
          path.join(stagingDir, shardFileName(shardIndex)),
          this.serializeShard(index, shardIndex, entries, limit),
        );
      }
      // Atomic publish: the directory appearing IS the layout marker.
      await rename(stagingDir, this.shardDir);
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
   * not touched until staging succeeds), the published directory is renamed
   * aside atomically as a recovery artifact, and the staging dir is
   * published with a single atomic rename. No rename ever targets a
   * non-empty directory, and a crash at any point converges to one valid
   * single generation on the next write.
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
      for (const [shardIndex, entries] of groups) {
        if (Object.keys(entries).length === 0) continue;
        await this.writeAtomicFile(
          path.join(stagingDir, shardFileName(shardIndex)),
          this.serializeShard(index, shardIndex, entries, limit),
        );
      }
      // Demote the former generation to the FIXED transaction backup, then
      // publish the replacement. If the publish rename fails, roll the
      // former generation back into place; if the process dies in the gap,
      // detectLayout() performs the same rollback on next use.
      const backupPath = replacementBackupPath(this.shardDir);
      await rm(backupPath, { recursive: true, force: true });
      await rename(this.shardDir, backupPath);
      try {
        await rename(stagingDir, this.shardDir);
      } catch (err) {
        await rename(backupPath, this.shardDir).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Remove staging dirs orphaned by crashed migrations; never this process's own. */
  private async cleanForeignStagingDirs(): Promise<void> {
    const stateDir = path.dirname(this.indexPath);
    let names: string[] = [];
    try {
      names = await readdir(stateDir);
    } catch {
      return;
    }
    const ownPrefix = `embeddings.staging.tmp-${process.pid}-`;
    for (const name of names) {
      if (!name.startsWith("embeddings.staging.tmp-") || name.startsWith(ownPrefix)) continue;
      await rm(path.join(stateDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Serialize one shard, translating a ceiling overflow into a tagged, recoverable capacity error. */
  private serializeShard(
    index: EmbeddingIndexFile,
    shardIndex: number,
    entries: Record<string, EmbeddingIndexEntry>,
    limit: number,
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
        this.largestEntryId(entries) || undefined,
      );
    }
    if (body.length > limit) {
      const worstId = this.largestEntryId(entries);
      const worstLength = worstId && entries[worstId] ? JSON.stringify(entries[worstId]).length : 0;
      throw new EmbeddingIndexCapacityError(
        `embedding index shard ${shardFileName(shardIndex)} needs ${body.length} chars, over the ${limit}-char single-file limit; largest entry ${worstId || "(unknown)"} serializes to ${worstLength} chars`,
        worstId || undefined,
      );
    }
    return body;
  }

  private largestEntryId(entries: Record<string, EmbeddingIndexEntry>): string {
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
   * Temp-file + rename write. The temp name carries `.tmp-` so offline sync
   * ignores in-flight files under `state/`.
   */
  private async writeAtomicFile(filePath: string, contents: string): Promise<void> {
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
      await mkdir(path.dirname(this.statusPath), { recursive: true });
      await this.writeAtomicFile(this.statusPath, JSON.stringify(next));
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
