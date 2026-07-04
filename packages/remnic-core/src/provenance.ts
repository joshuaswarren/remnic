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
import type { MemoryFrontmatter, ProvenanceConfig, ProvenanceSource } from "./types.js";

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
  return (
    d.getUTCFullYear() === y &&
    d.getUTCMonth() === mo - 1 &&
    d.getUTCDate() === da &&
    d.getUTCHours() === h &&
    d.getUTCMinutes() === mi &&
    d.getUTCSeconds() === se
  );
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
