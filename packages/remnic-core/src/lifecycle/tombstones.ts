// ---------------------------------------------------------------------------
// lifecycle/tombstones.ts — Tombstone store + non-resurrection invariant
// (issue #1579)
//
// A "tombstone" records that a fact has been retired (corrected, superseded,
// or retracted) so that the SAME fact cannot silently come back to life through
// any of the five resurrection paths:
//
//   1. Re-extraction (session replay, re-observation)
//   2. Importers (capsule / import-* payloads)
//   3. Consolidation merges
//   4. Dreams (REM re-derivation)
//   5. Pattern reinforcement (duplicate promotion)
//
// The invariant is enforced at the SINGLE storage persist path
// (`StorageManager.writeMemory` — the same chokepoint that records catalog
// writes, issue #1522). Every write path funnels through it, so paths (a)–(e)
// are blocked WITHOUT per-path code.
//
// File-first / rebuildable (the repo's storage philosophy): the JSONL at
// `<stateDir>/tombstones.jsonl` is a cache of truth. The authoritative sources
// are the memory files themselves (status: superseded/retracted) and the
// `corrections/` records. `rebuildTombstonesFromStorage` reconstructs the
// JSONL from those sources.
//
// Design rules honored (issue #1579 design section):
//   - Hash `rawContent` exactly as the dedup index does — one helper
//     (`ContentHashIndex.computeHash` / `normalizeContent`), never a second
//     (checklist §13; rule 23).
//   - Append-only log — never rewrite history; a later `kind: "revocation"`
//     entry re-allows (rule 25).
//   - Instance-scoped, never module-level (rule 11).
//   - Namespace-scoped — a tombstone in namespace A never blocks namespace B
//     (rule 42).
//   - Serialized appends with rejection recovery (rule 40).
//   - Never silent drop — a blocked write lands as pending_review + blockedBy
//     (rule 34).
//   - Do NOT register a blocked fact as an active dedup/index entry (rule 44).
//   - Off = pre-feature behavior for rollback safety (rule 30).
//   - Semantic tier (4) ships dark, off by default (rule 48).
// ---------------------------------------------------------------------------

import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import { computeLegacyContentHash, isUnambiguousLegacyContentHash } from "../content-hash.js";

/** Why a tombstone was emitted. */
export type TombstoneReason =
  | "correction"
  | "supersession"
  | "retraction"
  | "contradiction_resolution";

/** Who emitted the tombstone. */
export type TombstoneCreatedBy =
  | "user_correction"
  | "contradiction_resolution"
  | "supersession"
  | "chat";

/** Tier that matched on lookup. */
export type TombstoneMatchTier = "exact" | "normalized" | "keyed" | "semantic";

/**
 * A single append-only tombstone log entry.
 *
 * `kind: "tombstone"` blocks; `kind: "revocation"` re-allows. The log is
 * never rewritten — the NEWEST matching entry wins at lookup (rule 25).
 */
export interface TombstoneEntry {
  /** Stable tombstone id (`tomb-<ts>-<rand>`). */
  id: string;
  kind: "tombstone" | "revocation";
  reason: TombstoneReason;
  /** The memory that was retired. */
  sourceMemoryId: string;
  /** sha256 of the retired identity; explicit contentHashSource may define it. */
  contentHash: string;
  /** Current body hash retained alongside an ambiguous or explicit primary hash. */
  currentContentHashAlias?: string;
  /** Current normalized body used by the normalized lookup tier. */
  normalizedText: string;
  /** Version of the current body identity fields. */
  normalizerVersion?: number;
  entityRef?: string;
  /** Structured-attribute supersession key when one existed. */
  supersessionKey?: string;
  /** Stable operation identity for crash-recovery replay. */
  operationKey?: string;
  /** Namespace scope (rule 42). */
  namespace: string;
  createdAt: string;
  createdBy: TombstoneCreatedBy;
  /** For `kind: "revocation"`: the tombstone id being revoked. */
  revokes?: string;
}

/** A positive block decision returned by `TombstoneStore.lookup`. */
export interface TombstoneMatch {
  tombstoneId: string;
  matchedTier: TombstoneMatchTier;
  reason: TombstoneReason;
}

/** Inputs to a lookup. At least one discriminator must be present.
 *
 * Issue #1579 thread Ociag/Oci-W: `supersessionKeys` (plural) lets the write
 * chokepoint check EVERY derived key, not just the first. Emitters register
 * one tombstone per matched key (temporal-supersession, rebuild), so a block
 * can live on any later key; querying only `supersessionKeys[0]` missed it
 * and the retired fact resurrected as active. `supersessionKey` (singular)
 * remains for direct/unit callers; `lookup` checks the union of both. */
export interface TombstoneLookupQuery {
  contentHash?: string;
  normalizedText?: string;
  entityRef?: string;
  /** Single supersession key (direct/unit callers). */
  supersessionKey?: string;
  /** All derived supersession keys (write chokepoint). The keyed tier is
   * checked for each; the first active match wins. */
  supersessionKeys?: string[];
  namespace: string;
}

/** Configuration for a tombstone store instance. */
export interface TombstoneStoreOptions {
  enabled: boolean;
  semanticMatch: boolean;
  semanticThreshold: number;
  /** sha256 of raw content — wired to `ContentHashIndex.computeHash`. */
  hashContent: (raw: string) => string;
  /** Normalize raw content — wired to `ContentHashIndex.normalizeContent`. */
  normalizeText: (raw: string) => string;
  /**
   * Optional cosine similarity in [0, 1] for the semantic tier. When
   * undefined or when `semanticMatch` is false, the semantic tier is
   * skipped entirely.
   */
  semanticSimilarity?: (a: string, b: string) => number;
  /**
   * Resolve source identity candidates for bounded legacy sourceMemoryIds.
   * StorageManager reads the corpus before the tombstone write lock.
   */
  readonly sourceContentsForMemoryIds?: (
    sourceMemoryIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string | readonly string[]>>;
  /** Maximum number of legacy entries considered during one load. */
  readonly legacyMigrationLimit?: number;
  /**
   * Cross-process write-lock timings for the tombstone JSONL mutation lock
   * (issue #1639). The secure-store append is a read-merge-write (read
   * encrypted → decrypt → concat → re-encrypt → atomic rename), so two
   * Remnic processes appending concurrently can each read the same contents
   * and the last writer drops the other's entry — breaking the
   * non-resurrection invariant. The lock serializes the mutation across
   * processes. When omitted, defaults that fit the short tombstone critical
   * section (mirroring the summary-snapshot lock): staleMs 30s, maxWaitMs 5s,
   * heartbeatMs floor(staleMs/3).
   */
  readonly lockStaleMs?: number;
  readonly lockMaxWaitMs?: number;
  readonly lockHeartbeatMs?: number;
}

/** Injected file I/O — the StorageManager wires its secure-store-aware
 * implementations so tombstones are encrypted at rest alongside other state.
 * `stat` is optional; when provided the store tracks the file mtime itself and
 * runs a cross-process staleness probe on each access (#1579). */
export interface TombstoneFileIo {
  read: (filePath: string) => Promise<string>;
  append: (filePath: string, content: string) => Promise<void>;
  write: (filePath: string, content: string) => Promise<void>;
  stat?: (filePath: string) => { mtimeMs: number };
}

/** Aggregate stats for `remnic doctor`. */
export interface TombstoneStats {
  count: number;
  revoked: number;
  lastAppendAt: string | null;
  corruptedLines: number;
  /** Whether the in-memory index matches the on-disk file (rebuild check). */
  loaded: boolean;
}

const TOMBSTONE_NORMALIZER_VERSION = 2;
const DEFAULT_LEGACY_MIGRATION_LIMIT = 10_000;

const TOMBSTONE_PREFIX = "tomb";

function newTombstoneId(): string {
  return `${TOMBSTONE_PREFIX}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Deterministic key for the keyed tier (namespace + entityRef + supersessionKey).
 *
 * The namespace is part of the discriminator so two namespace-scoped stores
 * that share the same backing `tombstones.jsonl` (namespaces disabled, or the
 * same directory used with different namespace configs) cannot overwrite each
 * other's index entries — a later tombstone for namespace B with the same
 * entity/key no longer evicts namespace A's entry (issue #1579 thread Ocs-O). */
function keyedTierKey(namespace: string, entityRef: string, supersessionKey: string): string {
  return `${namespace}\0${entityRef}\0${supersessionKey}`;
}

/**
 * Parse one JSONL line into a TombstoneEntry, validating the discriminated
 * union. Returns `null` for malformed lines (rule 34 — skip with a counter,
 * never crash).
 */
export function parseTombstoneLine(line: string): TombstoneEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const e = parsed as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  if (e.kind !== "tombstone" && e.kind !== "revocation") return null;
  if (
    e.reason !== "correction" &&
    e.reason !== "supersession" &&
    e.reason !== "retraction" &&
    e.reason !== "contradiction_resolution"
  ) {
    return null;
  }
  if (typeof e.sourceMemoryId !== "string") return null;
  if (typeof e.contentHash !== "string") return null;
  if (typeof e.normalizedText !== "string") return null;
  if (typeof e.namespace !== "string") return null;
  if (typeof e.createdAt !== "string") return null;
  if (
    e.createdBy !== "user_correction" &&
    e.createdBy !== "contradiction_resolution" &&
    e.createdBy !== "supersession" &&
    e.createdBy !== "chat"
  ) {
    return null;
  }
  const out: TombstoneEntry = {
    id: e.id,
    kind: e.kind,
    reason: e.reason,
    sourceMemoryId: e.sourceMemoryId,
    contentHash: e.contentHash,
    normalizedText: e.normalizedText,
    namespace: e.namespace,
    createdAt: e.createdAt,
    createdBy: e.createdBy,
  };
  if (typeof e.currentContentHashAlias === "string") {
    out.currentContentHashAlias = e.currentContentHashAlias;
  }
  if (typeof e.normalizerVersion === "number" && Number.isInteger(e.normalizerVersion)) {
    out.normalizerVersion = e.normalizerVersion;
  }
  if (typeof e.operationKey === "string") out.operationKey = e.operationKey;
  if (typeof e.entityRef === "string") out.entityRef = e.entityRef;
  if (typeof e.supersessionKey === "string") out.supersessionKey = e.supersessionKey;
  if (typeof e.revokes === "string") out.revokes = e.revokes;
  return out;
}

/**
 * The instance-scoped tombstone store. One per StorageManager (rule 11),
 * namespace-scoped via `namespace` + the on-disk path (rule 42).
 *
 * The in-memory index is built lazily on first access and invalidated on
 * append + by the StorageManager's cache-invalidation chokepoint (rule 25).
 */
export class TombstoneStore {
  private entries: TombstoneEntry[] = [];
  /** contentHash → tombstone id (newest) — exact tier. */
  private readonly byHash = new Map<string, string>();
  /** normalizedText → tombstone id (newest) — normalized tier. */
  private readonly byNormalized = new Map<string, string>();
  /** entityRef\0supersessionKey → tombstone id (newest) — keyed tier. */
  private readonly byKey = new Map<string, string>();
  /** Tombstone ids that have a later revocation entry. */
  private readonly revokedIds = new Set<string>();
  /** id → entry index (newest only, for revocation lookups). */
  private readonly byId = new Map<string, TombstoneEntry>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private corruptedLines = 0;
  private lastAppendAt: string | null = null;
  /**
   * Last-seen mtime of the JSONL file (cross-process staleness probe, #1579).
   * Tracked inside the store so the StorageManager wiring stays thin. When the
   * file's mtime advances past this value between accesses, the in-memory index
   * is stale (a peer process appended) and is reloaded before the next lookup.
   */
  private fileMtimeMs = 0;

  constructor(
    private readonly filePath: string,
    private readonly namespace: string,
    private readonly options: TombstoneStoreOptions,
    private readonly io: TombstoneFileIo,
  ) {
    const limit = this.options.legacyMigrationLimit;
    if (limit !== undefined && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
      throw new Error("legacyMigrationLimit must be a finite non-negative integer");
    }
    this.lockStaleMs = this.options.lockStaleMs ?? 30_000;
    this.lockMaxWaitMs = this.options.lockMaxWaitMs ?? 5_000;
    this.lockHeartbeatMs =
      this.options.lockHeartbeatMs ?? Math.max(100, Math.floor(this.lockStaleMs / 3));
  }

  /**
   * Resolved cross-process write-lock timings (issue #1639). Defaults mirror
   * the summary-snapshot lock: a tombstone append critical section is
   * sub-second, so a stale lock older than 30s is a crashed holder; bounded
   * acquisition gives up after 5s and strict-fails rather than clobbering a
   * concurrent writer (which would reintroduce the lost-write race this lock
   * closes).
   */
  private readonly lockStaleMs: number;
  private readonly lockMaxWaitMs: number;
  private readonly lockHeartbeatMs: number;

  /**
   * Sibling advisory lockfile: `<tombstones>.jsonl` → `<tombstones>.lock`.
   * Shared by append, revoke, and rebuild so every JSONL mutation serializes
   * against the others across processes (issue #1639: "shared with rebuilds").
   */
  private get lockPath(): string {
    return this.filePath.replace(/\.jsonl$/i, "") + ".lock";
  }

  /** Lazy load + build the in-memory index. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async loadInternal(migrateLegacy = true): Promise<void> {
    // Record the file mtime before reading so an ENOENT still records 0 and
    // a successful load does not immediately trigger a staleness reload.
    this.recordFileMtime();
    let raw: string;
    try {
      raw = await this.io.read(this.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
      this.loaded = true;
      return;
    }
    const initial = this.parseEntries(raw);
    const migrated = migrateLegacy
      ? await this.migrateLegacyEntries(initial)
      : initial;
    this.resetIndex();
    for (const entry of migrated.entries) this.indexEntry(entry);
    this.corruptedLines = migrated.corruptedLines;
    this.loaded = true;
  }

  private parseEntries(raw: string): {
    entries: TombstoneEntry[];
    corruptedLines: number;
  } {
    const entries: TombstoneEntry[] = [];
    let corruptedLines = 0;
    for (const line of raw.split("\n")) {
      const entry = parseTombstoneLine(line);
      if (!entry) {
        if (line.trim().length > 0) corruptedLines += 1;
        continue;
      }
      entries.push(entry);
    }
    return { entries, corruptedLines };
  }

  /**
   * Re-index pre-Unicode records from retired source content.
   * Source reads stay bounded, but every batch finishes before the store
   * publishes its in-memory index. Missing sources remain eligible on restart.
   */
  private async migrateLegacyEntries(initial: {
    entries: TombstoneEntry[];
    corruptedLines: number;
  }): Promise<{ entries: TombstoneEntry[]; corruptedLines: number }> {
    const limit = this.options.legacyMigrationLimit ?? DEFAULT_LEGACY_MIGRATION_LIMIT;
    if (limit === 0 || !this.options.sourceContentsForMemoryIds) return initial;
    const sourceMemoryIds: string[] = [];
    const requested = new Set<string>();
    for (const entry of initial.entries) {
      if (
        entry.kind !== "tombstone" ||
        entry.normalizerVersion === TOMBSTONE_NORMALIZER_VERSION
      ) {
        continue;
      }
      if (requested.has(entry.sourceMemoryId)) continue;
      requested.add(entry.sourceMemoryId);
      sourceMemoryIds.push(entry.sourceMemoryId);
    }
    if (sourceMemoryIds.length === 0) return initial;
    const sourceContents = new Map<string, string | readonly string[]>();
    for (let offset = 0; offset < sourceMemoryIds.length; offset += limit) {
      const batch = sourceMemoryIds.slice(offset, offset + limit);
      const fetched = await this.options.sourceContentsForMemoryIds(batch);
      for (const [sourceMemoryId, content] of fetched) sourceContents.set(sourceMemoryId, content);
    }
    return await serializeMutations(`tombstone:${this.filePath}`, () =>
      this.withWriteLock(async () => {
        const latestRaw = await this.io.read(this.filePath);
        const latest = this.parseEntries(latestRaw);
        let changed = false;
        const migrateEntry = (entry: TombstoneEntry): TombstoneEntry => {
          if (
            entry.kind !== "tombstone" ||
            entry.normalizerVersion === TOMBSTONE_NORMALIZER_VERSION ||
            !requested.has(entry.sourceMemoryId)
          ) {
            return entry;
          }
          const resolved = sourceContents.get(entry.sourceMemoryId);
          if (resolved === undefined) return entry;
          const candidates = typeof resolved === "string" ? [resolved] : resolved;
          const matches = candidates.filter((source) =>
            entry.contentHash === this.options.hashContent(source) ||
            entry.contentHash === computeLegacyContentHash(source)
          );
          const explicitPrimary =
            matches.length === 0 &&
            entry.contentHash !== this.options.hashContent(entry.normalizedText);
          const source = matches[0] ?? (explicitPrimary ? candidates[0] : undefined);
          if (source === undefined) return entry;
          const currentHash = this.options.hashContent(source);
          const alias = explicitPrimary
            ? currentHash
            : matches
              .map((candidate) => this.options.hashContent(candidate))
              .find((hash) => hash !== currentHash);
          changed = true;
          return {
            ...entry,
            contentHash: explicitPrimary ? entry.contentHash : currentHash,
            ...(alias ? { currentContentHashAlias: alias } : {}),
            normalizedText: this.options.normalizeText(source),
            normalizerVersion: TOMBSTONE_NORMALIZER_VERSION,
          };
        };
        const serialized = latestRaw
          .split("\n")
          .map((line) => {
            const entry = parseTombstoneLine(line);
            if (!entry) return line;
            const migrated = migrateEntry(entry);
            return migrated === entry ? line : JSON.stringify(migrated);
          })
          .join("\n");
        if (!changed) return latest;
        await this.io.write(this.filePath, serialized);
        this.markWritten();
        return this.parseEntries(serialized);
      }),
    );
  }

  private resetIndex(): void {
    this.entries = [];
    this.byHash.clear();
    this.byNormalized.clear();
    this.byKey.clear();
    this.revokedIds.clear();
    this.byId.clear();
  }

  /**
   * Index an entry. Later entries (higher array index = newer createdAt)
   * OVERRIDE earlier ones at each tier key — the newest matching entry wins
   * (rule 25). Revocation entries mark their target as revoked.
   */
  private indexEntry(entry: TombstoneEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    if (entry.createdAt > (this.lastAppendAt ?? "")) {
      this.lastAppendAt = entry.createdAt;
    }
    if (entry.kind === "revocation") {
      if (entry.revokes) this.revokedIds.add(entry.revokes);
      return;
    }
    // Tombstone entries populate the lookup maps. The namespace is part of
    // every discriminator key (issue #1579 thread Ocs-O): when two
    // namespace-scoped stores share the same backing file, a later tombstone
    // for namespace B with identical content must NOT evict namespace A's map
    // entry — otherwise A's lookup finds B's id, rejects it on namespace
    // mismatch, and misses its own still-active tombstone (resurrection).
    const ns = entry.namespace;
    if (entry.normalizerVersion === TOMBSTONE_NORMALIZER_VERSION) {
      if (entry.contentHash) this.byHash.set(`${ns}\0${entry.contentHash}`, entry.id);
      if (entry.currentContentHashAlias) {
        this.byHash.set(`${ns}\0${entry.currentContentHashAlias}`, entry.id);
      }
      if (entry.normalizedText) this.byNormalized.set(`${ns}\0${entry.normalizedText}`, entry.id);
    }
    if (entry.entityRef && entry.supersessionKey) {
      this.byKey.set(keyedTierKey(ns, entry.entityRef, entry.supersessionKey), entry.id);
    }
  }

  /** Invalidate the in-memory cache (rule 25). The next access reloads. */
  invalidate(): void {
    this.loaded = false;
    this.loadPromise = null;
    this.resetIndex();
  }

  /**
   * Cross-process staleness probe (#1579). If the file's mtime advanced since
   * the last load/own-write, a peer process appended and our in-memory index
   * is stale — invalidate and reload before the next access. Mutation callers
   * pass `migrate: false` to avoid nested serializer/lock acquisition.
   */
  async ensureFreshAgainstDisk(options: { migrate?: boolean } = {}): Promise<void> {
    if (!this.io.stat) return;
    let mtimeMs: number;
    try {
      mtimeMs = Math.floor(this.io.stat(this.filePath).mtimeMs);
    } catch {
      return; // ENOENT / permission — keep the loaded index (fail-open).
    }
    if (mtimeMs === this.fileMtimeMs && this.loaded) return;
    this.fileMtimeMs = mtimeMs;
    this.invalidate();
    if (options.migrate === false) {
      await this.loadInternal(false);
    } else {
      await this.load();
    }
  }

  /**
   * Record the file mtime after THIS process writes (append / revoke / rebuild)
   * so `ensureFreshAgainstDisk` does not treat our own write as a peer append
   * and throw away the just-updated in-memory index (#1579 — avoids a needless
   * invalidate+reload in the hot write path).
   */
  private markWritten(): void {
    this.recordFileMtime();
  }

  private recordFileMtime(): void {
    if (!this.io.stat) return;
    try {
      this.fileMtimeMs = Math.floor(this.io.stat(this.filePath).mtimeMs);
    } catch {
      // ENOENT — fresh store with no file yet; mtime stays at its current value.
    }
  }

  /**
   * Append a tombstone entry. Serialized via `serializeMutations` keyed by
   * file path so concurrent appends do not interleave, with rejection recovery
   * (rule 40 — a single failed append never poisons the chain). The in-memory
   * index is updated AFTER the durable append succeeds.
   *
   * Returns the new tombstone id.
   */
  async appendTombstone(input: {
    reason: TombstoneReason;
    createdBy: TombstoneCreatedBy;
    sourceMemoryId: string;
    rawContent: string;
    entityRef?: string;
    supersessionKey?: string;
    operationKey?: string;
    createdAt?: string;
    /**
     * Pre-computed canonical contentHash from the retired memory's frontmatter.
     * When provided, used directly so the tombstone's exact tier matches the
     * hash writeMemory computes on re-extraction (issue #1579 review: cited
     * facts must not slip past the chokepoint because the emitter hashed the
     * citation-annotated body instead of the canonical source).
     */
    contentHash?: string;
  }): Promise<string> {
    await this.load();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const id = newTombstoneId();
    const currentHash = this.options.hashContent(input.rawContent);
    const currentNormalizedText = this.options.normalizeText(input.rawContent);
    const entry: TombstoneEntry = {
      id,
      ...(input.contentHash && input.contentHash !== currentHash
        ? { currentContentHashAlias: currentHash }
        : {}),
      kind: "tombstone",
      reason: input.reason,
      sourceMemoryId: input.sourceMemoryId,
      contentHash: input.contentHash ?? currentHash,
      normalizedText: currentNormalizedText,
      normalizerVersion: TOMBSTONE_NORMALIZER_VERSION,
      ...(input.entityRef ? { entityRef: input.entityRef } : {}),
      ...(input.supersessionKey ? { supersessionKey: input.supersessionKey } : {}),
      ...(input.operationKey ? { operationKey: input.operationKey } : {}),
      namespace: this.namespace,
      createdAt,
      createdBy: input.createdBy,
    };
    await this.serializeAppend(entry);
    this.indexEntry(entry);
    this.markWritten();
    await this.migrateLoadedLegacyEntries();
    return id;
  }

  /**
   * Append a revocation entry referencing `tombstoneId`. The log is
   * append-only; lookup treats a revoked tombstone as re-allowed (rule 25).
   */
  async revoke(tombstoneId: string, createdBy: TombstoneCreatedBy): Promise<string> {
    await this.load();
    const createdAt = new Date().toISOString();
    const id = newTombstoneId();
    const entry: TombstoneEntry = {
      id,
      kind: "revocation",
      reason: "correction",
      sourceMemoryId: "",
      contentHash: "",
      normalizedText: "",
      namespace: this.namespace,
      createdAt,
      createdBy,
      revokes: tombstoneId,
    };
    await this.serializeAppend(entry);
    this.indexEntry(entry);
    this.markWritten();
    await this.migrateLoadedLegacyEntries();
    return id;
  }

  private serializeAppend(entry: TombstoneEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    // serializeMutations (in-process, rule 40 rejection recovery) wraps the
    // cross-process lock: within one process appends are queued, and across
    // processes the advisory lockfile serializes the read-merge-write so two
    // Remnic processes appending concurrently cannot drop each other's entry
    // (issue #1639). Under the lock we re-sync the in-memory index against
    // disk first, so indexEntry builds on the peer's just-appended entries.
    return serializeMutations(`tombstone:${this.filePath}`, () =>
      this.withWriteLock(async () => {
        await this.ensureFreshAgainstDisk({ migrate: false });
        await this.io.append(this.filePath, line);
      }),
    );
  }

  private async migrateLoadedLegacyEntries(): Promise<void> {
    const initial = {
      entries: [...this.entries],
      corruptedLines: this.corruptedLines,
    };
    if (!initial.entries.some(
      (entry) => entry.kind === "tombstone" && entry.normalizerVersion !== TOMBSTONE_NORMALIZER_VERSION,
    )) {
      return;
    }
    try {
      const migrated = await this.migrateLegacyEntries(initial);
      this.resetIndex();
      for (const entry of migrated.entries) this.indexEntry(entry);
      this.corruptedLines = migrated.corruptedLines;
      this.loaded = true;
    } catch {
      // The durable mutation already succeeded; defer migration to next load.
    }
  }

  /**
   * Acquire the cross-process tombstone write lock and run `task` under it
   * (issue #1639). Strict-fail on acquisition timeout: the secure-store append
   * is a read-merge-write, so a best-effort unlocked run would clobber a
   * concurrent writer — reintroducing the lost-write race this lock closes.
   * The thrown error surfaces to the caller (rule 34: never silently drop);
   * rebuild recovers the tombstone on the next maintenance cycle.
   *
   * In-process callers are already serialized by serializeMutations (one key
   * for append/revoke/rebuild), so this lock only contends across processes —
   * the single-process daemon (default deployment) acquires it immediately.
   */
  private withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    return withHeldFileLock(
      this.lockPath,
      {
        staleMs: this.lockStaleMs,
        maxWaitMs: this.lockMaxWaitMs,
        heartbeatMs: this.lockHeartbeatMs,
      },
      async (acquired) => {
        if (!acquired) {
          throw new Error(
            "could not acquire tombstone write lock (contention timeout or filesystem error)",
          );
        }
        return task();
      },
    );
  }

  /**
   * Look up whether `query` is blocked by an active (non-revoked) tombstone.
   * Tiers are checked in order: exact (contentHash) → normalized → keyed →
   * semantic (off by default). Returns the first active match, or `null`.
   *
   * Namespace isolation (rule 42): only entries with `namespace === query.namespace`
   * match. The store is per-namespace, so this is belt-and-suspenders.
   */
  lookup(query: TombstoneLookupQuery): TombstoneMatch | null {
    // We intentionally do NOT await load() here — lookup is called from the
    // hot write path. Callers MUST ensure the store is loaded before lookup
    // (StorageManager does this in ensureTombstoneStoreLoaded). If not loaded,
    // lookup returns null (fail-open: a missing tombstone check is preferable
    // to crashing every write — see rule 34 / the "degrade gracefully" note).
    if (!this.options.enabled) return null;
    if (!this.loaded) return null;

    // Tier 1: exact contentHash. Namespace is part of the map key (thread
    // Ocs-O), so the lookup finds only this namespace's tombstone even when
    // the backing file is shared. The namespace equality check below is kept
    // as defense-in-depth.
    const ns = query.namespace;
    if (query.contentHash) {
      const id = this.byHash.get(`${ns}\0${query.contentHash}`);
      if (id && !this.revokedIds.has(id)) {
        const entry = this.byId.get(id);
        if (entry && entry.namespace === ns) {
          return { tombstoneId: id, matchedTier: "exact", reason: entry.reason };
        }
      }
    }
    // Tier 2: normalized text.
    if (query.normalizedText) {
      const id = this.byNormalized.get(`${ns}\0${query.normalizedText}`);
      if (id && !this.revokedIds.has(id)) {
        const entry = this.byId.get(id);
        if (entry && entry.namespace === ns) {
          return { tombstoneId: id, matchedTier: "normalized", reason: entry.reason };
        }
      }
    }
    // Tier 3: keyed (entityRef + supersessionKey). Issue #1579 thread
    // Ociag/Oci-W: check EVERY supplied key, not just the first — emitters
    // append one tombstone per matched supersession key, so the active block
    // can live on any later key. The union of `supersessionKey` (singular,
    // direct callers) and `supersessionKeys` (array, write chokepoint) is
    // checked; the first active match wins (tiers are equality-based, so
    // ordering across keys does not affect correctness).
    if (query.entityRef) {
      const keysToCheck: string[] = [];
      if (query.supersessionKey) keysToCheck.push(query.supersessionKey);
      if (query.supersessionKeys) {
        for (const k of query.supersessionKeys) {
          if (!keysToCheck.includes(k)) keysToCheck.push(k);
        }
      }
      for (const key of keysToCheck) {
        const id = this.byKey.get(keyedTierKey(ns, query.entityRef, key));
        if (id && !this.revokedIds.has(id)) {
          const entry = this.byId.get(id);
          if (entry && entry.namespace === ns) {
            return { tombstoneId: id, matchedTier: "keyed", reason: entry.reason };
          }
        }
      }
    }
    // Tier 4: semantic (off by default, rule 48).
    if (this.options.semanticMatch && this.options.semanticSimilarity && query.normalizedText) {
      const threshold = this.options.semanticThreshold;
      let best: { id: string; reason: TombstoneReason; score: number } | null = null;
      for (const entry of this.entries) {
        if (entry.kind !== "tombstone") continue;
        if (entry.normalizerVersion !== TOMBSTONE_NORMALIZER_VERSION) continue;
        if (entry.namespace !== query.namespace) continue;
        if (this.revokedIds.has(entry.id)) continue;
        if (!entry.normalizedText) continue;
        const score = this.options.semanticSimilarity(query.normalizedText, entry.normalizedText);
        if (score >= threshold && (!best || score > best.score)) {
          best = { id: entry.id, reason: entry.reason, score };
        }
      }
      if (best) {
        return { tombstoneId: best.id, matchedTier: "semantic", reason: best.reason };
      }
    }
    return null;
  }
  async hasExactEntry(input: {
    sourceMemoryId: string;
    contentHash?: string;
    entityRef?: string;
    supersessionKey?: string;
    createdAt?: string;
    operationKey?: string;
  }): Promise<boolean> {
    if (!this.options.enabled) return false;
    await this.ensureFreshAgainstDisk();
    await this.load();
    return this.entries.some(
      (entry) =>
        entry.kind === "tombstone" &&
        !this.revokedIds.has(entry.id) &&
        entry.namespace === this.namespace &&
        entry.sourceMemoryId === input.sourceMemoryId &&
        (input.contentHash === undefined || entry.contentHash === input.contentHash) &&
        (input.entityRef === undefined || entry.entityRef === input.entityRef) &&
        (input.supersessionKey === undefined || entry.supersessionKey === input.supersessionKey) &&
        (input.createdAt === undefined || entry.createdAt === input.createdAt) &&
        (input.operationKey === undefined || entry.operationKey === input.operationKey),
    );
  }


  /** Aggregate stats for the doctor / x-ray surfaces. */
  stats(): TombstoneStats {
    let active = 0;
    for (const entry of this.entries) {
      if (entry.kind === "tombstone" && !this.revokedIds.has(entry.id)) active += 1;
    }
    return {
      count: active,
      revoked: this.revokedIds.size,
      lastAppendAt: this.lastAppendAt,
      corruptedLines: this.corruptedLines,
      loaded: this.loaded,
    };
  }

  /** Read-only snapshot of all entries (for rebuild + tests). */
  snapshot(): readonly TombstoneEntry[] {
    return this.entries;
  }

  /**
   * Rebuild the in-memory index + JSONL from the supplied retired-memory
   * records + existing entries (preserving revocations). Byte-stable: entries
   * are sorted by (createdAt, id) before write (rule 38).
   *
   * Returns the count of tombstone entries written.
   */
  async rebuild(retiredMemories: ReadonlyArray<RetiredMemoryRecord>): Promise<number> {
    // The full read-merge-write runs UNDER the cross-process lock (issue #1639,
    // cursor/codex review): we ensureFreshAgainstDisk() first so the in-memory
    // index reflects any peer append/revoke that landed while we waited for the
    // lock, THEN compute the payload. Rebuild rewrites the entire JSONL, so a
    // payload built from a stale this.entries would overwrite a peer's just-
    // written entry and resurrect a retired fact — the exact invariant this
    // store exists to enforce. serializeMutations (in-process) wraps the
    // cross-process lock; the key is unified with append/revoke so they cannot
    // interleave in-process either.
    const rebuiltCount = await serializeMutations(`tombstone:${this.filePath}`, () =>
      this.withWriteLock(async () => {
        await this.ensureFreshAgainstDisk({ migrate: false });
        // Preserve existing revocations (all namespaces — ids are globally
        // unique) so a rebuild does not silently un-revoke.
        const existingRevocations = this.entries.filter((e) => e.kind === "revocation");
        // Preserve tombstone entries from OTHER namespaces when the backing
        // file is shared (issue #1579 thread Oc2MJ). rebuild rewrites the
        // entire file; without preserving foreign entries, rebuilding
        // namespace A would silently delete namespace B's tombstones, allowing
        // resurrection in B.
        const foreignTombstones = this.entries.filter(
          (e) => e.kind === "tombstone" && e.namespace !== this.namespace,
        );
        // Reuse existing tombstone ids for source-equivalent entries so a prior
        // revocation (which references the tombstone id) survives rebuild —
        // minting fresh ids would orphan the revocation and silently un-revoke.
        // Issue #1579 thread Oci-T: key the reuse map by (sourceMemoryId,
        // supersessionKey). See the append path above for the full rationale.
        const existingBySource = new Map<string, string>();
        for (const e of this.entries) {
          if (e.kind === "tombstone") {
            existingBySource.set(`${e.sourceMemoryId}\u{0000}${e.supersessionKey ?? ""}`, e.id);
          }
        }
        const rebuilt: TombstoneEntry[] = retiredMemories.map((m) => {
          const currentHash = this.options.hashContent(m.rawContent);
          const currentNormalizedText = this.options.normalizeText(m.rawContent);
          const persistedHash = m.contentHash;
          // A persisted hash equal to the body's LEGACY hash only proves the
          // record predates the Unicode normalizer when that legacy hash is
          // unambiguous. When the legacy normalizer is lossy for this body
          // (CJK-only text, or any body whose ASCII skeleton collides with a
          // distinct contentHashSource), the equality cannot distinguish "old
          // body hash" from "explicit source identity" — replacing the
          // persisted hash would displace a live identity (issue #2367).
          // Preserving keeps BOTH keys: contentHash stays the persisted
          // identity and currentContentHashAlias still blocks the body.
          const preserveOverride =
            persistedHash !== undefined &&
            persistedHash !== currentHash &&
            !isUnambiguousLegacyContentHash(m.rawContent, persistedHash, currentNormalizedText);
          return {
            id:
              existingBySource.get(`${m.memoryId}\u{0000}${m.supersessionKey ?? ""}`) ??
              newTombstoneId(),
            ...(preserveOverride ? { currentContentHashAlias: currentHash } : {}),
            kind: "tombstone" as const,
            reason: m.reason,
            sourceMemoryId: m.memoryId,
            contentHash: preserveOverride ? persistedHash : currentHash,
            normalizedText: currentNormalizedText,
            normalizerVersion: TOMBSTONE_NORMALIZER_VERSION,
            ...(m.entityRef ? { entityRef: m.entityRef } : {}),
            ...(m.supersessionKey ? { supersessionKey: m.supersessionKey } : {}),
            namespace: this.namespace,
            createdAt: m.createdAt,
            createdBy: m.createdBy,
          };
        });
        // Sort deterministically (rule 38): createdAt, then id for stability.
        rebuilt.sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
            : a.createdAt < b.createdAt ? -1 : 1,
        );
        const all = [...rebuilt, ...existingRevocations, ...foreignTombstones].sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
            : a.createdAt < b.createdAt ? -1 : 1,
        );
        const serialized =
          all.map((e) => JSON.stringify(e)).join("\n") + (all.length > 0 ? "\n" : "");
        await this.io.write(this.filePath, serialized);
        // Update the in-memory index under the same lock so it stays consistent
        // with the file we just wrote (no window for a lookup to see a stale
        // index that misses a just-rebuilt entry).
        this.resetIndex();
        for (const entry of all) this.indexEntry(entry);
        this.corruptedLines = 0;
        this.loaded = true;
        this.markWritten();
        return rebuilt.length;
      }),
    );
    await this.migrateLoadedLegacyEntries();
    return rebuiltCount;
  }
}

/** A retired memory projected into the shape `TombstoneStore.rebuild` consumes. */
export interface RetiredMemoryRecord {
  memoryId: string;
  rawContent: string;
  entityRef?: string;
  supersessionKey?: string;
  reason: TombstoneReason;
  createdBy: TombstoneCreatedBy;
  createdAt: string;
  /** Canonical contentHash from the retired memory's frontmatter (#1579). */
  contentHash?: string;
}

/**
 * Project a corpus of memories into the retired-memory records `rebuild`
 * consumes. Pure (no I/O) so the StorageManager wiring stays thin (#1579,
 * #1520 god-file ratchet). Only superseded / forgotten / rejected FACTS
 * participate — entities, questions, and artifacts have their own lifecycle
 * (issue pitfall). The supersession key is derived from structured attributes
 * via the injected helper so there is one keyed-tier definition (rule 23).
 */
export function collectRetiredMemoriesForRebuild(
  memories: ReadonlyArray<{
    frontmatter: {
      id: string;
      status?: string;
      category?: string;
      contentHash?: string;
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      updated?: string;
      created?: string;
    };
    content: string;
  }>,
  deps: {
    /** Strip citation annotations from the body before hashing/normalizing. */
    stripCitation: (text: string) => string;
    /** Derive the keyed-tier supersession key (one helper, rule 23). */
    supersessionKeysForFact: (spec: {
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
    }) => string[];
  },
): RetiredMemoryRecord[] {
  const retired: RetiredMemoryRecord[] = [];
  for (const m of memories) {
    const status = m.frontmatter.status;
    if (status !== "superseded" && status !== "rejected" && status !== "forgotten") continue;
    if (m.frontmatter.category !== "fact") continue;
    const reason: TombstoneReason =
      status === "superseded" ? "supersession" : status === "forgotten" ? "retraction" : "correction";
    const createdBy: TombstoneCreatedBy =
      reason === "supersession" ? "supersession" : "user_correction";
    const entityRef = m.frontmatter.entityRef;
    const keys =
      entityRef && m.frontmatter.structuredAttributes
        ? deps.supersessionKeysForFact({
            entityRef,
            structuredAttributes: m.frontmatter.structuredAttributes,
          })
        : [];
    // Issue #1579 thread Ocgjz: emit one record per matched supersession key
    // (not just keys[0]) so rebuild reproduces the same keyed tombstones as
    // live temporal-supersession (which now appends one per key — thread ObteS).
    // Without this, a rebuild would under-rebuild the JSONL and keyed-tier
    // blocks would disappear until rediscovered.
    const keysToEmit = keys.length > 0 ? keys : [undefined];
    for (const key of keysToEmit) {
      retired.push({
        memoryId: m.frontmatter.id,
        rawContent: deps.stripCitation(m.content),
        contentHash: m.frontmatter.contentHash,
        ...(entityRef ? { entityRef } : {}),
        ...(key ? { supersessionKey: key } : {}),
        reason,
        createdBy,
        createdAt: m.frontmatter.updated || m.frontmatter.created || new Date().toISOString(),
      });
    }
  }
  return retired;
}

/**
 * One-shot write-time resurrection gate (issue #1579 / #2213). Looks up the
 * fact's identity in the tombstone store and, on a match, downgrades the
 * frontmatter to `pending_review` + `blockedBy` IN PLACE. ADD-ONLY: an
 * already-blocked or terminal-status record is left untouched. Pure over its
 * inputs (no I/O beyond the injected store) so both `writeMemory`'s gate and
 * the chunk-repair re-gate share one lookup + apply.
 */
export function applyTombstoneResurrectionGate(
  store: Pick<TombstoneStore, "lookup">,
  fm: {
    id: string;
    status?: string;
    blockedBy?: string;
    tombstoneBlockTier?: TombstoneMatchTier;
    entityRef?: string;
    contentHash?: string;
  },
  query: {
    normalizedText: string;
    supersessionKeys: string[];
    namespace: string;
  },
): TombstoneMatch | null {
  if (fm.status === "pending_review" && fm.blockedBy) return null;
  if (!(fm.status === undefined || fm.status === "active" || fm.status === "pending_review")) return null;
  const match = store.lookup({
    contentHash: fm.contentHash,
    normalizedText: query.normalizedText,
    ...(fm.entityRef ? { entityRef: fm.entityRef } : {}),
    ...(query.supersessionKeys.length > 0 ? { supersessionKeys: query.supersessionKeys } : {}),
    namespace: query.namespace,
  });
  if (!match) return null;
  fm.status = "pending_review";
  fm.blockedBy = match.tombstoneId;
  fm.tombstoneBlockTier = match.matchedTier;
  return match;
}

/**
 * Build the live-emission tombstone inputs for a single retired FACT — one
 * input per derived supersession key (or a single keyless record when no
 * structured attributes are present). Pure (no I/O) so the emitters in
 * `StorageManager.supersedeMemory` (contradiction) and `forgetMemory`
 * (retraction) stay thin (#1579, #1520 god-file ratchet). Mirrors the
 * temporal-supersession emitter and `collectRetiredMemoriesForRebuild` so
 * every retire path emits the same keyed-tombstone shape (issue #1579
 * threads Oci-Y / OchiF: without per-key tombstones, a paraphrased
 * re-observation missed the keyed tier and the fact resurrected active).
 */
export function buildRetiredFactTombstoneInputs(
  memory: {
    id: string;
    content: string;
    contentHash?: string;
    entityRef?: string;
    structuredAttributes?: Record<string, string>;
  },
  opts: {
    reason: TombstoneReason;
    createdBy: TombstoneCreatedBy;
    createdAt: string;
    supersessionKeysForFact: (spec: {
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
    }) => string[];
  },
): Array<{
  reason: TombstoneReason;
  createdBy: TombstoneCreatedBy;
  sourceMemoryId: string;
  rawContent: string;
  contentHash?: string;
  entityRef?: string;
  supersessionKey?: string;
  createdAt: string;
}> {
  const keys =
    memory.entityRef && memory.structuredAttributes
      ? opts.supersessionKeysForFact({
          entityRef: memory.entityRef,
          structuredAttributes: memory.structuredAttributes,
        })
      : [];
  const keysToEmit = keys.length > 0 ? keys : [undefined];
  return keysToEmit.map((key) => ({
    reason: opts.reason,
    createdBy: opts.createdBy,
    sourceMemoryId: memory.id,
    rawContent: memory.content,
    ...(memory.contentHash ? { contentHash: memory.contentHash } : {}),
    ...(memory.entityRef ? { entityRef: memory.entityRef } : {}),
    ...(key ? { supersessionKey: key } : {}),
    createdAt: opts.createdAt,
  }));
}
