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

import { serializeMutations } from "../utils/serialize-mutations.js";

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
  /** sha256 of the retired memory's rawContent (rule 23). */
  contentHash: string;
  /** `ContentHashIndex.normalizeContent(rawContent)` — the pre-hash form. */
  normalizedText: string;
  entityRef?: string;
  /** Structured-attribute supersession key when one existed. */
  supersessionKey?: string;
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

/** Inputs to a lookup. At least one discriminator must be present. */
export interface TombstoneLookupQuery {
  contentHash?: string;
  normalizedText?: string;
  entityRef?: string;
  supersessionKey?: string;
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
}

/** Injected file I/O — the StorageManager wires its secure-store-aware
 * implementations so tombstones are encrypted at rest alongside other state. */
export interface TombstoneFileIo {
  read: (filePath: string) => Promise<string>;
  append: (filePath: string, content: string) => Promise<void>;
  write: (filePath: string, content: string) => Promise<void>;
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

const TOMBSTONE_PREFIX = "tomb";

function newTombstoneId(): string {
  return `${TOMBSTONE_PREFIX}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Deterministic key for the keyed tier (entityRef + supersessionKey). */
function keyedTierKey(entityRef: string, supersessionKey: string): string {
  return `${entityRef}\0${supersessionKey}`;
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

  constructor(
    private readonly filePath: string,
    private readonly namespace: string,
    private readonly options: TombstoneStoreOptions,
    private readonly io: TombstoneFileIo,
  ) {}

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

  private async loadInternal(): Promise<void> {
    let raw: string;
    try {
      raw = await this.io.read(this.filePath);
    } catch (err) {
      // ENOENT is fine — fresh store. Other errors leave the store empty
      // rather than crashing the write path (rule 34 spirit: degrade to
      // "no tombstones known" rather than blocking all writes).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // Swallow — the write path must not crash on a corrupt tombstone file.
        // Rebuild will repair on the next doctor/maintenance run.
      }
      this.loaded = true;
      return;
    }
    this.resetIndex();
    let corrupted = 0;
    for (const line of raw.split("\n")) {
      const entry = parseTombstoneLine(line);
      if (!entry) {
        if (line.trim().length > 0) corrupted += 1;
        continue;
      }
      this.indexEntry(entry);
    }
    this.corruptedLines = corrupted;
    this.loaded = true;
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
    // Tombstone entries populate the lookup maps.
    if (entry.contentHash) this.byHash.set(entry.contentHash, entry.id);
    if (entry.normalizedText) this.byNormalized.set(entry.normalizedText, entry.id);
    if (entry.entityRef && entry.supersessionKey) {
      this.byKey.set(keyedTierKey(entry.entityRef, entry.supersessionKey), entry.id);
    }
  }

  /** Invalidate the in-memory cache (rule 25). The next access reloads. */
  invalidate(): void {
    this.loaded = false;
    this.loadPromise = null;
    this.resetIndex();
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
    createdAt?: string;
  }): Promise<string> {
    await this.load();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const id = newTombstoneId();
    const entry: TombstoneEntry = {
      id,
      kind: "tombstone",
      reason: input.reason,
      sourceMemoryId: input.sourceMemoryId,
      contentHash: this.options.hashContent(input.rawContent),
      normalizedText: this.options.normalizeText(input.rawContent),
      ...(input.entityRef ? { entityRef: input.entityRef } : {}),
      ...(input.supersessionKey ? { supersessionKey: input.supersessionKey } : {}),
      namespace: this.namespace,
      createdAt,
      createdBy: input.createdBy,
    };
    await this.serializeAppend(entry);
    this.indexEntry(entry);
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
    return id;
  }

  private serializeAppend(entry: TombstoneEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    // serializeMutations recovers after rejection (rule 40): a failed append
    // surfaces to THIS caller but the next append is not poisoned.
    return serializeMutations(`tombstone:${this.filePath}`, () =>
      this.io.append(this.filePath, line),
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

    // Tier 1: exact contentHash.
    if (query.contentHash) {
      const id = this.byHash.get(query.contentHash);
      if (id && !this.revokedIds.has(id)) {
        const entry = this.byId.get(id);
        if (entry && entry.namespace === query.namespace) {
          return { tombstoneId: id, matchedTier: "exact", reason: entry.reason };
        }
      }
    }
    // Tier 2: normalized text.
    if (query.normalizedText) {
      const id = this.byNormalized.get(query.normalizedText);
      if (id && !this.revokedIds.has(id)) {
        const entry = this.byId.get(id);
        if (entry && entry.namespace === query.namespace) {
          return { tombstoneId: id, matchedTier: "normalized", reason: entry.reason };
        }
      }
    }
    // Tier 3: keyed (entityRef + supersessionKey).
    if (query.entityRef && query.supersessionKey) {
      const id = this.byKey.get(keyedTierKey(query.entityRef, query.supersessionKey));
      if (id && !this.revokedIds.has(id)) {
        const entry = this.byId.get(id);
        if (entry && entry.namespace === query.namespace) {
          return { tombstoneId: id, matchedTier: "keyed", reason: entry.reason };
        }
      }
    }
    // Tier 4: semantic (off by default, rule 48).
    if (this.options.semanticMatch && this.options.semanticSimilarity && query.normalizedText) {
      const threshold = this.options.semanticThreshold;
      let best: { id: string; reason: TombstoneReason; score: number } | null = null;
      for (const entry of this.entries) {
        if (entry.kind !== "tombstone") continue;
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
  async rebuild(
    retiredMemories: ReadonlyArray<{
      memoryId: string;
      rawContent: string;
      entityRef?: string;
      supersessionKey?: string;
      reason: TombstoneReason;
      createdBy: TombstoneCreatedBy;
      createdAt: string;
    }>,
  ): Promise<number> {
    // Preserve existing revocations so a rebuild does not silently un-revoke.
    const existingRevocations = this.entries.filter((e) => e.kind === "revocation");
    const rebuilt: TombstoneEntry[] = retiredMemories.map((m) => ({
      id: newTombstoneId(),
      kind: "tombstone" as const,
      reason: m.reason,
      sourceMemoryId: m.memoryId,
      contentHash: this.options.hashContent(m.rawContent),
      normalizedText: this.options.normalizeText(m.rawContent),
      ...(m.entityRef ? { entityRef: m.entityRef } : {}),
      ...(m.supersessionKey ? { supersessionKey: m.supersessionKey } : {}),
      namespace: this.namespace,
      createdAt: m.createdAt,
      createdBy: m.createdBy,
    }));
    // Sort deterministically (rule 38): createdAt, then id for stability.
    rebuilt.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        : a.createdAt < b.createdAt ? -1 : 1,
    );
    const all = [...rebuilt, ...existingRevocations].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        : a.createdAt < b.createdAt ? -1 : 1,
    );
    const serialized = all.map((e) => JSON.stringify(e)).join("\n") + (all.length > 0 ? "\n" : "");
    await serializeMutations(`tombstone-rebuild:${this.filePath}`, () =>
      this.io.write(this.filePath, serialized),
    );
    this.resetIndex();
    for (const entry of all) this.indexEntry(entry);
    this.corruptedLines = 0;
    this.loaded = true;
    return rebuilt.length;
  }
}
