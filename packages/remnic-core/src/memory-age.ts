/**
 * Shared memory-age resolution (issue #2976).
 *
 * "Age is not mtime" (distill-kura `weave.py` `age_days`): `cp -r`, a
 * restore, a checkout, or a bulk import resets file mtimes, so any freshness
 * mechanism keyed on mtime either switches itself off or boosts everything
 * equally. Remnic therefore resolves a memory's age from dates written
 * INSIDE the memory first:
 *
 *   1. frontmatter `created` — the recall ranking reference before #2976,
 *      kept first so every dated memory scores exactly as it did;
 *   2. frontmatter `updated` — the content-revision date;
 *   3. file mtime — only when no content date exists AND the caller's trust
 *      assessment accepts it (see `assessMtimeTrust`);
 *   4. otherwise UNKNOWN: no reference instant, and downstream scoring must
 *      treat unknown age as never-fresh (no recency boost), never as
 *      "just written".
 *
 * Bi-temporal `valid_at`/`observedAt` are deliberately NOT in the ladder:
 * they date when the fact was true, not when the memory was written, so a
 * fresh correction about an old event would be misaged by them.
 *
 * Bulk-touch heuristic (distill-kura measured 50/214 files sharing one
 * bulk-touch day, mtime understating true age by a median of 11 days, worst
 * case 425): a UTC calendar day shared by >= max(BULK_TOUCH_MIN_FILES,
 * BULK_TOUCH_STORE_FRACTION of the sampled files) is a bulk-touch day, and
 * mtimes falling on a bulk-touch day are untrusted — those ages are unknown,
 * not fresh. The sample is the scored result set of the calling pipeline
 * (bounded I/O), which observes a bulk-touched store as a same-day cluster.
 */

import { stat } from "node:fs/promises";

/** Minimum files sharing one calendar day before that day is bulk-touched. */
export const BULK_TOUCH_MIN_FILES = 2;
/** Fraction of the sampled files on one day that marks a bulk touch. */
export const BULK_TOUCH_STORE_FRACTION = 0.2;

/** Recency half-life (days) used by `applyRecencyBoost`. */
export const RECENCY_HALF_LIFE_DAYS = 7;

/** How the resolved age reference was obtained. */
export type MemoryAgeSource = "content" | "mtime" | "unknown";

export interface ResolvedMemoryAge {
  /** Reference instant for age computations, or null when age is unknown. */
  referenceMs: number | null;
  source: MemoryAgeSource;
}

/** Content dates written inside the memory (frontmatter). */
export interface MemoryAgeDates {
  created?: string | null;
  updated?: string | null;
}

/** Minimal memory shape the resolver needs; `path` keys the mtime fallback. */
export interface MemoryAgeSubject extends MemoryAgeDates {
  path: string;
}

/** MemoryFile slice `applyRecencyBoost` reads; dates live in frontmatter. */
export interface RecencyBoostSubject {
  path: string;
  frontmatter: MemoryAgeDates;
}

/** Result of assessing a sample of mtimes for bulk-touch clustering. */
export interface MtimeTrust {
  /** UTC day keys ("YYYY-MM-DD") whose mtime counts mark a bulk touch. */
  bulkTouchDays: ReadonlySet<string>;
  isTrusted(mtimeMs: number): boolean;
}

/** Per-recall mtime fallback context (null when no scored memory needs it). */
export interface MtimeFallbackContext {
  mtimeMsByPath: Map<string, number | null>;
  trust: MtimeTrust;
}

function finiteMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the reference instant for a memory's age. Content dates win over
 * mtime; an mtime is consulted only when no content date parses and the
 * trust assessment (when provided) accepts it; otherwise age is unknown.
 */
export function resolveMemoryAge(
  subject: MemoryAgeDates,
  mtimeMs?: number | null,
  trust?: MtimeTrust | null,
): ResolvedMemoryAge {
  const contentMs = finiteMs(subject.created) ?? finiteMs(subject.updated);
  if (contentMs !== null) return { referenceMs: contentMs, source: "content" };
  if (
    typeof mtimeMs === "number" &&
    Number.isFinite(mtimeMs) &&
    trust?.isTrusted(mtimeMs) !== false
  ) {
    return { referenceMs: mtimeMs, source: "mtime" };
  }
  return { referenceMs: null, source: "unknown" };
}

/** UTC calendar-day key ("YYYY-MM-DD") for a millisecond instant. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Assess a sample of mtimes: days shared by >= max(BULK_TOUCH_MIN_FILES,
 * BULK_TOUCH_STORE_FRACTION of the sample) are bulk-touch days, and their
 * mtimes are untrusted for age. An empty or scattered sample trusts nothing
 * less than it did before — only clustering changes anything.
 */
export function assessMtimeTrust(sampleMtimesMs: readonly number[]): MtimeTrust {
  const counts = new Map<string, number>();
  for (const ms of sampleMtimesMs) {
    if (!Number.isFinite(ms)) continue;
    const key = utcDayKey(ms);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(
    BULK_TOUCH_MIN_FILES,
    sampleMtimesMs.length * BULK_TOUCH_STORE_FRACTION,
  );
  const bulkTouchDays = new Set<string>();
  for (const [day, count] of counts) {
    if (count >= threshold) bulkTouchDays.add(day);
  }
  return {
    bulkTouchDays,
    isTrusted: (mtimeMs: number) => Number.isFinite(mtimeMs) && !bulkTouchDays.has(utcDayKey(mtimeMs)),
  };
}

/**
 * Build the mtime fallback context for a recall boost pass. Returns null —
 * with zero stat calls — when every scored memory already has a content
 * date, so the common path pays nothing. Otherwise stats the scored files
 * (bounded by the result count) and assesses their mtimes for bulk-touch
 * clustering. Unreadable files map to null mtimes (unknown age, never fresh).
 */
export async function collectMtimeFallbackContext(
  memories: ReadonlyArray<MemoryAgeSubject>,
): Promise<MtimeFallbackContext | null> {
  const needsFallback = memories.some(
    (m) => finiteMs(m.created) === null && finiteMs(m.updated) === null,
  );
  if (!needsFallback) return null;
  const stats = await Promise.all(
    memories.map(async (m) => {
      try {
        return (await stat(m.path)).mtimeMs;
      } catch {
        return null;
      }
    }),
  );
  const mtimeMsByPath = new Map<string, number | null>(
    memories.map((m, i) => [m.path, stats[i] ?? null]),
  );
  const trust = assessMtimeTrust(
    stats.filter((ms): ms is number => ms !== null && Number.isFinite(ms)),
  );
  return { mtimeMsByPath, trust };
}

/**
 * Apply the exponential recency blend to one score. Age resolves per
 * `resolveMemoryAge`; unknown age leaves the score untouched (never fresh).
 * A future reference instant clamps to age zero rather than boosting above
 * the recency ceiling (corrupt dates are not super-fresh).
 */
export function applyRecencyBoost(
  score: number,
  memory: RecencyBoostSubject,
  recencyWeight: number,
  nowMs: number,
  fallback?: MtimeFallbackContext | null,
): number {
  if (recencyWeight <= 0) return score;
  const resolved = resolveMemoryAge(
    memory.frontmatter,
    fallback?.mtimeMsByPath.get(memory.path) ?? null,
    fallback?.trust,
  );
  if (resolved.referenceMs === null) return score;
  const ageDays = Math.max(0, (nowMs - resolved.referenceMs) / 86_400_000);
  const recencyScore = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return score * (1 - recencyWeight) + recencyScore * recencyWeight;
}
