
import { z } from "zod";

import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import { readEnvVar } from "./runtime/env.js";
import { collapseWhitespace } from "./whitespace.js";
import type { MemoryFrontmatter, ProvenanceConfig, ProvenanceSource } from "./types.js";
import { isSafeMemoryContent } from "./sanitize.js";

const PROVENANCE_SOURCE_KEY_ORDER = [
  "sessionKey",
  "turnId",
  "observedAt",
  "quote",
  "charStart",
  "charEnd",
] as const;

function canonicalProvenanceSource(src: ProvenanceSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROVENANCE_SOURCE_KEY_ORDER) {
    const value = src[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function serializeProvenanceFields(fm: MemoryFrontmatter, lines: string[]): void {
  let hasValidSources = false;
  if (fm.sources && fm.sources.length > 0) {
    const canonical: Record<string, unknown>[] = [];
    for (const src of fm.sources) {
      const result = ProvenanceSourceSchema.safeParse(src);
      if (result.success) canonical.push(canonicalProvenanceSource(result.data));
    }
    if (canonical.length > 0) {
      lines.push(`sources: ${JSON.stringify(canonical)}`);
      hasValidSources = true;
    }
  }
  const tag =
    (fm.provenance === "verified" || fm.provenance === "unverified") && !hasValidSources
      ? "none"
      : fm.provenance;
  if (tag) {
    lines.push(`provenance: ${tag}`);
  }
}

export function parseProvenanceTag(
  raw: string | undefined,
): "verified" | "unverified" | "none" | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "verified" || trimmed === "unverified" || trimmed === "none") {
    return trimmed;
  }
  return undefined;
}

export function reconcileProvenanceRead(
  tag: "verified" | "unverified" | "none" | undefined,
  sources: ProvenanceSource[] | undefined,
): "verified" | "unverified" | "none" | undefined {
  if ((tag === "verified" || tag === "unverified") && (!sources || sources.length === 0)) {
    return "none";
  }
  return tag;
}

function isStrictIsoTimestamp(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  const d = new Date(Date.UTC(y, mo - 1, da, h, mi, se));
  return (
    !Number.isNaN(Date.parse(s)) &&
    d.getUTCFullYear() === y &&
    d.getUTCMonth() === mo - 1 &&
    d.getUTCDate() === da &&
    d.getUTCHours() === h &&
    d.getUTCMinutes() === mi &&
    d.getUTCSeconds() === se
  );
}

function toStrictIsoTimestamp(ts: string | undefined | null): string | undefined {
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const value = ts.trim();
  if (value.length === 0) return undefined;
  if (isStrictIsoTimestamp(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  const yearLedPrefix = parseYearLedDatePrefix(value);
  const yearLedAgrees = yearLedAgreesWithDateParse(parsed, value, yearLedPrefix);
  const validYearLed = yearLedPrefix !== null && yearLedAgrees;
  if (!/[-:T]/.test(value) && !validYearLed) {
    return undefined;
  }
  if (/^\d{4}\D/.test(value) && !validYearLed) {
    return undefined;
  }
  const mdy = /^(\d{1,2})\D(\d{1,2})\D(\d{4})/.exec(value);
  if (mdy) {
    const a = Number(mdy[1]), b = Number(mdy[2]), yr = Number(mdy[3]);
    if (!isValidCalendarDate(yr, a, b) && !isValidCalendarDate(yr, b, a)) {
      return undefined;
    }
  }
  const iso = new Date(parsed).toISOString();
  return isStrictIsoTimestamp(iso) ? iso : undefined;
}

function isValidCalendarDate(y: number, mo: number, da: number): boolean {
  if (mo < 1 || mo > 12 || da < 1) return false;
  const leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
  const daysInMonth = [31, leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return da <= daysInMonth[mo - 1]!;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  sept: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function parseYearLedDatePrefix(s: string): { y: number; mo: number; da: number } | null {
  const m = /^(\d{4})[^0-9A-Za-z]+(\d{1,2}|[A-Za-z]{3,})[^0-9A-Za-z:]+(\d{1,2})(?![\d:])/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const da = Number(m[3]);
  const mo = /^\d+$/.test(m[2]) ? Number(m[2]) : (MONTH_NAMES[m[2]!.toLowerCase()] ?? -1);
  if (!isValidCalendarDate(y, mo, da)) return null;
  return { y, mo, da };
}

/**
 * Named timezone abbreviations Node's `Date.parse` accepts for non-ISO dates
 * (issue #1723 codex r8). V8 recognizes a fixed set of US zones; each maps to a
 * fixed offset (the abbreviation itself encodes standard vs daylight, so PST is
 * always -8 and PDT always -7 regardless of the calendar date). Other named
 * zones (CET/CEST/JST/…) return NaN from `Date.parse` and never reach here.
 */
const NAMED_ZONE_OFFSETS_MS: Record<string, number> = {
  PST: -8 * 60, PDT: -7 * 60,
  MST: -7 * 60, MDT: -6 * 60,
  CST: -6 * 60, CDT: -5 * 60,
  EST: -5 * 60, EDT: -4 * 60,
};

function explicitOffsetMs(value: string): number | null {
  const nz = /\b([A-Z]{3,4})\s*$/.exec(value);
  if (nz && NAMED_ZONE_OFFSETS_MS[nz[1]] !== undefined) {
    return NAMED_ZONE_OFFSETS_MS[nz[1]] * 60_000;
  }
  const tryOff = (sign: string | undefined, hh: number, mm: number): number | null => {
    if (hh > 14 || mm > 59) return null;
    return (sign === "-" ? -1 : 1) * (hh * 60 + mm) * 60_000;
  };
  let m: RegExpExecArray | null;
  if (
    (m = /\b(?:GMT|UTC)\b\s*([+-])?(\d{1,2}):(\d{2})/i.exec(value)) ||
    (m = /\b(?:GMT|UTC)\b\s*([+-])?(\d{2})(\d{2})/i.exec(value))
  ) {
    const r = tryOff(m[1], Number(m[2]), Number(m[3]));
    if (r !== null) return r;
  }
  if ((m = /\b(?:GMT|UTC)\b\s*([+-])?(\d{1,2})\b/i.exec(value))) {
    const r = tryOff(m[1], Number(m[2]), 0);
    if (r !== null) return r;
  }
  if (/\b(?:GMT|UTC)\b/i.test(value)) return 0;
  if (
    (m = /(?:\s|(?<=:\d{2}))([+-])(\d{1,2}):(\d{2})\s*$/.exec(value)) ||
    (m = /(?:\s|(?<=:\d{2}))([+-])(\d{2})(\d{2})\s*$/.exec(value)) ||
    (m = /(?:\s|(?<=:\d{2}))([+-])(\d{1,2})\s*$/.exec(value))
  ) {
    const r = tryOff(m[1], Number(m[2]), m[3] ? Number(m[3]) : 0);
    if (r !== null) return r;
  }
  return null;
}

function yearLedAgreesWithDateParse(
  parsed: number,
  value: string,
  prefix: { y: number; mo: number; da: number } | null,
): boolean {
  if (prefix === null) return false;
  const off = explicitOffsetMs(value);
  if (off !== null) {
    const shifted = new Date(parsed + off);
    return (
      shifted.getUTCFullYear() === prefix.y &&
      shifted.getUTCMonth() + 1 === prefix.mo &&
      shifted.getUTCDate() === prefix.da
    );
  }
  const pd = new Date(parsed);
  const localMatch =
    pd.getFullYear() === prefix.y &&
    pd.getMonth() + 1 === prefix.mo &&
    pd.getDate() === prefix.da;
  const utcMatch =
    pd.getUTCFullYear() === prefix.y &&
    pd.getUTCMonth() + 1 === prefix.mo &&
    pd.getUTCDate() === prefix.da;
  return localMatch || utcMatch;
}

const ProvenanceSourceSchema = z
  .object({
    sessionKey: z.string().min(1),
    observedAt: z
      .string()
      .min(1)
      .refine(isStrictIsoTimestamp, "must be a valid ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SS[Z|±HH:MM], no calendar overflow)"),
    quote: z.string().min(1),
    turnId: z.string().min(1).optional(),
    charStart: z.number().finite().nonnegative().int().optional(),
    charEnd: z.number().finite().nonnegative().int().optional(),
  })
  .refine(
    (src) => src.charStart === undefined || src.charEnd === undefined || src.charEnd >= src.charStart,
    { message: "charEnd must be >= charStart (half-open interval, rule 35)" },
  );

export function parseProvenanceSources(raw: string | undefined): ProvenanceSource[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const sources: ProvenanceSource[] = [];
  for (const entry of parsed) {
    const result = ProvenanceSourceSchema.safeParse(entry);
    if (result.success) sources.push(result.data);
  }
  return sources.length > 0 ? sources : undefined;
}

export function parseProvenanceConfig(raw: unknown): ProvenanceConfig {
  if (
    raw !== undefined &&
    (raw === null || typeof raw !== "object" || Array.isArray(raw))
  ) {
    throw new Error(
      `provenance must be an object (got ${JSON.stringify(raw)}). Use provenance: { enabled: false } to opt out; omit the key to use the default-on behavior (issue #1575).`,
    );
  }
  const rawProvenance =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    enabled: (() => {
      if (rawProvenance.enabled === undefined) {
        const envEnabled =
          readEnvVar("REMNIC_PROVENANCE_ENABLED") ?? readEnvVar("ENGRAM_PROVENANCE_ENABLED");
        if (envEnabled !== undefined) {
          const coerced = coerceBool(envEnabled);
          if (coerced === undefined) {
            throw new Error(
              `REMNIC_PROVENANCE_ENABLED must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(envEnabled)}`,
            );
          }
          return coerced;
        }
        return true;
      }
      const coerced = coerceBool(rawProvenance.enabled);
      if (coerced === undefined) {
        throw new Error(
          `provenance.enabled must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawProvenance.enabled)}). Omit the key to use the default-on behavior (issue #1575).`,
        );
      }
      return coerced;
    })(),
    maxQuoteChars: (() => {
      if (rawProvenance.maxQuoteChars === undefined) return 300;
      const rawCap = coerceNumber(rawProvenance.maxQuoteChars);
      if (rawCap === undefined || !Number.isFinite(rawCap) || rawCap < 1 || !Number.isInteger(rawCap)) {
        throw new Error(
          `provenance.maxQuoteChars must be a positive integer >= 1 (got ${JSON.stringify(rawProvenance.maxQuoteChars)}).`,
        );
      }
      return rawCap;
    })(),
    requireSpans: (() => {
      if (rawProvenance.requireSpans === undefined) return false;
      const coerced = coerceBool(rawProvenance.requireSpans);
      if (coerced === undefined) {
        throw new Error(
          `provenance.requireSpans must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawProvenance.requireSpans)}).`,
        );
      }
      return coerced;
    })(),
  };
}

// ---------------------------------------------------------------------------
//
//
// ---------------------------------------------------------------------------

export interface ProvenanceTurnInput {
  content: string;
  sessionKey?: string;
  logicalSessionKey?: string;
  timestamp: string;
  turnId?: string;
}

export interface ProvenanceBuildResult {
  /** Verified sources (one per matching turn). Absent when no quote survives. */
  sources?: ProvenanceSource[];
  /** Coarse strength tag persisted to frontmatter. */
  provenance: "verified" | "unverified" | "none";
  /**
   * Transient signal (never persisted): `true` when `config.requireSpans`
   * is enabled and the LLM-provided quote could not be located in ANY source
   * turn (the strict case `ProvenanceConfig.requireSpans` documents: "facts
   * whose quote cannot be located are routed to `pending_review`"). The
   * extraction consumer carries this onto the in-memory `ExtractedFact` so
   * the persist path can route the fact to the review queue. A quote that
   * WAS located but whose source was dropped (e.g. un-coercible timestamp)
   * does NOT set this flag — the span was found, so requireSpans is
   * satisfied (chatgpt-codex-connector thread 4xB).
   */
  requireSpansPending?: boolean;
}

function capQuote(quote: string, maxChars: number): string {
  const glyphs = Array.from(quote);
  if (glyphs.length <= maxChars) return quote;
  let cut = maxChars;
  while (cut > 0 && !/\s/.test(glyphs[cut - 1]!)) cut--;
  if (cut === 0) cut = maxChars; // no word boundary found
  return glyphs.slice(0, cut).join("").trimEnd() + "\u2026";
}

function casefold(s: string): string {
  return s.toLowerCase();
}

/**
 * Locate `quote` within `text`, returning whether a match was found and, when
 * recoverable, the half-open `[start, end)` offsets. Tries exact substring
 * first, then whitespace/case-normalized match.
 *
 * For the normalized path, the mapping from the normalized string back to
 * original offsets is recovered by walking both strings in lockstep: we know
 * `collapseWhitespace(text)` is a subsequence of `text` with whitespace runs
 * collapsed, so we can track the original offset as we scan.
 *
 * Returns `{ matched: false }` when neither match succeeds. Returns
 * `{ matched: true, offsets }` when offsets are recoverable. Returns
 * `{ matched: true }` (offsets omitted) when the normalized substring was
 * found but original offsets could not be recovered — callers still treat
 * this as a verified match and record a source without offsets (cursor
 * thread Ocver — "Normalized match drops verified provenance").
 */
export type LocateQuoteResult =
  | { matched: false }
  | { matched: true; offsets?: { charStart: number; charEnd: number } };

export function locateQuoteOffsets(quote: string, text: string): LocateQuoteResult {
  const exactIdx = text.indexOf(quote);
  if (exactIdx >= 0) {
    return { matched: true, offsets: { charStart: exactIdx, charEnd: exactIdx + quote.length } };
  }

  const normQuote = collapseWhitespace(casefold(quote));
  if (normQuote.length === 0) return { matched: false };
  const normText = collapseWhitespace(casefold(text));
  const normIdx = normText.indexOf(normQuote);
  if (normIdx < 0) return { matched: false };

  const normQuoteLen = normQuote.length;
  let origIdx = 0;
  while (origIdx < text.length && /\s/.test(text[origIdx]!)) origIdx++;
  let normPos = 0;
  let origStart = -1;
  let origEnd = -1;
  let prevWasWs = true; // suppress the leading space in collapsed form
  while (origIdx < text.length && origEnd < 0) {
    const ch = text[origIdx]!;
    if (/\s/.test(ch)) {
      if (!prevWasWs) {
        if (normPos === normIdx) origStart = origIdx; // normalized space aligns
        normPos++;
        prevWasWs = true;
      }
      origIdx++;
      continue;
    }
    if (normPos === normIdx && origStart < 0) {
      origStart = origIdx;
    }
    normPos++;
    prevWasWs = false;
    origIdx++;
    if (normPos >= normIdx + normQuoteLen) {
      origEnd = origIdx;
    }
  }
  if (origStart >= 0 && origEnd >= 0) {
    return { matched: true, offsets: { charStart: origStart, charEnd: origEnd } };
  }
  return { matched: true };
}

/**
 * Build provenance sources for a single extracted fact by locating its
 * LLM-provided `quote` in the buffered turns (issue #1575 PR 2).
 *
 * Matching strategy (per issue design):
 *   1. Exact substring match in a turn → `provenance: "verified"` with
 *      `charStart`/`charEnd` offsets.
 *   2. Whitespace/case-normalized match → `"verified"`, offsets recovered
 *      when possible, else omitted.
 *   3. No match in any turn → `"unverified"` — the quote survives as a
 *      source (the LLM vouched for it) but without located offsets.
 *   4. No quote provided by the LLM → `"none"` — no evidence to record.
 *
 * A quote appearing in multiple turns produces multiple sources (one per
 * matching turn) so a repeated utterance backs the fact from each occurrence.
 *
 * The quote is capped at `config.maxQuoteChars` (truncated at a word boundary
 * with an ellipsis marker) BEFORE storage. Locating uses the original
 * (untruncated) quote for maximum match fidelity; the capped excerpt is what
 * gets persisted.
 *
 * When `config.enabled === false`, returns `{ provenance: "none" }`
 * immediately — byte-identical to pre-feature extraction (rule 39).
 *
 * Never throws. An unexpected error degrades to `{ provenance: "none" }` so
 * extraction never crashes on a provenance hiccup (rule 13/18).
 */
/**
 * Strip a leading extraction-prompt role label from a quote (cursor thread Oc3Z2
 * — "Quote prompt mismatches validator"). The extraction prompt renders each
 * buffered turn as `[role] content` (or `[context role] content`), so a
 * faithful LLM may include that prefix in its verbatim quote. buildFactProvenance
 * searches the raw `turn.content` (no prefix), so a quote carrying the label
 * would never match. Stripping the leading label lets the actual utterance
 * verify against the turn text. Only a SINGLE leading label is stripped — a
 * multi-turn quote (with embedded labels) is left untouched and will simply
 * fail to match a single turn, as before.
 *
 * The regex is constrained to the labels the prompt actually emits — `user`,
 * `assistant`, optionally prefixed with `context ` (extraction.ts renders
 * `[user]`, `[assistant]`, `[context user]`, `[context assistant]`). A
 * real utterance that happens to start with other bracketed text (e.g.
 * `[do not] deploy before approval`, `[P1] fix the cache`) is preserved
 * verbatim so the quote can match the turn and the persisted span retains its
 * original meaning (chatgpt-codex-connector thread 4xA — limiting role-prefix
 * stripping to actual prompt labels).
 */
export function stripLeadingRolePrefix(quote: string): string {
  return quote.replace(/^\s*\[(?:context\s+)?(?:user|assistant)\]\s+/i, "");
}

export function buildFactProvenance(
  factQuote: string | null | undefined,
  turns: ReadonlyArray<ProvenanceTurnInput>,
  config: ProvenanceConfig,
): ProvenanceBuildResult {
  if (!config.enabled) return { provenance: "none" };
  const rawQuote = typeof factQuote === "string" ? factQuote.trim() : "";
  const noneResult = (): ProvenanceBuildResult =>
    config.requireSpans === true
      ? { provenance: "none", requireSpansPending: true }
      : { provenance: "none" };
  if (rawQuote.length === 0) return noneResult();
  const strippedQuote = stripLeadingRolePrefix(rawQuote);
  const useRawQuote =
    rawQuote === strippedQuote ||
    turns.some(
      (t) =>
        typeof t?.content === "string" &&
        t.content.length > 0 &&
        locateQuoteOffsets(rawQuote, t.content).matched,
    );
  const quote = useRawQuote ? rawQuote : strippedQuote;
  if (quote.length === 0) return noneResult();
  if (!isSafeMemoryContent(quote)) return noneResult();

  try {
    const sources: ProvenanceSource[] = [];
    let locatedTurn: ProvenanceTurnInput | undefined;
    for (const turn of turns) {
      if (!turn || typeof turn.content !== "string" || turn.content.length === 0) continue;
      const located = locateQuoteOffsets(quote, turn.content);
      if (!located.matched) continue;
      if (!locatedTurn) locatedTurn = turn;
      const observedAt = toStrictIsoTimestamp(turn.timestamp);
      if (!observedAt) continue;
      sources.push({
        sessionKey: turn.sessionKey ?? turn.logicalSessionKey ?? "unknown",
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        observedAt,
        quote: capQuote(quote, config.maxQuoteChars),
        ...(located.offsets
          ? { charStart: located.offsets.charStart, charEnd: located.offsets.charEnd }
          : {}),
      });
    }

    if (sources.length > 0) {
      return { sources, provenance: "verified" };
    }

    const fallbackTurn = locatedTurn ?? turns[turns.length - 1];
    const fallbackSessionKey = fallbackTurn
      ? (fallbackTurn.sessionKey ?? fallbackTurn.logicalSessionKey ?? "unknown")
      : "unknown";
    const fallbackObservedAt = fallbackTurn
      ? (toStrictIsoTimestamp(fallbackTurn.timestamp) ?? new Date(0).toISOString())
      : new Date(0).toISOString();
    const requireSpansPending =
      config.requireSpans === true && locatedTurn === undefined;
    return {
      sources: [
        {
          sessionKey: fallbackSessionKey,
          observedAt: fallbackObservedAt,
          quote: capQuote(quote, config.maxQuoteChars),
        },
      ],
      provenance: "unverified",
      ...(requireSpansPending ? { requireSpansPending: true } : {}),
    };
  } catch {
    return { provenance: "none" };
  }
}
