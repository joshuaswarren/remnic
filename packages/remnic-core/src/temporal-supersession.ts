/**
 * Temporal Supersession (issue #375)
 *
 * When a new fact lands with `structuredAttributes` keyed on a known
 * `entityRef`, any prior fact whose supersession key collides with the new
 * fact's key is marked `status: "superseded"` and linked via
 * `supersededBy` / `supersededAt`.  Recall filters those superseded memories
 * by default so agents see only the "current" value per entity attribute.
 *
 * The algorithm is intentionally O(N) over the memory corpus per write, but
 * skips cheaply when the new fact has no structuredAttributes.  It reuses the
 * cached `readAllMemories()` path so cost is amortized with the rest of the
 * write pipeline.
 */
import type { MemoryFile, MemoryFrontmatter } from "./types.js";
import type { StorageManager } from "./storage.js";
import { log } from "./logger.js";
import { effectiveValidAt } from "./temporal-validity.js";

/**
 * Shared normalization for supersession key components.
 *
 * Trims surrounding whitespace, lowercases, then collapses any run of
 * whitespace OR hyphens to a single hyphen, and strips any leading/trailing
 * hyphens that result.  Both `computeSupersessionKey` and
 * `lookupAttributeByNormalizedKey` must use this so that keys produced at
 * write time and keys used at lookup time are identical regardless of how
 * the LLM encoded whitespace, hyphens, or casing (Finding B fix).
 *
 * Symmetry guarantee: `"foo bar"`, `"foo-bar"`, `"foo - bar"`, and
 * `"foo  bar"` all canonicalize to `"foo-bar"`.
 *
 * Exported so external tests can verify the canonical form.
 */
export function normalizeSupersessionKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Stable supersession key for an (entityRef, attributeName) pair.
 *
 * The algorithm is:
 *  - normalize the entityRef (trim, lower-case, collapse whitespace)
 *  - normalize the attributeName the same way
 *  - join with `::`
 *
 * Exported so tests and tools can recompute it without depending on storage.
 */
export function computeSupersessionKey(
  entityRef: string | undefined,
  attributeName: string,
): string | null {
  if (!entityRef || typeof entityRef !== "string") return null;
  if (!attributeName || typeof attributeName !== "string") return null;
  const entity = normalizeSupersessionKey(entityRef);
  const attr = normalizeSupersessionKey(attributeName);
  if (entity.length === 0 || attr.length === 0) return null;
  return `${entity}::${attr}`;
}

/**
 * Compute the full set of supersession keys for a fact with structured
 * attributes.  Returns an empty array if no keys can be derived.
 */
export function supersessionKeysForFact(spec: {
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
}): string[] {
  if (!spec.entityRef) return [];
  if (!spec.structuredAttributes) return [];
  const keys: string[] = [];
  for (const attrName of Object.keys(spec.structuredAttributes)) {
    const key = computeSupersessionKey(spec.entityRef, attrName);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Look up a structured-attribute value by a raw key, normalizing both sides
 * with `normalizeSupersessionKey` before comparing.  This ensures that keys
 * written by the LLM with mixed case, surrounding whitespace, or internal
 * whitespace (e.g. `"City"`, `" city "`, `"job   title"`, `"job-title"`)
 * are all matched against normalized keys produced by `computeSupersessionKey`
 * (Finding B fix — uses the same helper so both sides are identical).
 *
 * The storage format is NOT changed — we only normalize at lookup time.
 */
export function lookupAttributeByNormalizedKey(
  attributes: Record<string, unknown>,
  rawKey: string,
): unknown {
  const normalizedTarget = normalizeSupersessionKey(rawKey);
  for (const [k, v] of Object.entries(attributes)) {
    if (normalizeSupersessionKey(k) === normalizedTarget) return v;
  }
  return undefined;
}

/**
 * Decide whether an existing memory should be superseded by a newly-written
 * memory that carries the supplied supersession key set.
 *
 * Only memories that:
 *  - are currently `active`
 *  - share an `entityRef` with the new fact
 *  - share at least one supersession key with the new fact
 *  - are older than the new fact
 *  - have a conflicting value (different string) for the overlapping key
 * are eligible.  This keeps supersession local to the attribute that actually
 * changed — if fact A sets `{city: Austin, tool: vim}` and fact B sets
 * `{city: NYC}`, only the city attribute is superseded, not the tool.
 */
export function shouldSupersedeExisting(args: {
  candidate: MemoryFrontmatter;
  newEntityRef: string;
  newAttributes: Record<string, string>;
  newCreatedAt: string;
  newMemoryId: string;
}): { matchedKeys: string[] } | null {
  const { candidate, newEntityRef, newAttributes, newCreatedAt, newMemoryId } = args;

  if (candidate.id === newMemoryId) return null;
  if (candidate.status && candidate.status !== "active") return null;
  if (!candidate.entityRef) return null;
  if (!candidate.structuredAttributes) return null;

  // Reuse the shared `normalizeSupersessionKey` helper so this comparison
  // cannot drift from the canonical form used to build supersession keys
  // elsewhere in this file.
  const candidateEntityNorm = normalizeSupersessionKey(candidate.entityRef);
  const newEntityNorm = normalizeSupersessionKey(newEntityRef);
  if (candidateEntityNorm !== newEntityNorm) return null;

  // Must be older than the new fact's effective validity start — equal
  // timestamps are ignored to avoid races within the same millisecond. When
  // replay/import supplies source time, valid_at must drive ordering instead
  // of wall-clock persistence time.
  const candidateCreated = Date.parse(effectiveValidAt(candidate));
  const newCreated = Date.parse(newCreatedAt);
  if (!Number.isFinite(candidateCreated) || !Number.isFinite(newCreated)) return null;
  if (candidateCreated >= newCreated) return null;

  const matchedKeys: string[] = [];
  for (const [attrName, newValue] of Object.entries(newAttributes)) {
    // Use normalized key lookup so mixed-case or whitespace-padded keys
    // stored by the LLM are matched correctly (Finding 2 fix).
    const candidateValue = lookupAttributeByNormalizedKey(
      candidate.structuredAttributes,
      attrName,
    );
    if (candidateValue === undefined) continue;
    // Only supersede on conflicting values — identical values are a no-op.
    if (normalizeValue(String(candidateValue)) === normalizeValue(newValue)) continue;
    const key = computeSupersessionKey(newEntityRef, attrName);
    if (key) matchedKeys.push(key);
  }

  return matchedKeys.length > 0 ? { matchedKeys } : null;
}

function normalizeValue(v: string): string {
  return v.trim().toLowerCase();
}

async function expireChildChunksForSupersededParent(args: {
  storage: StorageManager;
  allCandidates: MemoryFile[];
  parentId: string;
  newMemoryId: string;
  supersededAt: string;
  invalidAt?: string;
}): Promise<void> {
  const processedChunkIds = new Set<string>();
  const chunks = args.allCandidates.filter(
    (candidate) => candidate.frontmatter.parentId === args.parentId,
  );

  for (const chunk of chunks) {
    const chunkKey = chunk.frontmatter.id ?? chunk.path;
    if (processedChunkIds.has(chunkKey)) continue;

    try {
      const freshChunk = await args.storage.readMemoryByPath(chunk.path);
      if (!freshChunk) continue;
      processedChunkIds.add(chunkKey);
      const freshStatus = freshChunk.frontmatter.status ?? "active";
      if (freshStatus !== "active" || freshChunk.frontmatter.supersededBy) continue;

      await args.storage.writeMemoryFrontmatter(
        freshChunk,
        {
          status: "superseded",
          supersededBy: args.newMemoryId,
          supersededAt: args.supersededAt,
          updated: args.supersededAt,
          ...(args.invalidAt && !freshChunk.frontmatter.invalid_at
            ? { invalid_at: args.invalidAt }
            : {}),
        },
        {
          actor: "temporal-supersession",
          reasonCode: "structured-attribute-update-child-chunk",
          relatedMemoryIds: [args.newMemoryId, args.parentId],
        },
      );
    } catch (err) {
      log.warn(
        `temporal-supersession: failed to expire child chunk ${chunk.frontmatter.id} for parent ${args.parentId}: ${err}`,
      );
    }
  }
}

export interface TemporalSupersessionResult {
  supersededIds: string[];
  matchedKeys: string[];
}

/**
 * Scan existing memories and mark any that are superseded by the
 * just-written memory.  Fails open on I/O errors — the new memory is already
 * on disk, and supersession is a best-effort hygiene step.
 */
export async function applyTemporalSupersession(args: {
  storage: StorageManager;
  newMemoryId: string;
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
  createdAt: string;
  enabled: boolean;
  /**
   * When true, skip the persisted `frontmatter.created` lookup and use
   * `args.createdAt` directly as the ordering anchor.  Set this on the
   * hash-dedup short-circuit path where `newMemoryId` points to an existing
   * OLD fact (no new file is written) and its persisted timestamp would be
   * stale relative to the incoming promotion event (PR #402 Finding Uyui).
   */
  useCallerTimestamp?: boolean;
}): Promise<TemporalSupersessionResult> {
  const empty: TemporalSupersessionResult = { supersededIds: [], matchedKeys: [] };
  if (!args.enabled) return empty;
  if (!args.entityRef) return empty;
  if (!args.structuredAttributes) return empty;
  if (Object.keys(args.structuredAttributes).length === 0) return empty;

  const newKeys = supersessionKeysForFact({
    entityRef: args.entityRef,
    structuredAttributes: args.structuredAttributes,
  });
  if (newKeys.length === 0) return empty;

  let hotMemories: MemoryFile[];
  try {
    hotMemories = await args.storage.readAllMemories();
  } catch (err) {
    log.warn(`temporal-supersession: readAllMemories failed: ${err}`);
    return empty;
  }

  // Finding 1 fix: use the on-disk effective validity start of the
  // newly-written memory rather than a wall-clock timestamp sampled after
  // `writeMemory` returns.  In concurrent writers the two can differ by enough
  // to cause wrong-direction supersession.  If source replay/import provided
  // valid_at, it must drive ordering; otherwise created remains the legacy
  // fallback.  If the memory is not yet visible in the cache (edge case during
  // fast concurrent writes) fall back to args.createdAt.
  //
  // PR #402 round-12 (Finding Uyui): on the hash-dedup early-return path the
  // caller supplies the OLD matching fact's id as `newMemoryId` (no new file is
  // written).  That makes `newMemoryFile.frontmatter.created` an arbitrarily
  // old timestamp.  When `args.useCallerTimestamp` is set the caller explicitly
  // opts out of the persisted-timestamp lookup so `args.createdAt` (the
  // incoming event time: source valid_at when present, otherwise wall-clock) is
  // used directly, keeping ordering correct regardless of how old the matching
  // fact is.
  const newMemoryFile = hotMemories.find((m) => m.frontmatter.id === args.newMemoryId);
  const persistedCreatedAt = args.useCallerTimestamp
    ? args.createdAt
    : (newMemoryFile ? effectiveValidAt(newMemoryFile.frontmatter) : args.createdAt);

  const supersededIds: string[] = [];
  const matchedKeys = new Set<string>();

  // Process hot then cold.  Hot-then-cold ordering is safer because hot
  // writes are more frequent and the CAS re-read guards against double-writes.
  // A Set<string> of already-processed ids ensures that a memory visible in
  // both tiers (same logical memory with different filesystem paths during a
  // migration race) is processed at most once.  Keying on `frontmatter.id`
  // is correct because the same logical memory has the same id regardless of
  // which tier's directory it currently lives in (PR #402 Finding 1 fix).
  // Fall back to path-based keying when id is absent (defensive).
  const processedIds = new Set<string>();

  // Finding UOGi fix (round-6): readAllColdMemories() performs a full uncached
  // recursive directory scan of cold/.  After Finding UTsP broadened the scan
  // to cover the entire cold root (not just facts/+corrections/), the per-call
  // cost grows with the cold tree size.
  //
  // The fix is a TTL-based in-memory cache inside StorageManager
  // (readAllColdMemories caches its result for COLD_SCAN_CACHE_TTL_MS) that is
  // shared across consecutive supersession calls within the same write burst.
  // The cache is invalidated automatically on any hot→cold demotion (which
  // calls invalidateAllMemoriesCache, which also clears the cold cache) and
  // expires after the TTL as a safety net.
  //
  // This means back-to-back structured-attribute writes in the same burst
  // (e.g. batch extraction) pay the cold I/O cost at most once, not N times.
  // Correctness is preserved because the cache TTL ensures eventual consistency
  // and the invalidation hook covers the hot→cold path.

  let coldMemories: MemoryFile[];
  try {
    coldMemories = await args.storage.readAllColdMemories();
  } catch (err) {
    log.warn(`temporal-supersession: readAllColdMemories failed: ${err}`);
    coldMemories = [];
  }

  // Combine hot and cold memories into a single scan.  New memory itself is
  // excluded inline.  We do NOT skip cold scan when hot produced zero
  // supersessions — the P1 finding is precisely that stale cold facts leak
  // when hot has no hits.
  const allCandidates: MemoryFile[] = [...hotMemories, ...coldMemories];

  for (const memory of allCandidates) {
    if (memory.frontmatter.id === args.newMemoryId) continue;
    const dedupeKey = memory.frontmatter.id ?? memory.path;
    if (processedIds.has(dedupeKey)) continue;
    const snapshotStatus = memory.frontmatter.status ?? "active";
    if (snapshotStatus !== "active") {
      // A stale non-active snapshot entry must not suppress an active copy of
      // the same logical memory that appears later in another tier.  This can
      // happen during hot/cold migration races where the hot snapshot is already
      // superseded but the cold copy is still active and should be evaluated.
      continue;
    }
    // NOTE: do NOT call processedIds.add(dedupeKey) here.  We defer marking
    // the id as processed until AFTER the CAS re-read succeeds.  If we mark
    // it here and the re-read fails (e.g. the hot entry has already been
    // migrated to cold storage), the same logical id that appears later in
    // the cold tier scan would be silently skipped, leaving a stale cold
    // fact unsuperseded.  Deferring ensures that a failed primary-tier read
    // grants the alternate tier a chance to process the same id (PR #402
    // round-6 Finding 1 fix).

    const decision = shouldSupersedeExisting({
      candidate: memory.frontmatter,
      newEntityRef: args.entityRef,
      newAttributes: args.structuredAttributes,
      newCreatedAt: persistedCreatedAt,
      newMemoryId: args.newMemoryId,
    });
    if (!decision) {
      // No supersession decision — safe to mark as processed now so the
      // alternate tier doesn't re-evaluate an identical non-matching entry.
      processedIds.add(dedupeKey);
      continue;
    }

    try {
      // CAS-style re-read immediately before the write.  `readAllMemories()`
      // is a snapshot — with concurrent writers, another run may have already
      // superseded this candidate since we loaded it.  If we blindly trust the
      // snapshot we can clobber a newer `supersededBy` link with a stale one.
      //
      // File storage offers no true locking, so the best we can do is:
      //   1. re-read the exact file we're about to mutate
      //   2. verify status is still "active" and no `supersededBy` is set
      //   3. only then issue the write
      // If the re-read shows a newer concurrent writer beat us to it, skip.
      // This CAS pattern applies equally to hot and cold tier candidates.
      // Mark as processed AFTER confirming the candidate is readable so that
      // a migration-race read failure on the hot entry does not silently
      // prevent the cold entry from being evaluated (Finding 1, round 6).
      const fresh = await args.storage.readMemoryByPath(memory.path);
      if (!fresh) {
        log.debug(
          `[engram] temporal supersession skipped candidate ${memory.frontmatter.id}: no longer readable at ${memory.path} — leaving id available for alternate tier`,
        );
        // Do NOT add to processedIds — allow the cold-tier copy to be
        // evaluated in the next iteration of the same scan.
        continue;
      }
      // Candidate is readable — mark the id as processed now to prevent the
      // alternate tier from double-writing.
      processedIds.add(dedupeKey);
      const freshStatus = fresh.frontmatter.status ?? "active";
      if (freshStatus !== "active" || fresh.frontmatter.supersededBy) {
        log.debug(
          `[engram] temporal supersession skipped candidate ${memory.frontmatter.id}: already superseded by concurrent writer`,
        );
        continue;
      }

      // Finding 2 fix: the `supersededAt` / `updated` timestamps written to the
      // old fact must never run backwards relative to its own persisted
      // `created` timestamp.  If the caller-supplied `args.createdAt` (which
      // represents "when the new replacing fact was authored") is earlier than
      // either the new fact's persisted `created` (T_new) or the old fact's
      // persisted `created` (T_old), we'd be writing a nonsensical
      // `supersededAt` that precedes the old memory's own creation.  Clamp to
      // the monotonic maximum so time only moves forward.
      // This monotonic clamp is applied for both hot and cold tier writes.
      const oldCreatedMs = new Date(fresh.frontmatter.created).getTime();
      const newCreatedMs = new Date(persistedCreatedAt).getTime();
      const argCreatedMs = new Date(args.createdAt).getTime();
      const maxMs = Math.max(
        Number.isFinite(oldCreatedMs) ? oldCreatedMs : 0,
        Number.isFinite(newCreatedMs) ? newCreatedMs : 0,
        Number.isFinite(argCreatedMs) ? argCreatedMs : 0,
      );
      const supersededAt = new Date(maxMs).toISOString();

      // Issue #680 — explicit fact lifecycle.  When the new fact
      // supersedes this one, set the predecessor's `invalid_at` to the
      // successor's effective valid_at.  Skip when the predecessor
      // already carries an `invalid_at` so manual / earlier values
      // are preserved (idempotent).
      //
      // Codex P1 on PR #713: in the hash-dedup early-return path
      // (`useCallerTimestamp: true`), `newMemoryFile` is actually the
      // OLD matching fact — no new file was written — so its
      // `valid_at` is the predecessor's own old timestamp, not the
      // successor's effective time. Use `persistedCreatedAt`
      // directly in that path so the predecessor's invalid_at lines
      // up with the caller's wall-clock, not the matching fact's old
      // valid_at. The non-dedup path keeps the previous behavior
      // (prefer the new file's explicit valid_at, fall back to its
      // persisted created).
      let invalidAtPatch: string | undefined;
      if (!fresh.frontmatter.invalid_at) {
        if (args.useCallerTimestamp) {
          invalidAtPatch = persistedCreatedAt;
        } else {
          const newValidAt = newMemoryFile?.frontmatter.valid_at?.trim();
          invalidAtPatch =
            newValidAt && newValidAt.length > 0 ? newValidAt : persistedCreatedAt;
        }
      }
      const wrote = await args.storage.writeMemoryFrontmatter(
        fresh,
        {
          status: "superseded",
          supersededBy: args.newMemoryId,
          supersededAt,
          updated: supersededAt,
          ...(invalidAtPatch ? { invalid_at: invalidAtPatch } : {}),
        },
        {
          actor: "temporal-supersession",
          reasonCode: "structured-attribute-update",
          relatedMemoryIds: [args.newMemoryId],
        },
      );
      if (wrote) {
        supersededIds.push(memory.frontmatter.id);
        for (const key of decision.matchedKeys) matchedKeys.add(key);
        await expireChildChunksForSupersededParent({
          storage: args.storage,
          allCandidates,
          parentId: fresh.frontmatter.id,
          newMemoryId: args.newMemoryId,
          supersededAt,
          invalidAt: invalidAtPatch ?? fresh.frontmatter.invalid_at,
        });
      }
    } catch (err) {
      log.warn(
        `temporal-supersession: failed to mark ${memory.frontmatter.id} superseded: ${err}`,
      );
    }
  }

  if (supersededIds.length > 0) {
    log.debug(
      `temporal-supersession: marked ${supersededIds.length} memories superseded by ${args.newMemoryId} (keys=${Array.from(matchedKeys).join(",")})`,
    );
  }

  return { supersededIds, matchedKeys: Array.from(matchedKeys) };
}

/**
 * Recall-side filter: returns true when the candidate should be excluded
 * from recall because it has been temporally superseded.  When
 * `includeInRecall` is true, this always returns false (the fact is kept),
 * matching the audit/history opt-in described in the config.
 */
export function shouldFilterSupersededFromRecall(
  frontmatter: MemoryFrontmatter,
  options: { enabled: boolean; includeInRecall: boolean },
): boolean {
  if (!options.enabled) return false;
  if (options.includeInRecall) return false;
  return frontmatter.status === "superseded";
}
