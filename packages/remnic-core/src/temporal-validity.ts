/**
 * Temporal validity helpers (issue #680).
 *
 * `valid_at` / `invalid_at` are explicit ISO 8601 timestamps that mark when a
 * fact begins and ends being authoritative.  These helpers centralize the
 * read-time defaulting rules so every call site (recall filter, supersession
 * write, tests) agrees on the canonical semantics:
 *
 *   - `effectiveValidAt(fm)` — the moment this fact starts being true.
 *     Falls back to `created` when `valid_at` is absent so legacy memories
 *     written before #680 still participate in `as_of` filtering without
 *     a backfill migration.
 *   - `effectiveInvalidAt(fm)` — the moment this fact stops being true.
 *     Returns `undefined` when no `invalid_at` is set; supersession logic
 *     populates it on the older fact when a newer one replaces it.
 *   - `isValidAsOf(fm, asOfMs)` — true when the fact was authoritative at
 *     `asOfMs` (a numeric timestamp in ms).  Half-open interval semantics:
 *     `valid_at <= asOf < invalid_at`.  Strings are parsed via
 *     `Date.parse()` so timezone-suffixed ISO strings compare correctly
 *     (CLAUDE.md gotcha — never compare ISO strings lexicographically).
 *
 * Boundary case: when `invalid_at === asOf`, the fact is treated as NOT
 * valid (the upper bound is exclusive), which matches the supersession
 * model — at the instant a successor's `valid_at` fires, the predecessor
 * is no longer authoritative.
 */
import type { MemoryFrontmatter } from "./types.js";

export function effectiveValidAt(fm: Pick<MemoryFrontmatter, "valid_at" | "created">): string {
  const explicit = fm.valid_at?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return fm.created;
}

export function effectiveInvalidAt(
  fm: Pick<MemoryFrontmatter, "invalid_at" | "supersededAt" | "status">,
): string | undefined {
  const explicit = fm.invalid_at?.trim();
  if (explicit && explicit.length > 0) return explicit;
  if (fm.status === "superseded") {
    const legacy = fm.supersededAt?.trim();
    if (legacy && legacy.length > 0) return legacy;
  }
  return undefined;
}

/**
 * Returns true when the fact was authoritative at `asOfMs` (parsed
 * milliseconds since epoch).  Half-open semantics: a fact is valid in
 * `[valid_at, invalid_at)`.
 *
 * If `valid_at` cannot be parsed, the fact is conservatively treated as
 * NOT valid at the requested point — we never silently default a corrupt
 * timestamp to "always true" because that would let bad data leak past
 * the historical filter (CLAUDE.md gotcha #34: distinguish empty from
 * malformed).
 */
export function isValidAsOf(
  fm: Pick<
    MemoryFrontmatter,
    | "valid_at"
    | "invalid_at"
    | "created"
    | "supersededAt"
    | "status"
    | "eventTimeSource"
  >,
  asOfMs: number,
): boolean {
  if (!Number.isFinite(asOfMs)) return true;
  const explicitValidAt = fm.valid_at?.trim();
  if (
    (!explicitValidAt || explicitValidAt.length === 0) &&
    fm.eventTimeSource === "extracted"
  ) {
    const invalidAt = effectiveInvalidAt(fm);
    if (invalidAt !== undefined) {
      const invalidAtMs = Date.parse(invalidAt);
      if (Number.isFinite(invalidAtMs)) return invalidAtMs > asOfMs;
    }
  }
  const validAtMs = Date.parse(effectiveValidAt(fm));
  if (!Number.isFinite(validAtMs)) return false;
  if (validAtMs > asOfMs) return false;
  const invalidAt = effectiveInvalidAt(fm);
  if (invalidAt === undefined) return true;
  const invalidAtMs = Date.parse(invalidAt);
  if (!Number.isFinite(invalidAtMs)) return true;
  return invalidAtMs > asOfMs;
}

/**
 * Bi-temporal injection filter (issue #1578).
 *
 * Returns `true` when the fact's event-time interval has already ended before
 * `nowMs` — i.e. it is no longer *true in the world* and should leave the
 * default injection candidate set (it remains findable by explicit search
 * and `as_of` queries, mirroring the lifecycle-filter escape-hatch principle
 * in AGENTS.md §16).  Gated by `temporalBiTemporal`; the escape hatch
 * `temporalExpiredInInjection` re-admits expired facts when a deployment
 * prefers the older always-inject behavior.
 *
 * Semantics: a fact is expired-now when `invalid_at` is present and
 * `invalid_at <= nowMs` (the exclusive upper bound has passed).  Absent
 * `invalid_at` means "still valid" — never expired.  This is the
 * status-orthogonal complement of `isValidAsOf` for the wall-clock instant:
 * an `active` memory can be validity-expired, and a `superseded` one can
 * still be validity-valid within its historical window (issue pitfall: the
 * filter is status-orthogonal).
 */
export function isValidityExpiredNow(
  fm: Pick<MemoryFrontmatter, "invalid_at">,
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const invalidAt = fm.invalid_at?.trim();
  if (!invalidAt || invalidAt.length === 0) return false;
  const invalidAtMs = Date.parse(invalidAt);
  if (!Number.isFinite(invalidAtMs)) return false;
  return invalidAtMs <= nowMs;
}

/**
 * Parse and validate an `as_of` value supplied at an input boundary
 * (CLI flag, HTTP query param, MCP field).  Returns parsed milliseconds
 * on success; throws a `RangeError` with a helpful message on malformed
 * input.  CLAUDE.md rule 51 — never silently default invalid input.
 */
export function parseAsOfTimestamp(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new RangeError(
      `as_of must be a non-empty ISO 8601 timestamp string (got: ${typeof raw === "string" ? `"${raw}"` : typeof raw})`,
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `as_of must be a parseable ISO 8601 timestamp (got: "${raw}")`,
    );
  }
  return ms;
}
