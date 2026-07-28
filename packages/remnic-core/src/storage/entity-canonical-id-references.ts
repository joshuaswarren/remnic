/**
 * Write-boundary surface of the entity canonical-id migration (issue #2213).
 *
 * The migration itself (entity-canonical-id-migration.ts) renames legacy
 * entity files and rewrites references ONCE, to convergence, then retires.
 * Everything here exists so nothing can re-introduce a legacy reference
 * afterwards without the migration having to rescan the corpus:
 *
 * - store-mediated writes canonicalize the caller-supplied `entityRef`
 *   ({@link canonicalizeEntityRefOption});
 * - bulk writers that persist raw record bytes (capsule import/merge)
 *   canonicalize the frontmatter line ({@link canonicalizeEntityRefFrontmatter});
 * - raw-byte writers that CANNOT parse what they write (offline sync,
 *   consolidation-undo, governance restores) request one bounded
 *   reconciliation pass instead ({@link requestEntityCanonicalIdReconcile}).
 */
import path from "node:path";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";

export const ENTITY_CANONICAL_ID_MIGRATION_FILE = "entity-canonical-id-migration-v1.json";

/**
 * Parse a journal document into a mapping table. A document without a valid
 * `mappings` object is a LEGITIMATELY empty table; an unreadable/unparsable
 * document THROWS so callers can distinguish "empty" from "failed".
 */
function parseJournalMappings(raw: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("mappings" in parsed)) return {};
  const mappings = parsed.mappings;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return {};
  const cleaned: Record<string, string> = {};
  for (const [legacyId, canonicalId] of Object.entries(mappings)) {
    if (legacyId.length > 0 && typeof canonicalId === "string" && canonicalId.length > 0) {
      cleaned[legacyId] = canonicalId;
    }
  }
  return cleaned;
}

export function loadHistoricalEntityCanonicalIds(stateDir: string): Readonly<Record<string, string>> {
  const statePath = path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE);
  try {
    // Never read mappings through a symlinked journal (repo rule: reject
    // symlink traversal from memory directories) — a link could supply
    // arbitrary mappings that silently rewrite persisted entityRefs.
    if (!lstatSync(statePath).isFile()) return {};
    return parseJournalMappings(readFileSync(statePath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Journal mapping table keyed by the journal FILE's identity, so a long-lived
 * StorageManager never canonicalizes against a stale snapshot after ANY other
 * writer changes the journal — a peer process completing a migration, or
 * `pruneBlocked()` parking a contested mapping (which rewrites the journal
 * without bumping any shared version). `writeState` publishes via
 * temp-file-plus-rename, so every journal write swaps the inode and the key
 * always moves. Reload cost is one lstat per lookup and one journal parse per
 * actual change.
 *
 * Failure semantics: last-known data is served ONLY for the SAME state dir
 * (module-level instances can face several stores — another store's table
 * must never leak in), and a failed read/parse never commits the journal's
 * identity, so the next lookup retries instead of caching an empty table
 * under a valid key.
 */
export class HistoricalEntityCanonicalIdCache {
  private mappings: Readonly<Record<string, string>> = {};
  private key: string | null = null;
  private stateDir: string | null = null;

  get(stateDir: string): Readonly<Record<string, string>> {
    const lastKnown = this.stateDir === stateDir ? this.mappings : {};
    const statePath = path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE);
    let key = "missing";
    try {
      const s = lstatSync(statePath);
      if (!s.isFile()) {
        // Symlinked/non-regular journal: never follow it, never adopt its
        // identity — serve this store's last-known table. If it later becomes
        // a regular file its identity differs from the stored key and reloads.
        log.warn("ignoring non-regular entity canonical-id journal (symlink refused)");
        return lastKnown;
      }
      key = `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    } catch (error) {
      // A TRANSIENT stat failure (EACCES/EIO) must not dump a valid table for
      // {}: a write during the outage would skip canonicalization AND its
      // post-write identity check would compare equal. Serve this store's
      // last-known table; only a genuine ENOENT means "no journal, empty".
      if (!isErrnoCode(error, "ENOENT")) return lastKnown;
    }
    if (key !== this.key || stateDir !== this.stateDir) {
      let table: Readonly<Record<string, string>> = {};
      if (key !== "missing") {
        try {
          table = parseJournalMappings(readFileSync(statePath, "utf-8"));
        } catch {
          // Read/parse failed under a VALID identity: do not commit the key —
          // the next lookup retries instead of pinning an empty table.
          return lastKnown;
        }
      }
      this.mappings = table;
      this.key = key;
      this.stateDir = stateDir;
    }
    return this.mappings;
  }
}

export function resolveHistoricalEntityCanonicalId(
  normalized: string,
  mappings: Readonly<Record<string, string>>,
): string {
  let current = normalized;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = mappings[current];
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/**
 * Canonicalize the `entityRef` a memory-write caller supplied (issue #2213).
 *
 * Extraction and capture callers pass whatever id the LLM or user produced,
 * which can name a legacy id this migration already renamed. Resolving at the
 * WRITE boundary means store-mediated writes can never re-introduce legacy
 * references — which is what let the completed migration retire its recurring
 * full-corpus reference rewrite. It also keeps write-time tombstone lookups on
 * the same id space as migrated tombstones. Unknown ids pass through verbatim.
 */
export function canonicalizeEntityRefOption<T extends { entityRef?: string }>(
  options: T,
  mappings: Readonly<Record<string, string>>,
): T {
  // Non-strings (absent, or a JS caller's null/junk) pass through untouched:
  // this boundary canonicalizes ids, it does not take over input validation
  // the write path never performed — serialization already drops falsy refs.
  if (typeof options.entityRef !== "string") return options;
  return { ...options, entityRef: resolveHistoricalEntityCanonicalId(options.entityRef, mappings) };
}

/**
 * Canonicalize the effective `entityRef:` line inside a raw memory record's
 * leading frontmatter block (issue #2213). Bulk writers that persist record
 * bytes verbatim — capsule import/merge — are a write boundary too: a capsule
 * can carry pre-migration memories whose refs the target's completed journal
 * already renamed, and no later reconciliation pass exists to absorb them.
 *
 * Line selection mirrors the frontmatter parser and the migration's own
 * serializer: the LAST `entityRef` key wins (indentation tolerated), its
 * indent is preserved, and CRLF records keep their line endings. The closing
 * delimiter must be a standalone `---` line. Non-frontmatter content, records
 * without an `entityRef` line, and ids the journal does not map all pass
 * through byte-identical.
 */
export function canonicalizeEntityRefFrontmatter(
  content: string,
  mappings: Readonly<Record<string, string>>,
): string {
  if (Object.keys(mappings).length === 0 || !/^---\r?\n/.test(content)) return content;
  const close = /\r?\n---(?:\r?\n|$)/g;
  close.lastIndex = content.indexOf("\n") + 1;
  const closeMatch = close.exec(content);
  if (!closeMatch) return content;
  const lines = content.slice(0, closeMatch.index).split("\n");
  let effective = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^\s*entityRef\s*:/.test(lines[index] ?? "")) effective = index;
  }
  if (effective === -1) return content;
  const line = lines[effective]!;
  const value = line.slice(line.indexOf(":") + 1).replace(/\r$/, "").trim();
  if (value.length === 0) return content;
  const canonical = resolveHistoricalEntityCanonicalId(value, mappings);
  if (canonical === value) return content;
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  lines[effective] = `${indent}entityRef: ${canonical}${line.endsWith("\r") ? "\r" : ""}`;
  return lines.join("\n") + content.slice(closeMatch.index);
}

/**
 * Reconcile-pending marker (issue #2213). Raw-byte memory writers that CANNOT
 * canonicalize inline — offline-sync file replication (opaque, possibly
 * encrypted buffers), consolidation-undo restores, governance-run restores —
 * touch this marker instead. The next migration invocation honors it by
 * running ONE bounded reference-reconciliation pass over the completed
 * journal's retained mappings, then clears it. This replaces the retired
 * every-run corpus rewrite with a signal that fires only when a raw writer
 * actually landed unvetted bytes.
 */
export const ENTITY_CANONICAL_ID_RECONCILE_MARKER = "entity-canonical-id-reconcile.pending";
/** The generation a migration run renamed aside for consumption; a crash can strand it. */
export const ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER = `${ENTITY_CANONICAL_ID_RECONCILE_MARKER}.consuming`;

export function requestEntityCanonicalIdReconcileSync(stateDir: string): void {
  const markerPath = path.join(stateDir, ENTITY_CANONICAL_ID_RECONCILE_MARKER);
  try {
    // Never write through a symlinked marker (repo rule: reject symlink
    // traversal from memory directories) — a link here would let the write
    // truncate whatever file it points at.
    let existing = null;
    try {
      existing = lstatSync(markerPath);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
    if (existing && !existing.isFile()) {
      log.warn(`refusing to write entity canonical-id reconcile marker: ${markerPath} is not a regular file`);
      return;
    }
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf-8");
  } catch (error) {
    // Best effort by design: a marker failure must not fail the restore/sync
    // that requested it (AGENTS.md §4). The reference stays legacy-but-readable
    // until the next mapping change.
    log.warn(`could not request entity canonical-id reconcile: ${error}`);
  }
}

export async function requestEntityCanonicalIdReconcile(stateDir: string): Promise<void> {
  requestEntityCanonicalIdReconcileSync(stateDir);
}

/**
 * Post-persist TOCTOU guard (issue #2213). A writer resolves `entityRef`
 * against one journal generation, then awaits (snapshots, locks, fsyncs)
 * before its bytes land — a peer migration can publish AND finish its final
 * reference scan inside that window, leaving the just-written file behind.
 * Callers pass the mapping table captured at resolve time plus a fresh cache
 * read taken AFTER the write: the cache returns the identical object while
 * the journal file is unchanged, so an identity mismatch means the journal
 * moved mid-write and one bounded reconcile pass is requested.
 */
export function reconcileIfJournalMovedSync(
  stateDir: string,
  idsAtResolve: Readonly<Record<string, string>>,
  idsAfterWrite: Readonly<Record<string, string>>,
): void {
  if (idsAtResolve === idsAfterWrite) return;
  requestEntityCanonicalIdReconcileSync(stateDir);
}

export async function reconcileIfJournalMoved(
  stateDir: string,
  idsAtResolve: Readonly<Record<string, string>>,
  idsAfterWrite: Readonly<Record<string, string>>,
): Promise<void> {
  reconcileIfJournalMovedSync(stateDir, idsAtResolve, idsAfterWrite);
}

/**
 * True when a raw write to `filePath` can carry migrated entity references —
 * a markdown record under the hot recall, cold, or archive tiers. Raw writers
 * (offline sync) use this to avoid requesting a full reconcile pass when a
 * sync only touched transcripts, runtime state, or other non-memory files.
 */
export function pathMayCarryEntityRefs(baseDir: string, filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  const rel = path.relative(baseDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const top = rel.split(path.sep)[0] ?? "";
  // entities/ carries relationship TARGETS the migration also rewrites.
  return RECALL_FALLBACK_DIRS.includes(top) || top === "cold" || top === "archive" || top === "entities";
}

/**
 * Post-persist repair (issue #2213): when the journal moved across a persist,
 * re-resolve the caller's ORIGINAL ref against the fresh table and rewrite
 * the file in place (bounded) — a mapping parked mid-write would otherwise
 * leave the memory on a since-contested canonical claimant, the one direction
 * the bounded reconcile pass cannot repair. Falls back to requesting the
 * reconcile pass when the journal keeps moving.
 */
export async function repairEntityRefAfterJournalMove(options: {
  stateDir: string;
  currentIds: () => Readonly<Record<string, string>>;
  idsAtResolve: Readonly<Record<string, string>>;
  rawRef: string;
  frontmatter: { entityRef?: string };
  rewrite: () => Promise<void>;
}): Promise<void> {
  let refIds = options.idsAtResolve;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = options.currentIds();
    if (fresh === refIds) return;
    refIds = fresh;
    const desired = resolveHistoricalEntityCanonicalId(options.rawRef, fresh);
    if (desired === options.frontmatter.entityRef) return;
    options.frontmatter.entityRef = desired;
    await options.rewrite();
  }
  await requestEntityCanonicalIdReconcile(options.stateDir);
}
