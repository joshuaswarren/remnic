/**
 * Claim-level provenance spans (issue #1575 PR 1).
 *
 * Centralizes the parse/serialize logic for the `sources` array and the
 * coarse `provenance` strength tag, plus the `provenance` config-block
 * parser.  Extracted from `storage.ts` and `config.ts` so those files keep
 * only thin delegation call-sites — the frontmatter round-trip and config
 * parsing growth lives here (issue #1520 ratchet discipline).
 *
 * Contract:
 *  - When no provenance fields are present, output is byte-identical to
 *    pre-feature behavior (rule 39).
 *  - Corrupt `sources` lines / unknown `provenance` tags drop to
 *    `undefined` on read so a malformed frontmatter never poisons
 *    downstream readers (rule 34 spirit — drop corrupt rather than poison).
 *  - Validation lives on the write path; this module only parses.
 *  - Invariant (review round 5, cursor thread KQN): a `verified` or
 *    `unverified` tag is NEVER persisted/read without surviving sources —
 *    without excerpts the tag is indistinguishable from a grounded fact to
 *    downstream faithfulness/correction/TrustScore surfaces. The invariant
 *    is enforced symmetrically: `serializeProvenanceFields` (write) and
 *    `reconcileProvenanceRead` (read) both downgrade the tag to `none`
 *    when no source survives.
 */

import { z } from "zod";

import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import { readEnvVar } from "./runtime/env.js";
import { collapseWhitespace } from "./whitespace.js";
import type { MemoryFrontmatter, ProvenanceConfig, ProvenanceSource } from "./types.js";
import { isSafeMemoryContent } from "./sanitize.js";

/**
 * Canonical key order for a serialized `ProvenanceSource` (issue #1575).
 * Deterministic emission (rule 38) — readers and the byte-identical-when-off
 * contract (rule 39) depend on this order never drifting.
 */
const PROVENANCE_SOURCE_KEY_ORDER = [
  "sessionKey",
  "turnId",
  "observedAt",
  "quote",
  "charStart",
  "charEnd",
] as const;

/**
 * Build a single `ProvenanceSource` object whose keys appear in the canonical
 * order, omitting absent optional fields. The result is what gets fed to
 * `JSON.stringify` so the on-disk line is deterministic.
 */
function canonicalProvenanceSource(src: ProvenanceSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROVENANCE_SOURCE_KEY_ORDER) {
    const value = src[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Serialize the `sources` array (issue #1575) as a single JSON line, matching
 * the `structuredAttributes` precedent. Each entry is rebuilt in canonical key
 * order (rule 38) so the output is byte-stable. The `provenance` enum is
 * emitted bare (same style as `status`) — only the three documented values
 * are ever written.
 *
 * Verified-requires-evidence invariant (review round 5, cursor thread KQN):
 * a `verified`/`unverified` tag is downgraded to `none` whenever no source
 * survives write validation — whether sources were absent, an empty array,
 * or all entries failed the schema. This covers all three failure shapes the
 * earlier 3-branch logic left open (`{provenance:"verified"}`,
 * `{sources:[],provenance:"verified"}`, `{sources:[invalid…],provenance:"verified"}`).
 */
export function serializeProvenanceFields(fm: MemoryFrontmatter, lines: string[]): void {
  let hasValidSources = false;
  if (fm.sources && fm.sources.length > 0) {
    // Validate each entry against the same schema used on read so invalid
    // in-memory sources are dropped at write time, not silently lost on the
    // next read (review thread 4 — write-path validation parity).
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
  // A verified/unverified tag requires surviving evidence; without it the
  // tag is meaningless downstream (faithfulness/TrustScore cannot distinguish
  // it from a grounded fact). Downgrade to "none" regardless of WHY no source
  // survived (absent / empty / all-invalid) — single invariant, all cases.
  const tag =
    (fm.provenance === "verified" || fm.provenance === "unverified") && !hasValidSources
      ? "none"
      : fm.provenance;
  if (tag) {
    lines.push(`provenance: ${tag}`);
  }
}

/**
 * Parse the coarse `provenance` strength tag (issue #1575). Returns
 * `undefined` for missing/blank/unknown values so a corrupt or hand-edited
 * field fails safely to the legacy-equivalent `"none"` semantics on read
 * (rule 34 spirit — drop corrupt rather than poison).
 */
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

/**
 * Enforce the verified-requires-evidence invariant on the READ path.
 * `parseProvenanceTag` and `parseProvenanceSources` are independent (they
 * parse separate frontmatter lines), so a hand-edited or imported memory may
 * carry `provenance: verified` with no surviving `sources` — a corrupt line,
 * an empty array, or all-invalid entries. Downgrade such a tag to `none` so
 * the in-memory object never exposes an ungrounded "verified" fact
 * (review round 5, cursor thread KQN — read-path parity with the write-path
 * downgrade in `serializeProvenanceFields`). `none`/`undefined` tags pass
 * through unchanged.
 */
export function reconcileProvenanceRead(
  tag: "verified" | "unverified" | "none" | undefined,
  sources: ProvenanceSource[] | undefined,
): "verified" | "unverified" | "none" | undefined {
  if ((tag === "verified" || tag === "unverified") && (!sources || sources.length === 0)) {
    return "none";
  }
  return tag;
}

/**
 * Strict ISO-8601 timestamp check (review round 6, codex thread OXPAp).
 * `Date.parse` accepts non-ISO strings (bare years like `"123"`) and
 * silently normalizes calendar overflow (`2026-02-30` -> March 2, hour 25
 * -> next day), so malformed provenance survives as if valid. Require the
 * full `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` shape and reject overflow via a
 * `Date.UTC` round-trip component check — the offset does not affect whether
 * a wall-clock field overflows, so this is correct for any timezone suffix.
 */
function isStrictIsoTimestamp(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  // Date.UTC normalizes overflow (Feb 30 -> Mar 2); a component round-trip
  // catches what Date.parse silently accepts.
  const d = new Date(Date.UTC(y, mo - 1, da, h, mi, se));
  // The component round-trip validates wall-clock overflow (Feb 30 -> Mar 2);
  // Date.parse additionally rejects impossible timezone offsets such as
  // +99:99, which the regex accepts but the runtime treats as NaN
  // (codex thread OXQ0e).
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

/**
 * Coerce a turn timestamp to a strict ISO-8601 string (cursor thread Ocveu —
 * "Non-ISO turn timestamps drop sources"). The write-path `ProvenanceSourceSchema`
 * rejects anything `isStrictIsoTimestamp` fails, so a turn whose `timestamp`
 * parses via `new Date(...)` but isn't already strict ISO (e.g.
 * `"2026/01/15 12:00:00"` or `"Jan 15 2026"`) would be silently dropped at
 * serialization — clearing the whole `sources` array and downgrading the tag
 * to `"none"`. Normalizing at extraction time preserves the source.
 *
 * Returns the strict ISO string when the timestamp already passes or
 * `Date.parse` can round-trip it; `undefined` for empty / unparseable input
 * so callers can decide whether to skip the source or fall back.
 */
function toStrictIsoTimestamp(ts: string | undefined | null): string | undefined {
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  // Trim surrounding whitespace: Date.parse accepts leading/trailing
  // whitespace, so an imported " 2026-05" would otherwise bypass the
  // year-led partial-date guard below and fabricate May 1
  // (chatgpt-codex-connector review on #1714, issue #1657).
  const value = ts.trim();
  if (value.length === 0) return undefined;
  if (isStrictIsoTimestamp(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  // Year-led date guard (issues #1657 + #1723). `parseYearLedDatePrefix`
  // recognizes a COMPLETE, calendar-valid year-led prefix — numeric OR textual
  // month — with real date-separator RUNS of non-alphanumeric, non-colon chars
  // (so complete-but-unusual-punctuation dates like "2026 May, 10",
  // "2026, May 10", "2026 Jan. 15" are accepted), the day-not-the-hour
  // invariant via the `(?![\d:])` lookahead, and a calendar-valid day. This
  // single rule subsumes the prior partial-numeric ("2026-05"), textual-partial
  // ("2026-Jan"), and calendar-overflow ("2026-02-30", "2026-Feb-30") checks
  // and extends them to textual months — Date.parse silently fills missing
  // components and rolls overflow, fabricating observedAt, so a non-complete
  // or invalid year-led prefix is rejected. Non-year-led shapes
  // ("Jan 15 2026", "02/30/2026") fall through to Date.parse / the mdy check.
  const yearLedPrefix = parseYearLedDatePrefix(value);
  // Agreement check (issue #1723 codex r2/r3/r4): exotic punctuation can make
  // the prefix structure disagree with Date.parse's own interpretation — e.g.
  // "2026 (May) 10" parses as a valid May 10 PREFIX but Date.parse reads
  // October 1; "2026 May (10)" agrees on month but Date.parse reads day 1 — so
  // the round-trip would persist a fabricated observedAt while the guard
  // "validated" a different date. Require Date.parse's interpretation to match
  // the prefix's FULL (y, m, d) tuple. Offset-bearing inputs compare in the
  // source's explicit offset frame (the prefix date is offset-local, so a UTC
  // instant legitimately falls on an adjacent UTC/local day); offset-free
  // inputs compare both the local and UTC frames (Date.parse uses UTC for ISO
  // date-only strings and local for non-ISO — a single frame would wrongly
  // reject legitimate month/day-boundary dates that shift across timezones).
  const yearLedAgrees = yearLedAgreesWithDateParse(parsed, value, yearLedPrefix);
  const validYearLed = yearLedPrefix !== null && yearLedAgrees;
  // Reject bare-year / numeric-only strings that Date.parse accepts (e.g.
  // "123") — isStrictIsoTimestamp already rejected them, and the round-trip
  // below would otherwise resurrect them. Require at least one date/time
  // separator so a plain number never round-trips into a fake epoch — UNLESS
  // the value is itself a complete, calendar-valid year-led date that
  // Date.parse agrees with (issue #1723: a date-only punctuated textual form
  // like "2026 May, 10" has no -/:/T yet parses to the correct calendar day).
  if (!/[-:T]/.test(value) && !validYearLed) {
    return undefined;
  }
  // Reject year-led timestamps that are not a COMPLETE, calendar-valid date
  // Date.parse agrees with (covers partial, overflow, AND the punctuation
  // misinterpretation above).
  if (/^\d{4}\D/.test(value) && !validYearLed) {
    return undefined;
  }
  // Also validate M/D/Y or D/M/Y formats (provider/import common shapes:
  // 02/30/2026, 30-02-2026, etc.). Date.parse silently shifts overflow in
  // these too. Try both month-first and day-first interpretations; if
  // neither is a valid calendar date, reject (chatgpt-codex-connector thread
  // dH47 — non-YMD overflow timestamps).
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

/**
 * Validate numeric calendar components without Date overflow (review thread
 * dANc). Date.UTC silently normalizes Feb 30 -> Mar 2; a component round-trip
 * catches what Date.parse accepts. Mirrors the same technique isStrictIsoTimestamp
 * uses for full ISO strings, applied here to the non-ISO normalization path.
 */
function isValidCalendarDate(y: number, mo: number, da: number): boolean {
  if (mo < 1 || mo > 12 || da < 1) return false;
  const leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
  const daysInMonth = [31, leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return da <= daysInMonth[mo - 1]!;
}

/**
 * Recognized month-name → number map for year-led textual-month dates
 * (issue #1657). Both the 3-letter abbreviations and the full names that
 * Date.parse accepts for year-first shapes (e.g. "2026-Jan-15",
 * "2026-January-15", "2026 February 2").
 */
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

/**
 * Parse a complete, calendar-valid year-led date prefix from `s`
 * (issue #1657, relaxed in #1723): `YYYY <sep> (MM | MonthName) <sep> DD`
 * where each separator is a RUN of non-alphanumeric, non-colon chars (so a
 * complete date with any punctuation — "2026 May, 10", "2026, May 10",
 * "2026 Jan. 15" — is accepted; the run excludes letters so a textual month
 * is never consumed by the separator, and excludes the colon so the date/time
 * boundary stays clean) and the day is a true calendar day — not the hour
 * before a `:` time separator (the `(?![\d:])` lookahead rejects
 * "2026-05 10:00" capturing "10" as the day). Returns the numeric components
 * for a complete, valid date; `null` for an incomplete ("2026-05",
 * "2026-Jan"), overflowed ("2026-02-30", "2026-Feb-30"), or non-year-led
 * prefix. Centralizes the fabricated-date rejection for the
 * toStrictIsoTimestamp normalization path across numeric and textual months
 * in one rule.
 */
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
 * Extract an explicit timezone offset (ms east of UTC) from a non-strict-ISO
 * timestamp, or `null` if none is present (issue #1723 codex r4). Recognizes
 * the offset forms `Date.parse` accepts for non-ISO year-led dates: a trailing
 * `±HH:MM` / `±HHMM`, and a `GMT`/`UTC` token optionally followed by
 * `±HHMM` (bare `GMT`/`UTC` ⇒ offset 0). Strict ISO `Z` forms are handled
 * by `isStrictIsoTimestamp` before this point, so they never reach here.
 */
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
  // Recognize the offset forms Date.parse accepts for non-ISO year-led dates,
  // returning ms east of UTC or null. Tries each shape in order; a stray run
  // of date digits can never pose as an offset because (a) trailing numeric
  // offsets must be preceded by whitespace or glued to a ":SS" seconds field
  // (lookbehind), and (b) every candidate is range-validated (|hh| ≤ 14,
  // mm < 59).
  // Named US zone abbreviation (PST/EST/EDT/…), trailing token (codex r8).
  const nz = /\b([A-Z]{3,4})\s*$/.exec(value);
  if (nz && NAMED_ZONE_OFFSETS_MS[nz[1]] !== undefined) {
    return NAMED_ZONE_OFFSETS_MS[nz[1]] * 60_000;
  }
  const tryOff = (sign: string | undefined, hh: number, mm: number): number | null => {
    if (hh > 14 || mm > 59) return null;
    return (sign === "-" ? -1 : 1) * (hh * 60 + mm) * 60_000;
  };
  let m: RegExpExecArray | null;
  // GMT/UTC token: colon form, then ±HHMM (4-digit, before bare hour so
  // "GMT+0530" is not read as "+05"), then bare hour, then the bare token
  // itself (offset 0).
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
  // Trailing numeric offset: whitespace-delimited OR glued to a ":SS"
  // seconds field (lookbehind), so date digits ("-0510" in "2026-0510") are
  // never misread as an offset. Colon form, then ±HHMM, then bare hour — each
  // for BOTH the whitespace and glued contexts.
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

/**
 * Verify `Date.parse`'s interpretation of `value` agrees with the year-led
 * `prefix` components `(y, m, d)` (issue #1723 codex r2/r3/r4). Returns
 * `false` when `prefix` is `null` (no complete year-led date). Otherwise
 * compares the FULL tuple so punctuation that shifts the month OR the day is
 * caught. Offset-bearing inputs are compared in the source's explicit offset
 * frame (the prefix date is offset-local, so the same instant legitimately
 * lands on an adjacent UTC/local day); offset-free inputs accept either the
 * local or UTC frame, because `Date.parse` uses UTC for ISO date-only strings
 * and local for non-ISO forms.
 */
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

/**
 * Zod schema for a single `ProvenanceSource` entry (issue #1575).  Parsed
 * JSON from frontmatter is external data, so each entry is validated here
 * rather than trusted via a cast (rule: no inline-cast-access on parsed
 * blobs).  `safeParse` lets us drop corrupt entries individually instead of
 * failing the whole field.
 */
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

/**
 * Parse the `sources` array (issue #1575) from its single-line JSON form.
 * Mirrors `parseStructuredAttributes` (JSON.parse) but validates each entry
 * against `ProvenanceSourceSchema` and DROPS corrupt ones rather than
 * poisoning downstream readers — the same "drop corrupt rather than poison"
 * contract as `parseMemoryWorthCounterField`.  If no entry survives, the
 * whole field is `undefined` (legacy-equivalent).
 */
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

/**
 * Parse the `provenance` config block (issue #1575 PR 1).  Validates the
 * shape before applying defaults — a shorthand like `provenance: false` must
 * reject loudly rather than normalize to `{}` and silently enable the feature
 * (rule 51).  Booleans coerce via `coerceBool` (rule 36); numeric cap clamps
 * at 1 (rule 28).  `REMNIC_PROVENANCE_ENABLED` / `ENGRAM_PROVENANCE_ENABLED`
 * are honored only when the `enabled` key is omitted (explicit config wins).
 *
 * Schema-default note (review rounds 1–3, settled): `provenance.enabled` has
 * NO `"default"` in any plugin.json schema. OpenClaw's loader runs
 * `applyDefaults: true` before exposing `api.pluginConfig` (src/index.ts:1345,
 * PR #1593 round 8), so a schema default would be materialized into the
 * merged config and mask the `REMNIC_`/`ENGRAM_` env override. The code-level
 * default-on here (`return true` when `enabled` is omitted) supplies the
 * default-on behavior without that materialization. This matches the
 * emitLegacyTools/namespaceCatalogEnabled precedent, which omits the env
 * override only after a raw-vs-effective split — overkill for a single
 * boolean, so this field uses the simpler omit-the-default approach.
 */
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
      // Reject present-but-invalid rather than silently widening the cap
      // (AGENTS.md input-validation rule — a typo should not persist more
      // text than the operator configured).
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
// Issue #1575 PR 2 — extraction-side post-parse validator.
// ---------------------------------------------------------------------------
//
// This runs once at write time (inside `ExtractionEngine.extract`, after the
// LLM output is parsed and sanitized, before the result is returned for
// persistence). Its job: locate each fact's LLM-provided `quote` in the
// buffered turn texts and build a `ProvenanceSource[]` with verified
// offsets. Never throws, never drops a fact (rule 34 spirit — an
// unverifiable span is a tagged state, not a silent failure).
//
// Reuses `collapseWhitespace` from `whitespace.ts` for normalization so there
// is exactly one normalizer in the codebase (issue #1575 pitfall: "do not
// write a second normalizer").
// ---------------------------------------------------------------------------

/**
 * A turn in the buffered conversation, reduced to the fields the provenance
 * validator needs. `ExtractionEngine.extract` maps its `BufferTurn[]` to this
 * shape so the validator is pure and testable without the full BufferTurn type.
 */
export interface ProvenanceTurnInput {
  content: string;
  sessionKey?: string;
  logicalSessionKey?: string;
  timestamp: string;
  turnId?: string;
}

/**
 * Result of building provenance for a single extracted fact.
 */
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

/**
 * Cap a quote string at `maxChars`, truncating at the last word boundary that
 * fits and appending an ellipsis marker. Quotes at or under the cap pass
 * through unchanged. Operates on Unicode code points (not UTF-16 units) so
 * emoji and astral-plane characters are not split mid-glyph.
 */
function capQuote(quote: string, maxChars: number): string {
  const glyphs = Array.from(quote);
  if (glyphs.length <= maxChars) return quote;
  // Walk backward from the cap to find a word boundary (space). If the entire
  // span is one long token (no spaces), cut at the cap — a hard cut is better
  // than no quote at all.
  let cut = maxChars;
  while (cut > 0 && !/\s/.test(glyphs[cut - 1]!)) cut--;
  if (cut === 0) cut = maxChars; // no word boundary found
  return glyphs.slice(0, cut).join("").trimEnd() + "\u2026";
}

/**
 * Casefold a string for normalized matching. Uses `toLowerCase` (not
 * `toLocaleLowerCase`) for determinism across runtime locales — the existing
 * `normalizeFactKey` helper in extraction.ts follows the same convention.
 */
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
  // 1. Exact substring match (handles unicode, curly quotes, emoji verbatim).
  const exactIdx = text.indexOf(quote);
  if (exactIdx >= 0) {
    return { matched: true, offsets: { charStart: exactIdx, charEnd: exactIdx + quote.length } };
  }

  // 2. Whitespace/case-normalized match. Collapse runs of whitespace and
  //    casefold both sides, then find the normalized quote in the normalized
  //    text. Recover original offsets by scanning forward from the normalized
  //    match start through the original text, accumulating non-whitespace
  //    glyphs until we've consumed the normalized quote length.
  const normQuote = collapseWhitespace(casefold(quote));
  if (normQuote.length === 0) return { matched: false };
  const normText = collapseWhitespace(casefold(text));
  const normIdx = normText.indexOf(normQuote);
  if (normIdx < 0) return { matched: false };

  // Recover original offsets: walk the original text, skipping leading
  // whitespace to align with the collapsed form, then track how many
  // normalized chars we've consumed.
  const normQuoteLen = normQuote.length;
  let origIdx = 0;
  // Skip leading whitespace in original text (collapseWhitespace trims both ends).
  while (origIdx < text.length && /\s/.test(text[origIdx]!)) origIdx++;
  // Walk through original text, counting normalized chars consumed.
  // Each non-whitespace char in original = 1 normalized char.
  // Whitespace runs in original = 1 space in normalized (but only between non-ws).
  let normPos = 0;
  let origStart = -1;
  let origEnd = -1;
  let prevWasWs = true; // suppress the leading space in collapsed form
  while (origIdx < text.length && origEnd < 0) {
    const ch = text[origIdx]!;
    if (/\s/.test(ch)) {
      if (!prevWasWs) {
        // This whitespace run collapses to a single space in normalized text.
        if (normPos === normIdx) origStart = origIdx; // normalized space aligns
        normPos++;
        prevWasWs = true;
      }
      origIdx++;
      continue;
    }
    // Non-whitespace char.
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
  // Normalized substring was found, but original offsets are not recoverable
  // (edge case in the normalized mapping). The match still counts as verified
  // — record a source without offsets rather than dropping the turn entirely
  // (cursor thread Ocver). charStart/charEnd are best-effort debugging aids,
  // not a precondition for a verified source.
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
  // requireSpans (chatgpt-codex-connector thread dEsu + cursor thread dGKJ):
  // every early exit that drops a fact's span (no quote, empty after label
  // strip, or unsafe quote) must flag requireSpansPending when the operator
  // opted into requireSpans, so the persist path routes the fact to
  // pending_review instead of active. Only the disabled-feature exit (above)
  // and the unexpected-error catch (below) omit the flag — those are
  // policy-neutral degradations, not a missing-span decision.
  const noneResult = (): ProvenanceBuildResult =>
    config.requireSpans === true
      ? { provenance: "none", requireSpansPending: true }
      : { provenance: "none" };
  if (rawQuote.length === 0) return noneResult();
  // Strip a leading prompt role label so a faithful quote verifies against
  // the raw turn content (cursor thread Oc3Z2). Prefer the RAW quote when it
  // matches at least one turn — an utterance that literally begins with
  // [user]/[assistant] must verify as-is, not be truncated to the post-label
  // text (cursor/codex thread dEsw). The strip handles the common case where
  // the LLM includes the prompt label; this preserves the rare case where the
  // utterance itself starts with that text.
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
  // Sanitize the quote before persisting it as a provenance span
  // (chatgpt-codex-connector thread dANZ): the fact body is sanitized via
  // sanitizeMemoryContent, but sources[].quote was persisted verbatim,
  // reintroducing unsafe memory text (e.g. "ignore previous instructions")
  // through the provenance field exposed to memory_get/x-ray/faithfulness.
  // An unsafe quote cannot serve as evidence — drop the source entirely
  // (consistent with how the body is sanitized: unsafe text is redacted,
  // and a redacted quote is useless as a verbatim span).
  if (!isSafeMemoryContent(quote)) return noneResult();

  try {
    // Search every turn for the quote. Collect verified sources.
    const sources: ProvenanceSource[] = [];
    // Track the first turn where the quote was located even when its
    // timestamp can't be coerced (cursor thread 4Pj — "Bad timestamp drops
    // matched source"). Without this, a located-but-unverifiable quote falls
    // through to the unverified branch and is attributed to the *last* turn's
    // session, mislabeling the source's origin session. Also drives the
    // requireSpans signal: only a quote that was NOT located in any turn
    // qualifies for pending_review routing under requireSpans (thread 4xB).
    let locatedTurn: ProvenanceTurnInput | undefined;
    for (const turn of turns) {
      if (!turn || typeof turn.content !== "string" || turn.content.length === 0) continue;
      const located = locateQuoteOffsets(quote, turn.content);
      // cursor thread Ocver: a normalized match counts as verified even when
      // original offsets are unrecoverable — record the source without
      // charStart/charEnd instead of skipping the turn.
      if (!located.matched) continue;
      if (!locatedTurn) locatedTurn = turn;
      // cursor thread Ocveu: normalize the turn timestamp to strict ISO so
      // the write-path ProvenanceSourceSchema keeps the source. Skip the turn
      // when the timestamp can't be coerced — pushing it would guarantee a
      // serialization drop (and the tag downgrade) for this source.
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

    // Quote provided but could not be turned into a verified source.
    // Determine the session to attribute: prefer the turn where the quote was
    // LOCATED even if its timestamp couldn't be coerced (cursor thread 4Pj — a
    // located quote must not be tied to the *last* turn's session). If the
    // quote was not located in any turn at all, fall back to the last turn's
    // session (the documented unverified behavior: the LLM vouched for the
    // excerpt but we couldn't pin it to a character offset). Normalize the
    // timestamp (thread Ocveu); fall back to epoch when no turn supplies a
    // coercible timestamp so the unverified source still survives the
    // write-path schema.
    const fallbackTurn = locatedTurn ?? turns[turns.length - 1];
    const fallbackSessionKey = fallbackTurn
      ? (fallbackTurn.sessionKey ?? fallbackTurn.logicalSessionKey ?? "unknown")
      : "unknown";
    const fallbackObservedAt = fallbackTurn
      ? (toStrictIsoTimestamp(fallbackTurn.timestamp) ?? new Date(0).toISOString())
      : new Date(0).toISOString();
    // requireSpans signal (chatgpt-codex-connector thread 4xB): when an
    // operator opts into provenance.requireSpans, a fact whose quote could
    // not be located in ANY turn (locatedTurn undefined) is flagged so the
    // persist path routes it to pending_review instead of active. A quote
    // that WAS located (locatedTurn set) satisfies requireSpans even when
    // its source was dropped for an un-coercible timestamp — the span was
    // found, so the fact has the grounding requireSpans demands.
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
    // Never crash extraction on a provenance error (rule 13/18).
    return { provenance: "none" };
  }
}
