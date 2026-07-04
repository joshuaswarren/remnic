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
  // Downgrade the provenance tag to "none" when sources were present but all
  // failed validation — a verified/unverified tag without evidence is
  // indistinguishable from a grounded fact downstream (review thread IPn).
  const tag = hasValidSources ? fm.provenance
    : fm.sources && fm.sources.length > 0 ? "none"
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
      .refine((s) => !Number.isNaN(Date.parse(s)), "must be a parseable ISO timestamp"),
    quote: z.string().min(1),
    turnId: z.string().min(1).optional(),
    charStart: z.number().finite().nonnegative().optional(),
    charEnd: z.number().finite().nonnegative().optional(),
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
