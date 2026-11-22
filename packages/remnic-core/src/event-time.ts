import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";

/**
 * Resolved event-time interval.  All timestamps are UTC ISO strings.
 *
 * - `validFrom` / `validUntil` carry the half-open `[from, until)` event
 *   interval.  Either may be absent when the expression only pinned one side
 *   ("since 2024" → validFrom only).
 * - `ok` is false when the expression could not be resolved.  The caller then
 *   falls back to `eventTimeSource: "assumed"`.
 */
export interface ResolvedEventTime {
  validFrom?: string;
  validUntil?: string;
  ok: boolean;
}

const UNITS = ["day", "week", "month", "quarter", "year"] as const;
type RelativeUnit = (typeof UNITS)[number];

function isRelativeUnit(unit: string): unit is RelativeUnit {
  return (UNITS as readonly string[]).includes(unit);
}

/**
 * Format a `Date` as a UTC ISO string with millisecond precision, matching the
 * canonical frontmatter form.  Returns `undefined` when the input is not
 * finite (the resolver treats that as unresolvable rather than emitting
 * `Invalid Date`).
 */
function toIsoUtc(ms: number | null): string | undefined {
  if (ms === null || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Compute the start of the day (UTC) for the given ms, used when a date-only
 * expression resolves a *start* bound — the fact holds from midnight UTC.
 */
function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Compute the start of the *next* day (UTC) for the given ms, used when a
 * date-only expression resolves an *end* bound — the exclusive `validUntil`
 * must land on the following midnight so the end date itself is excluded
 * (AGENTS.md §23: date-only ends convert to start-of-next-day).
 */
function startOfNextDayUtc(ms: number): number {
  const d = new Date(startOfDayUtc(ms));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

const SEASON_TO_MONTH: Record<string, number> = {
  winter: 12, // Dec–Feb anchor Dec (Northern Hemisphere convention)
  spring: 3,
  summer: 6,
  fall: 9,
  autumn: 9,
};

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

const QUARTER_START_MONTH: Record<number, number> = {
  1: 1, 2: 4, 3: 7, 4: 10,
};

function monthIndex(token: string): number | undefined {
  const idx = MONTH_NAMES[token.toLowerCase()];
  return typeof idx === "number" ? idx : undefined;
}

/**
 * Construct a UTC timestamp from year/month(1-12)/day with overflow validation.
 * Returns `null` when the components do not form a real calendar date (e.g.
 * Feb 30) rather than letting `Date` silently roll over.
 */
function buildDateMs(year: number, month1: number, day: number): number | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month1) ||
    month1 < 1 ||
    month1 > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > daysInMonth(year, month1)
  ) {
    return null;
  }
  return Date.UTC(year, month1 - 1, day, 0, 0, 0, 0);
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Add `count` units to a UTC ms timestamp, returning the start-of-period for
 * the resulting date.  Used by "last/this/next <unit>" resolution.
 */
function shiftUnit(anchorMs: number, unit: RelativeUnit, count: number): number {
  const d = new Date(anchorMs);
  switch (unit) {
    case "day":
      d.setUTCDate(d.getUTCDate() + count);
      return startOfDayUtc(d.getTime());
    case "week":
      d.setUTCDate(d.getUTCDate() + count * 7);
      return startOfDayUtc(d.getTime());
    case "month":
      d.setUTCMonth(d.getUTCMonth() + count, 1);
      return startOfDayUtc(d.getTime());
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + count * 3, 1);
      return startOfDayUtc(d.getTime());
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + count, 0, 1);
      return startOfDayUtc(d.getTime());
  }
}

/**
 * Resolve "last December" / "this March" / "next Q2" against the anchor.
 * `direction` is -1 (last), 0 (this), +1 (next).  Returns the start-of-period
 * ms for the referenced month/season/quarter, or `null` if it cannot be
 * placed (e.g. month token not recognized).
 */
function resolveMonthYear(
  anchorMs: number,
  monthToken: string,
  direction: number,
): number | null {
  const lower = monthToken.toLowerCase();
  const targetMonth = monthIndex(lower);
  if (typeof targetMonth === "number") {
    const d = new Date(anchorMs);
    let year = d.getUTCFullYear();
    let m = targetMonth;
    if (direction === -1 && m >= d.getUTCMonth() + 1) year -= 1;
    else if (direction === +1 && m <= d.getUTCMonth() + 1) year += 1;
    return buildDateMs(year, m, 1);
  }
  return null;
}
/**
 * Resolve an explicit "<month|season> <year>" token (e.g. "march 2025",
 * "dec 2024", "spring 2025") to a start-of-month ms.  The explicit year is
 * authoritative — it is never derived from the anchor.  Returns null when
 * the token is not in that shape or does not name a real month/season.
 * Shared by the bare phrase path, "since <month> <year>", and the end bound
 * so all three resolve identically (review: month-year phrases after since).
 */
function resolveExplicitMonthYear(token: string): number | null {
  const m = token.trim().toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const year = parseInt(m[2], 10);
  if (!Number.isInteger(year)) return null;
  const monthIdx = monthIndex(m[1]);
  const baseMonth = typeof monthIdx === "number" ? monthIdx : SEASON_TO_MONTH[m[1]];
  if (typeof baseMonth !== "number") return null;
  return buildDateMs(year, baseMonth, 1);
}


/**
 * Resolve a bare four-digit year token (e.g. "2024") to January 1 of that
 * year.  Used by "since 2024" and bare year expressions.  Review #1578 r2:
 * previously these fell through to ok:false, stamping the fact at ingestion
 * time instead of the documented year start.
 */
function resolveBareYear(token: string): number | null {
  const m = token.trim().match(/^(\d{4})$/);
  if (!m) return null;
  return buildDateMs(Number(m[1]), 1, 1);
}


/**
 * Check whether the anchor month falls inside a season's 3-month span.
 * Seasons start at `baseMonth` and span 3 months (e.g. summer = Jun–Aug).
 * Winter (Dec=12) wraps: Dec, Jan, Feb.
 */
function isInSeason(baseMonth: number, anchorMonth: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (((baseMonth - 1 + i) % 12) + 1 === anchorMonth) return true;
  }
  return false;
}

function resolveSeasonYear(
  anchorMs: number,
  seasonToken: string,
  direction: number,
): number | null {
  const baseMonth = SEASON_TO_MONTH[seasonToken.toLowerCase()];
  if (typeof baseMonth !== "number") return null;
  const d = new Date(anchorMs);
  let year = d.getUTCFullYear();
  const anchorMonth = d.getUTCMonth() + 1;

  if (direction === -1) {
    if (baseMonth > anchorMonth || isInSeason(baseMonth, anchorMonth)) year -= 1;
    if (baseMonth === 12 && anchorMonth <= 2) year -= 1;
  } else if (direction === +1) {
    if (baseMonth === 12 && anchorMonth <= 2) {
      // no year change — next winter is December of the anchor year
    } else if (baseMonth < anchorMonth || isInSeason(baseMonth, anchorMonth)) {
      year += 1;
    }
  } else if (direction === 0 && baseMonth === 12 && anchorMonth <= 2) {
    year -= 1;
  }
  return buildDateMs(year, baseMonth, 1);
}

function resolveQuarter(
  anchorMs: number,
  qNumber: number,
  direction: number,
): number | null {
  const startMonth = QUARTER_START_MONTH[qNumber];
  if (typeof startMonth !== "number") return null;
  const d = new Date(anchorMs);
  let year = d.getUTCFullYear();
  const anchorMonth = d.getUTCMonth() + 1;
  const anchorQ = Math.floor((anchorMonth - 1) / 3) + 1;
  if (direction === -1 && (startMonth >= anchorMonth || anchorQ === qNumber))
    year -= 1;
  else if (direction === +1 && (startMonth <= anchorMonth || anchorQ === qNumber))
    year += 1;
  return buildDateMs(year, startMonth, 1);
}

/**
 * Resolve an absolute ISO date/datetime to ms.  A date-only value yields
 * start-of-day (UTC).  Returns `null` when the string is not a well-formed,
 * non-overflowed ISO timestamp.
 */
function resolveAbsolute(raw: string): number | null {
  const trimmed = raw.trim();
  const ym = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (ym) {
    const ms = buildDateMs(Number(ym[1]), Number(ym[2]), 1);
    return ms === null ? null : startOfDayUtc(ms);
  }
  const ms = parseFlexibleIsoTimestamp(trimmed);
  if (ms === null) return null;
  if (!/[Tt]/.test(trimmed)) return startOfDayUtc(ms);
  return ms;
}

/**
 * Resolve a relative event-time expression against an anchor ISO timestamp.
 *
 * Supported shapes (case-insensitive, trimmed):
 *   - absolute ISO date / datetime: `"2026-03-01"`, `"2026-03-01T00:00:00Z"`
 *   - `"since <date|monthyear>"` → validFrom only
 *   - `"until <date|monthyear>"` / `"through ..."` / `"until end of ..."` → validUntil only
 *   - `"last <month|season|Qn|unit>"` → validFrom = start of referenced period
 *   - `"this <month|season|Qn|unit>"` → validFrom = start of current period
 *   - `"next <month|season|Qn|unit>"` → validFrom = start of referenced period
 *   - `"yesterday"` / `"today"` / `"tomorrow"` → validFrom = start of that day
 *
 * Anything else returns `{ ok: false }`.  The caller then records
 * `eventTimeSource: "assumed"`.
 *
 * @param expression the raw per-fact event-time phrase (may be empty/garbage)
 * @param anchorIso  the source turn's ISO timestamp — the resolution anchor
 */
export function resolveEventTime(
  expression: string | undefined | null,
  anchorIso: string,
): ResolvedEventTime {
  const fallback: ResolvedEventTime = { ok: false };
  if (typeof expression !== "string") return fallback;
  const expr = expression.trim();
  if (expr.length === 0) return fallback;

  const anchorMs = parseFlexibleIsoTimestamp(anchorIso);
  if (anchorMs === null || !Number.isFinite(anchorMs)) return fallback;

  const lower = expr.toLowerCase();

  const sinceMatch = lower.match(/^since\s+(.+)$/);
  if (sinceMatch) {
    const inner = sinceMatch[1].trim();
    let fromMs =
      resolveRelativePeriod(anchorMs, inner) ??
      resolveExplicitMonthYear(inner) ??
      resolveBareYear(inner) ??
      resolveAbsolute(inner);
    if (
      fromMs !== null &&
      fromMs > anchorMs &&
      !/\d{4}/.test(inner)
    ) {
      const nd = new Date(fromMs);
      nd.setUTCFullYear(nd.getUTCFullYear() - 1);
      fromMs = nd.getTime();
    }
    const fromIso = toIsoUtc(fromMs);
    if (!fromIso) return fallback;
    return { validFrom: fromIso, ok: true };
  }
  const untilMatch = lower.match(/^(?:until|through|till|ending)\s+(.+)$/);
  if (untilMatch) {
    const inner = untilMatch[1].trim();
    const untilMs = resolveEndBound(anchorMs, inner);
    const untilIso = toIsoUtc(untilMs);
    if (!untilIso) return fallback;
    return { validUntil: untilIso, ok: true };
  }

  if (lower === "today") {
    const fromIso = toIsoUtc(startOfDayUtc(anchorMs));
    return fromIso ? { validFrom: fromIso, ok: true } : fallback;
  }
  if (lower === "yesterday") {
    const fromIso = toIsoUtc(shiftUnit(anchorMs, "day", -1));
    return fromIso ? { validFrom: fromIso, ok: true } : fallback;
  }
  if (lower === "tomorrow") {
    const fromIso = toIsoUtc(shiftUnit(anchorMs, "day", +1));
    return fromIso ? { validFrom: fromIso, ok: true } : fallback;
  }

  const relMatch = lower.match(/^(last|this|next)\s+(.+)$/);
  if (relMatch) {
    const direction = relMatch[1] === "last" ? -1 : relMatch[1] === "next" ? +1 : 0;
    const period = relMatch[2].trim();
    const ms = resolveRelativePeriod(anchorMs, period, direction);
    const fromIso = toIsoUtc(ms);
    return fromIso ? { validFrom: fromIso, ok: true } : fallback;
  }

  const explicitMs = resolveExplicitMonthYear(lower) ?? resolveBareYear(lower);
  if (explicitMs !== null) {
    const fromIso = toIsoUtc(explicitMs);
    if (fromIso) return { validFrom: fromIso, ok: true };
  }

  const absMs = resolveAbsolute(expr);
  if (absMs !== null) {
    const fromIso = toIsoUtc(absMs);
    return fromIso ? { validFrom: fromIso, ok: true } : fallback;
  }

  return fallback;
}

/**
 * Resolve a period token (with optional direction) to a start-of-period ms.
 * Handles month/season names, quarter tokens (`q1`..`q4`), and relative units
 * (`day/week/month/quarter/year`) used by "last week", "this month", etc.
 */
function resolveRelativePeriod(
  anchorMs: number,
  period: string,
  direction: number = 0,
): number | null {
  const lower = period.trim().toLowerCase();

  const qTok = lower.match(/^q(?:uarter)?\s?([1-4])$/);
  if (qTok) {
    return resolveQuarter(anchorMs, Number(qTok[1]), direction);
  }
  if (lower === "quarter") {
    const d = new Date(anchorMs);
    let q = Math.floor(d.getUTCMonth() / 3) + 1;
    let year = d.getUTCFullYear();
    if (direction === -1) {
      q -= 1;
      if (q < 1) { q = 4; year -= 1; }
    } else if (direction === +1) {
      q += 1;
      if (q > 4) { q = 1; year += 1; }
    }
    return buildDateMs(year, QUARTER_START_MONTH[q], 1);
  }

  if (isRelativeUnit(lower)) {
    return shiftUnit(anchorMs, lower, direction);
  }

  const monthMs = resolveMonthYear(anchorMs, lower, direction);
  if (monthMs !== null) return monthMs;
  const seasonMs = resolveSeasonYear(anchorMs, lower, direction);
  if (seasonMs !== null) return seasonMs;

  return null;
}

/**
 * Resolve an end-bound period to an *exclusive* upper bound ms.  Date-only
 * values convert to start-of-next-day (AGENTS.md §23); period names resolve to
 * the start of the *following* period.
 */
function resolveEndBound(anchorMs: number, period: string): number | null {
  const trimmed = period.trim().replace(/^end\s+of\s+/i, "").trim();

  if (/^\d{4}$/.test(trimmed)) {
    return buildDateMs(Number(trimmed) + 1, 1, 1);
  }

  const ymEnd = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (ymEnd) {
    const startMs = buildDateMs(Number(ymEnd[1]), Number(ymEnd[2]), 1);
    if (startMs === null) return null;
    const nd = new Date(startMs);
    nd.setUTCMonth(nd.getUTCMonth() + 1);
    return startOfDayUtc(nd.getTime());
  }

  const absMs = resolveAbsolute(trimmed);
  if (absMs !== null) {
    if (!/[Tt]/.test(trimmed)) return startOfNextDayUtc(absMs);
    return absMs;
  }
  const explicitMs = resolveExplicitMonthYear(trimmed);
  if (explicitMs !== null) {
    const nd = new Date(explicitMs);
    const firstWord = trimmed.toLowerCase().split(/\s+/)[0];
    const monthAdvance = firstWord in SEASON_TO_MONTH ? 3 : 1;
    nd.setUTCMonth(nd.getUTCMonth() + monthAdvance);
    return startOfDayUtc(nd.getTime());
  }

  const lower = trimmed.toLowerCase();
  const monthIdx = monthIndex(lower);
  if (typeof monthIdx === "number") {
    const d = new Date(anchorMs);
    const startMs = buildDateMs(d.getUTCFullYear(), monthIdx, 1);
    if (startMs === null) return null;
    const nd = new Date(startMs);
    nd.setUTCMonth(nd.getUTCMonth() + 1);
    let endMs = startOfDayUtc(nd.getTime());
    if (endMs > anchorMs && d.getUTCMonth() + 1 !== monthIdx) {
      nd.setUTCFullYear(nd.getUTCFullYear() - 1);
      endMs = startOfDayUtc(nd.getTime());
    }
    return endMs;
  }
  const seasonMonth = SEASON_TO_MONTH[lower];
  if (typeof seasonMonth === "number") {
    const d = new Date(anchorMs);
    const anchorMonth = d.getUTCMonth() + 1;
    let year = d.getUTCFullYear();
    if (seasonMonth === 12 && anchorMonth <= 2) year -= 1;
    const startMs = buildDateMs(year, seasonMonth, 1);
    if (startMs === null) return null;
    const nd = new Date(startMs);
    nd.setUTCMonth(nd.getUTCMonth() + 3);
    let endMs = startOfDayUtc(nd.getTime());
    if (endMs > anchorMs && !isInSeason(seasonMonth, anchorMonth)) {
      nd.setUTCFullYear(nd.getUTCFullYear() - 1);
      endMs = startOfDayUtc(nd.getTime());
    }
    return endMs;
  }
  if (lower === "year") {
    const d = new Date(anchorMs);
    return buildDateMs(d.getUTCFullYear() + 1, 1, 1);
  }
  return null;
}

/**
 * Resolved bi-temporal fields for a single extracted fact (issue #1578 PR2).
 *
 * - `validFrom` / `validUntil` — the event-time `[from, until)` interval.
 *   When `eventTimeSource === "assumed"`, `validFrom` is copied from
 *   `observedAt` (the ingestion anchor) so every bi-temporal-on fact carries
 *   at least a start bound.
 * - `observedAt` — always the ingestion anchor (the source turn timestamp).
 * - `eventTimeSource` — `"extracted"` when the expression resolved to a real
 *   event-time interval; `"assumed"` when the expression was absent or
 *   unresolvable.
 *
 * This is the single write-time helper every extraction entry path calls
 * (rule 39). It is pure: (expression, anchor) in, interval out. Resolution
 * never touches `Date.now()` — replay/import of old transcripts resolves
 * against the old anchor.
 */
export interface FactEventTime {
  validFrom?: string;
  validUntil?: string;
  observedAt: string;
  eventTimeSource: "extracted" | "assumed";
}

/**
 * Resolve a single fact's event-time expression against the ingestion anchor.
 *
 * Returns the bi-temporal interval to persist alongside the fact. When the
 * expression is absent, empty, or unresolvable, falls back to
 * `eventTimeSource: "assumed"` with `validFrom = observedAt` — per the
 * #1578 frontmatter contract. When the expression resolves but only pins one
 * bound ("since 2024" → validFrom only; "until 2025-06" → validUntil only),
 * only the resolved bound is returned.
 */
export function resolveFactEventTime(
  expression: string | undefined | null,
  anchorIso: string,
): FactEventTime {
  const resolved = resolveEventTime(expression, anchorIso);
  if (resolved.ok && (resolved.validFrom !== undefined || resolved.validUntil !== undefined)) {
    return {
      ...(resolved.validFrom !== undefined ? { validFrom: resolved.validFrom } : {}),
      ...(resolved.validUntil !== undefined ? { validUntil: resolved.validUntil } : {}),
      observedAt: anchorIso,
      eventTimeSource: "extracted",
    };
  }
  return {
    validFrom: anchorIso,
    observedAt: anchorIso,
    eventTimeSource: "assumed",
  };
}

/**
 * Input shape for {@link pickFactEventTimeAnchor} — a structural slice of
 * `ExtractedFact` so the helper stays decoupled from the full type.
 */
export interface FactAnchorInput {
  /** Explicit per-fact source-turn timestamp (#1670). */
  sourceTurnTimestamp?: string;
  /** Claim-level provenance spans (#1575), each carrying the turn's `observedAt`. */
  sources?: { observedAt: string }[];
}

/**
 * Issue #1670 — select the per-fact event-time anchor.
 *
 * Prefers the fact's explicit `sourceTurnTimestamp` (set by extractors that
 * know the exact source turn). Falls back to the earliest provenance span's
 * `observedAt` (the turn where the supporting quote was located). Finally
 * falls back to the batch-wide anchor (latest source turn timestamp) when
 * neither per-fact signal is present — preserving legacy behaviour for
 * extractors that do not emit provenance.
 *
 * The earliest provenance span wins because a fact backed by quotes from
 * multiple turns was *first* uttered at the earliest turn: a relative
 * expression ("yesterday") on that fact should resolve against that turn,
 * not a later turn that merely restated the claim.
 *
 * Returns `undefined` only when no signal is usable AND `batchAnchor` is
 * absent — in which case the caller skips bi-temporal resolution entirely
 * (identical to the pre-feature pipeline when biTemporal is off).
 */
export function pickFactEventTimeAnchor(
  fact: FactAnchorInput,
  batchAnchor: string | undefined,
): string | undefined {
  if (
    typeof fact.sourceTurnTimestamp === "string" &&
    fact.sourceTurnTimestamp.trim().length > 0
  ) {
    const ms = parseFlexibleIsoTimestamp(fact.sourceTurnTimestamp.trim());
    if (ms !== null) return new Date(ms).toISOString();
  }
  if (fact.sources && fact.sources.length > 0) {
    let earliestMs: number | null = null;
    for (const src of fact.sources) {
      if (typeof src.observedAt !== "string") continue;
      const ms = parseFlexibleIsoTimestamp(src.observedAt.trim());
      if (ms === null) continue;
      if (earliestMs === null || ms < earliestMs) earliestMs = ms;
    }
    if (earliestMs !== null) return new Date(earliestMs).toISOString();
  }
  return batchAnchor;
}
