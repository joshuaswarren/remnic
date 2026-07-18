/**
 * Sealed memory-write envelope (issue #1989, umbrella #1988).
 *
 * THE single stamping point for cross-cutting memory-creation fields.
 *
 * Why this exists: PR #1852 needed 27 rework commits because adding one
 * cross-cutting field (`sourceConnector`) required hand-editing every
 * write call site and every idempotency payload, and reviewers discovered
 * missed sites one round at a time. This module removes the fan-out:
 *
 *   1. `composeMemoryEnvelope()` is the only way to mint a
 *      `SealedMemoryEnvelope` — the brand is a non-exported `unique symbol`,
 *      so a hand-built object literal fails `tsc` (`npm run check-types`
 *      is already a required repo-wide gate; the type system IS the fence).
 *   2. `buildWriteIdempotencyPayload()` derives every access-surface
 *      idempotency payload from ONE ordered field registry
 *      (`WRITE_FINGERPRINT_FIELDS`). Adding a fingerprint-relevant field is
 *      a one-line registry change picked up by every surface; forgetting to
 *      classify a new `MemoryWriteInput` field is a compile error (see the
 *      exhaustiveness guards at the bottom of this file).
 *
 * PR1 scope (no call-site changes): the composer, the registry, and the
 * payload builder, fully tested. PR2–PR4 migrate storage entry points and
 * the write call sites onto this module (see #1989 for the slicing).
 */

import type { MemoryCategory } from "./types.js";
import { normalizeTags } from "./recall-tag-filter.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
import { assemblePersistedBody } from "./structured-attributes.js";

// ---------------------------------------------------------------------------
// Input surface
// ---------------------------------------------------------------------------

/**
 * Every cross-cutting memory-creation field lives HERE and only here.
 *
 * When you add a field you MUST also add it to either
 * `WRITE_FINGERPRINT_FIELDS` or `FINGERPRINT_EXEMPT_FIELDS` — the
 * exhaustiveness guard below makes forgetting a compile error.
 */
export interface MemoryWriteInput {
  /** Raw memory content. Must be non-empty after trimming. */
  content: string;
  /** Memory category — validated against the canonical category set. */
  category: MemoryCategory;
  /** Free-form labels; normalized (trim/dedupe) and capped, see TAG_LIMITS. */
  tags?: string[];
  /** String→string structured attributes; non-string values are rejected. */
  structuredAttributes?: Record<string, string>;
  /** Entity file reference (e.g. `person-jane-doe`). */
  entityRef?: string;
  /** Extraction confidence in [0, 1]. */
  confidence?: number;
  /** Opaque TTL expression (e.g. `90d` or an ISO date) — validated non-empty. */
  ttl?: string;
  /** Event-time validity start (ISO 8601). */
  validAt?: string;
  /** Connector identity that produced this write (issue #1852). */
  sourceConnector?: string;
  /** Human-readable provenance note. */
  sourceReason?: string;
}

/** Context supplied by the write path, not by the payload author. */
export interface WriteContext {
  /** Frontmatter `source` string (e.g. `extraction`, `wearable:bee`). */
  source: string;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Scope facts that participate in idempotency but never in frontmatter. */
export interface FingerprintScope {
  /** Access surface performing the write (e.g. `memory_store`, `observe`). */
  surface: string;
  namespace?: string;
  principal?: string;
  codingContext?: string;
}

// ---------------------------------------------------------------------------
// Normalization limits (single source of truth — docs/tags.md contract)
// ---------------------------------------------------------------------------

export const TAG_LIMITS = Object.freeze({
  /** Maximum number of tags persisted per memory. */
  maxTags: 50,
  /** Maximum length of a single tag. */
  maxTagLength: 256,
});

export const STRUCTURED_ATTRIBUTE_LIMITS = Object.freeze({
  /** Maximum number of structured attributes per memory. */
  maxEntries: 64,
  /** Maximum length of one attribute key. */
  maxKeyLength: 128,
  /** Maximum length of one attribute value. */
  maxValueLength: 1024,
});

const MEMORY_CATEGORY_TABLE: Record<MemoryCategory, true> = {
  fact: true,
  preference: true,
  correction: true,
  entity: true,
  decision: true,
  relationship: true,
  principle: true,
  commitment: true,
  moment: true,
  skill: true,
  rule: true,
  procedure: true,
  reasoning_trace: true,
};

const MEMORY_CATEGORY_NAMES = Object.keys(MEMORY_CATEGORY_TABLE).sort();

function isMemoryCategory(value: string): value is MemoryCategory {
  return Object.prototype.hasOwnProperty.call(MEMORY_CATEGORY_TABLE, value);
}

// ---------------------------------------------------------------------------
// Sealed envelope
// ---------------------------------------------------------------------------

declare const sealed: unique symbol;

/**
 * A normalized, validated memory-write envelope.
 *
 * Opaque: only `composeMemoryEnvelope()` can mint one. Storage creation
 * entry points accept this type (PR2), so every write path is forced
 * through the composer at compile time.
 */
export interface SealedMemoryEnvelope {
  readonly [sealed]: true;
  /**
   * Caller-supplied content VERBATIM (validated non-empty-after-trim).
   * `StorageManager.writeMemory` persists content byte-for-byte (callers
   * that trim, e.g. explicit capture, do so before composing), so the
   * envelope must not transform it — the earlier compose-time trim/sanitize
   * broke byte-parity with extraction writes and was removed in PR2.
   */
  readonly content: string;
  /**
   * The exact body persistence will write: attribute-suffix enrichment then
   * combined sanitization, produced by the SAME `assemblePersistedBody`
   * helper `writeMemory` uses (issue #1989 PR2; AGENTS.md §13). This is the
   * form write-idempotency fingerprints hash.
   */
  readonly persistedBody: string;
  /** Injection patterns matched during body assembly (empty = clean). */
  readonly sanitizeViolations: readonly string[];
  /**
   * Salvage-mode hygiene notes (empty in strict mode): each dropped/clamped
   * invalid optional field is recorded here — visible, never silent
   * (repo rule 34). Callers persisting machine-generated input log these.
   */
  readonly salvageNotes: readonly string[];
  readonly category: MemoryCategory;
  readonly tags: readonly string[];
  /**
   * CANONICAL attributes (keys trim+lowercase, values trim) — the form
   * fingerprints and downstream consumers use; stable across caller casing.
   */
  readonly structuredAttributes: Readonly<Record<string, string>> | undefined;
  /**
   * The validated ORIGINAL attribute map, byte-preserved. `writeMemory`
   * persists frontmatter attributes raw (canonicalizing only the body
   * suffix via normalizeAttributePairs) — a pre-existing raw/canonical
   * inconsistency (supersession keys read the raw form). The sealed path
   * preserves those bytes; canonicalizing the frontmatter at the storage
   * boundary is a follow-up once the legacy path retires (#1989 PR4).
   */
  readonly rawStructuredAttributes: Readonly<Record<string, string>> | undefined;
  readonly entityRef: string | undefined;
  readonly confidence: number | undefined;
  readonly ttl: string | undefined;
  readonly validAt: string | undefined;
  readonly sourceConnector: string | undefined;
  readonly sourceReason: string | undefined;
  readonly source: string;
  /** ISO timestamp the envelope was composed (from ctx.now). */
  readonly composedAt: string;
}

function fail(field: string, message: string): never {
  throw new Error(`composeMemoryEnvelope: ${field} ${message}`);
}

/**
 * Compose-time input hygiene mode (issue #1989 PR2, review round on #2014).
 *
 * - `strict` (default): every invalid field throws — correct for OPERATOR
 *   and API input (explicit capture, memory_store), where a bad value is a
 *   caller bug that must surface.
 * - `salvage`: for MACHINE-GENERATED input (LLM extraction, wearable
 *   ingestion). One malformed fact from an extractor must not abort a whole
 *   persistence batch that legacy `writeMemory` would have accepted.
 *   Invalid tags/attributes/optional fields are DROPPED with a note pushed
 *   to `envelope.salvageNotes` — visible, never silent (repo rule 34);
 *   callers log the notes. Content, category, ctx.source, and validAt stay
 *   FATAL in both modes (legacy writeMemory also throws on bad validAt, and
 *   a write without valid content/category cannot proceed).
 */
export interface ComposeEnvelopeOptions {
  salvage?: boolean;
}

/** Internal reporter: throws in strict mode, records a note in salvage. */
interface Hygiene {
  salvage: boolean;
  notes: string[];
  flag(field: string, message: string): void;
}

function makeHygiene(salvage: boolean): Hygiene {
  const notes: string[] = [];
  return {
    salvage,
    notes,
    flag(field: string, message: string): void {
      if (!salvage) fail(field, message);
      notes.push(`${field} ${message}`);
    },
  };
}

/**
 * Validate and CANONICALIZE `validAt` via the repo's shared flexible ISO
 * parser (`utils/iso-timestamp.ts`) — the same family durable writes use, so
 * the envelope can never accept a value storage would reject or reinterpret
 * (review findings on #1998: no second validation convention; reduced
 * precision like `2026-07-17T09:30Z` is valid; offsets are bounded ±14:00;
 * `Date.parse` alone is not an ISO validator).
 *
 * Canonical form is the epoch round-trip (`Date.toISOString()`), so
 * fingerprints are identical for `...T09:30Z`, `...T09:30:00.000Z`, and the
 * same instant expressed with an offset (§13 hash-consistency).
 */
function validateIsoTimestamp(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(field, "must be a non-empty ISO 8601 timestamp");
  const epochMs = parseFlexibleIsoTimestamp(trimmed);
  if (epochMs === null) {
    fail(
      field,
      `is not a valid ISO 8601 date/timestamp: ${JSON.stringify(value)} (date-only, reduced precision, Z, and ±HH:MM offsets up to ±14:00 are accepted; calendar overflow is not)`,
    );
  }
  return new Date(epochMs).toISOString();
}

function normalizeEnvelopeTags(raw: string[] | undefined, hygiene: Hygiene): readonly string[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    hygiene.flag("tags", "must be an array of strings — dropped");
    return Object.freeze([]);
  }
  const usable: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== "string") {
      hygiene.flag("tags", `entries must be strings (got ${typeof tag})`);
      continue;
    }
    if (tag.trim().length > TAG_LIMITS.maxTagLength) {
      hygiene.flag("tags", `entry exceeds ${TAG_LIMITS.maxTagLength} characters: ${JSON.stringify(tag.slice(0, 40))}…`);
      continue;
    }
    usable.push(tag);
  }
  let normalized = normalizeTags(usable) ?? [];
  if (normalized.length > TAG_LIMITS.maxTags) {
    hygiene.flag("tags", `exceed the ${TAG_LIMITS.maxTags}-tag limit (got ${normalized.length}) — keeping the first ${TAG_LIMITS.maxTags}`);
    normalized = normalized.slice(0, TAG_LIMITS.maxTags);
  }
  return Object.freeze(normalized);
}

function normalizeStructuredAttributes(
  raw: Record<string, string> | undefined,
  hygiene: Hygiene,
): { canonical: Readonly<Record<string, string>>; raw: Readonly<Record<string, string>> } | undefined {
  if (raw === undefined) return undefined;
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
  ) {
    // Map/Date/class instances have empty Object.entries() and would
    // silently normalize to "no attributes" (review finding on #1998
    // round 5) — never a plain pass-through.
    hygiene.flag("structuredAttributes", "must be a plain object of string values (Map, Date, and class instances are rejected) — dropped");
    return undefined;
  }
  let entries = Object.entries(raw);
  if (entries.length === 0) return undefined;
  if (entries.length > STRUCTURED_ATTRIBUTE_LIMITS.maxEntries) {
    hygiene.flag(
      "structuredAttributes",
      `exceed the ${STRUCTURED_ATTRIBUTE_LIMITS.maxEntries}-entry limit (got ${entries.length}) — keeping the first ${STRUCTURED_ATTRIBUTE_LIMITS.maxEntries} in insertion order`,
    );
    entries = entries.slice(0, STRUCTURED_ATTRIBUTE_LIMITS.maxEntries);
  }
  // Keys that collide with Object.prototype machinery are REJECTED outright:
  // `hashAccessIdempotencyPayload`'s stableStringify rebuilds objects with
  // plain assignment, where a "__proto__" own property silently vanishes —
  // so such a key can never round-trip through the fingerprint faithfully
  // (review finding on #1998 round 3). Rejection beats smuggling (§1/§39).
  const FORBIDDEN_ATTRIBUTE_KEYS = ["__proto__", "constructor", "prototype"];
  const out: Record<string, string> = Object.create(null);
  const survivingOriginal: Array<[string, string]> = [];
  for (const [key, value] of entries) {
    // Canonicalize exactly like storage's normalizeAttributePairs
    // (storage.ts:1277): keys trim+lowercase, values trim — so the
    // fingerprint and the persisted searchable form can never diverge
    // (review finding on #1998; AGENTS.md §13 hash-consistency).
    const cleanKey = key.trim().toLowerCase();
    if (cleanKey.length === 0) {
      hygiene.flag("structuredAttributes", "contain an empty key");
      continue;
    }
    if (cleanKey.length > STRUCTURED_ATTRIBUTE_LIMITS.maxKeyLength) {
      hygiene.flag("structuredAttributes", `key exceeds ${STRUCTURED_ATTRIBUTE_LIMITS.maxKeyLength} characters: ${JSON.stringify(cleanKey.slice(0, 40))}…`);
      continue;
    }
    if (typeof value !== "string") {
      hygiene.flag("structuredAttributes", `value for ${JSON.stringify(cleanKey)} must be a string (got ${typeof value}) — stringify numbers/booleans at the call site`);
      continue;
    }
    const cleanValue = value.trim();
    if (FORBIDDEN_ATTRIBUTE_KEYS.includes(cleanKey)) {
      hygiene.flag(
        "structuredAttributes",
        `contain the reserved key ${JSON.stringify(cleanKey)} — prototype-machinery names cannot round-trip through fingerprint serialization`,
      );
      continue;
    }
    if (cleanValue.length > STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength) {
      hygiene.flag("structuredAttributes", `value for ${JSON.stringify(cleanKey)} exceeds ${STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength} characters`);
      continue;
    }
    if (Object.hasOwn(out, cleanKey)) {
      hygiene.flag("structuredAttributes", `contain duplicate key after canonicalization (trim + lowercase): ${JSON.stringify(cleanKey)}`);
      continue;
    }
    out[cleanKey] = cleanValue;
    survivingOriginal.push([key, value]);
  }
  if (Object.keys(out).length === 0) return undefined;
  // Copy onto a normal object so downstream JSON/stableStringify behavior is
  // unchanged; keys are already validated. The RAW map carries only the
  // SURVIVING original pairs — dropped entries must not reach frontmatter.
  return {
    canonical: Object.freeze({ ...out }),
    raw: Object.freeze(Object.fromEntries(survivingOriginal)),
  };
}

function normalizeOptionalString(
  field: string,
  value: string | undefined,
  hygiene: Hygiene,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    hygiene.flag(field, `must be a string (got ${typeof value}) — dropped`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    hygiene.flag(field, "must be non-empty when provided — dropped");
    return undefined;
  }
  return trimmed;
}

/**
 * Compose (normalize + validate + seal) a memory-write envelope.
 *
 * Strict mode (default) throws on any invalid input — never silently
 * defaults (AGENTS.md §1/§39). Salvage mode (`{ salvage: true }`, for
 * machine-generated input like LLM extraction) drops invalid OPTIONAL
 * fields with notes on `envelope.salvageNotes` instead of aborting the
 * batch; content/category/source/validAt stay fatal in both modes.
 */
export function composeMemoryEnvelope(
  input: MemoryWriteInput,
  ctx: WriteContext,
  opts: ComposeEnvelopeOptions = {},
): SealedMemoryEnvelope {
  if (input === null || typeof input !== "object") fail("input", "must be an object");
  if (ctx === null || typeof ctx !== "object") fail("ctx", "must be an object");
  const hygiene = makeHygiene(opts.salvage === true);

  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    fail("content", "must be a non-empty string");
  }
  if (typeof input.category !== "string" || !isMemoryCategory(input.category)) {
    fail(
      "category",
      `must be one of: ${MEMORY_CATEGORY_NAMES.join(", ")} (got ${JSON.stringify(input.category)})`,
    );
  }
  if (typeof ctx.source !== "string" || ctx.source.trim().length === 0) {
    fail("ctx.source", "must be a non-empty string");
  }

  let confidence: number | undefined;
  if (input.confidence !== undefined) {
    if (
      typeof input.confidence !== "number" ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      hygiene.flag(
        "confidence",
        `must be a finite number within [0, 1] (got ${String(input.confidence)}) — dropped (storage defaults apply)`,
      );
    } else {
      confidence = input.confidence;
    }
  }

  // validAt stays FATAL in salvage too: legacy writeMemory throws on an
  // invalid validAt (normalizeMemoryWriteTimestamp), so salvage-dropping it
  // would CHANGE behavior rather than preserve it.
  const validAt =
    input.validAt === undefined ? undefined : validateIsoTimestamp("validAt", input.validAt);

  const now = ctx.now ? ctx.now() : new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("ctx.now", "must return a valid Date");
  }

  const attributes = normalizeStructuredAttributes(input.structuredAttributes, hygiene);
  // Assemble the EXACT persisted form (attribute suffix + combined sanitize)
  // with the same helper writeMemory uses — fingerprints hash this form, so
  // envelope and storage cannot diverge (§13; #1998 round-8 thread resolved
  // here in PR2 as promised). writeMemory assembles from the RAW map;
  // normalizeAttributePairs canonicalizes internally, so raw and canonical
  // maps yield the same suffix — asserted by the parity suite.
  const assembled = assemblePersistedBody(
    input.content,
    attributes ? { ...attributes.raw } : undefined,
  );
  if (assembled.text.trim().length === 0) {
    fail("content", "is empty after sanitization");
  }

  const body = {
    content: input.content,
    persistedBody: assembled.text,
    sanitizeViolations: Object.freeze([...assembled.violations]),
    category: input.category,
    tags: normalizeEnvelopeTags(input.tags, hygiene),
    structuredAttributes: attributes?.canonical,
    rawStructuredAttributes: attributes?.raw,
    entityRef: normalizeOptionalString("entityRef", input.entityRef, hygiene),
    confidence,
    ttl: normalizeOptionalString("ttl", input.ttl, hygiene),
    validAt,
    sourceConnector: normalizeOptionalString("sourceConnector", input.sourceConnector, hygiene),
    sourceReason: normalizeOptionalString("sourceReason", input.sourceReason, hygiene),
    source: ctx.source.trim(),
    composedAt: now.toISOString(),
    salvageNotes: Object.freeze([...hygiene.notes]),
  };
  const envelope = Object.freeze(body) as unknown as SealedMemoryEnvelope;
  SEALED_ENVELOPES.add(envelope);
  return envelope;
}

// The runtime seal registry. The declared `sealed` unique symbol exists only
// at the type level (compile-time fence); this WeakSet is the runtime fence.
const SEALED_ENVELOPES = new WeakSet<object>();

/**
 * Runtime check (belt) — the compile-time brand is the real fence.
 *
 * Fast path: WeakSet membership (same module graph). Fallback: RE-COMPOSITION
 * EQUIVALENCE — Node resolves `@remnic/core` through `dist/` for built
 * consumers and `src/` for tsx-loaded tests, and each graph gets its OWN
 * WeakSet, so identity alone would reject genuinely-sealed envelopes that
 * crossed a build boundary. The structural arm re-runs the STRICT composer
 * on the candidate's own inputs and demands every envelope field reproduce
 * exactly (#2014 round 2: shape-only validation admitted lookalikes with 51
 * tags or out-of-range confidence, bypassing the sealed-input contract). A
 * value that survives has, by construction, passed every composer invariant.
 *
 * `salvageNotes` is deliberately NOT compared: a legitimately salvage-minted
 * envelope carries notes while the strict re-composition of its (already
 * clean) surviving fields yields none. Notes are advisory provenance, not
 * identity — every load-bearing field is still verified.
 */
export function isSealedMemoryEnvelope(value: unknown): value is SealedMemoryEnvelope {
  if (typeof value !== "object" || value === null) return false;
  if (SEALED_ENVELOPES.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  const v = value as Partial<SealedMemoryEnvelope>;
  if (
    typeof v.content !== "string" ||
    typeof v.persistedBody !== "string" ||
    typeof v.source !== "string" ||
    typeof v.composedAt !== "string" ||
    typeof v.category !== "string" ||
    !isMemoryCategory(v.category) ||
    !Array.isArray(v.tags) ||
    !Array.isArray(v.sanitizeViolations) ||
    !Array.isArray(v.salvageNotes)
  ) {
    return false;
  }
  const attrs = v.rawStructuredAttributes;
  if (attrs !== undefined && (attrs === null || typeof attrs !== "object" || Array.isArray(attrs))) {
    return false;
  }
  let rebuilt: SealedMemoryEnvelope;
  try {
    rebuilt = composeMemoryEnvelope(
      {
        content: v.content,
        category: v.category,
        ...(v.tags.length > 0 ? { tags: [...(v.tags as string[])] } : {}),
        ...(attrs !== undefined ? { structuredAttributes: { ...attrs } } : {}),
        ...(v.entityRef !== undefined ? { entityRef: v.entityRef } : {}),
        ...(v.confidence !== undefined ? { confidence: v.confidence } : {}),
        ...(v.ttl !== undefined ? { ttl: v.ttl } : {}),
        ...(v.validAt !== undefined ? { validAt: v.validAt } : {}),
        ...(v.sourceConnector !== undefined ? { sourceConnector: v.sourceConnector } : {}),
        ...(v.sourceReason !== undefined ? { sourceReason: v.sourceReason } : {}),
      },
      { source: v.source, now: () => new Date(v.composedAt as string) },
    );
  } catch {
    // Strict re-composition rejected an input — the candidate carries a
    // value the composer would never have minted.
    return false;
  }
  const sameArray = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((entry, i) => entry === b[i]);
  const sameMap = (
    a: Readonly<Record<string, string>> | undefined,
    b: Readonly<Record<string, string>> | undefined,
  ): boolean => {
    if (a === undefined || b === undefined) return a === b;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
  };
  return (
    rebuilt.content === v.content &&
    rebuilt.persistedBody === v.persistedBody &&
    rebuilt.category === v.category &&
    rebuilt.source === v.source &&
    rebuilt.composedAt === v.composedAt &&
    rebuilt.confidence === v.confidence &&
    rebuilt.entityRef === v.entityRef &&
    rebuilt.ttl === v.ttl &&
    rebuilt.validAt === v.validAt &&
    rebuilt.sourceConnector === v.sourceConnector &&
    rebuilt.sourceReason === v.sourceReason &&
    sameArray(rebuilt.tags, v.tags as string[]) &&
    sameArray(rebuilt.sanitizeViolations, v.sanitizeViolations as string[]) &&
    sameMap(rebuilt.structuredAttributes, v.structuredAttributes) &&
    sameMap(rebuilt.rawStructuredAttributes, attrs)
  );
}

/**
 * The ONE mapping from a sealed envelope (+ extras) to the legacy
 * `writeMemory(category, content, options)` argument shape. Used by
 * `StorageManager.writeSealedMemory` AND by test doubles that stub storage —
 * so mock fidelity (AGENTS.md §21) cannot drift from production.
 */
export function sealedWriteToLegacyArgs(
  envelope: SealedMemoryEnvelope,
  extras: Record<string, unknown> = {},
): { category: MemoryCategory; content: string; options: Record<string, unknown> } {
  return {
    category: envelope.category,
    content: envelope.content,
    options: {
      ...extras,
      confidence: envelope.confidence,
      tags: envelope.tags.length > 0 ? [...envelope.tags] : undefined,
      entityRef: envelope.entityRef,
      source: envelope.source,
      expiresAt: envelope.ttl,
      validAt: envelope.validAt,
      // RAW map for frontmatter byte-parity with the legacy path; the body
      // suffix canonicalizes identically from either form.
      structuredAttributes: envelope.rawStructuredAttributes
        ? { ...envelope.rawStructuredAttributes }
        : undefined,
      ...(envelope.sourceConnector !== undefined
        ? { sourceConnector: envelope.sourceConnector }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Idempotency field registry
// ---------------------------------------------------------------------------

/**
 * Ordered registry of envelope fields that participate in write-idempotency
 * fingerprints. Adding a fingerprint-relevant field = one entry here; every
 * surface that builds its payload via `buildWriteIdempotencyPayload()` picks
 * it up automatically.
 */
export const WRITE_FINGERPRINT_FIELDS = [
  "content",
  "category",
  "tags",
  "structuredAttributes",
  "entityRef",
  "ttl",
  "validAt",
  "sourceConnector",
] as const satisfies readonly (keyof MemoryWriteInput)[];

/**
 * Envelope fields deliberately EXCLUDED from fingerprints. Exempting a field
 * is a visible, reviewable decision — this list exists so the exhaustiveness
 * guard can force every new `MemoryWriteInput` field to be classified.
 */
export const FINGERPRINT_EXEMPT_FIELDS = [
  // Confidence is a scoring detail: two extractions of the same fact with
  // slightly different confidence are the same write for dedup purposes.
  "confidence",
  // Free-text provenance note; carries no identity.
  "sourceReason",
] as const satisfies readonly (keyof MemoryWriteInput)[];

/** Scope keys always folded into the fingerprint payload. */
export const FINGERPRINT_SCOPE_FIELDS = [
  "surface",
  "namespace",
  "principal",
  "codingContext",
] as const satisfies readonly (keyof FingerprintScope)[];

// --- compile-time exhaustiveness guards ------------------------------------
// A new MemoryWriteInput field that is in NEITHER list is a compile error;
// a registry entry that names a non-existent field is a compile error; a
// field in BOTH lists is a compile error.

type RegistryField = (typeof WRITE_FINGERPRINT_FIELDS)[number];
type ExemptField = (typeof FINGERPRINT_EXEMPT_FIELDS)[number];
type UnclassifiedField = Exclude<keyof MemoryWriteInput, RegistryField | ExemptField>;
type DoublyClassifiedField = RegistryField & ExemptField;

const assertEveryFieldClassified: UnclassifiedField extends never ? true : never = true;
const assertNoDoubleClassification: DoublyClassifiedField extends never ? true : never = true;
void assertEveryFieldClassified;
void assertNoDoubleClassification;

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Build the canonical write-idempotency payload for a sealed envelope.
 *
 * Determinism guarantees (AGENTS.md §26):
 *   - tags are SORTED in the payload (tag order never changes identity);
 *   - structured attributes are serialized key-sorted by the existing
 *     `stableStringify` inside `hashAccessIdempotencyPayload`;
 *   - the payload shape is versioned (`v: 1`) so a future field-semantics
 *     change can migrate stored idempotency state explicitly instead of
 *     silently colliding.
 *
 * Feed the result to `hashAccessIdempotencyPayload()` — this module does
 * not hash so surfaces keep a single hashing implementation.
 */
export function buildWriteIdempotencyPayload(
  envelope: SealedMemoryEnvelope,
  scope: FingerprintScope,
): Record<string, unknown> {
  if (!isSealedMemoryEnvelope(envelope)) {
    throw new Error(
      "buildWriteIdempotencyPayload: envelope must be minted by composeMemoryEnvelope",
    );
  }
  if (scope === null || typeof scope !== "object") {
    throw new Error("buildWriteIdempotencyPayload: scope must be an object");
  }
  if (typeof scope.surface !== "string" || scope.surface.trim().length === 0) {
    throw new Error("buildWriteIdempotencyPayload: scope.surface must be a non-empty string");
  }

  const fields: Record<string, unknown> = {};
  for (const field of WRITE_FINGERPRINT_FIELDS) {
    const value = envelope[field];
    if (value === undefined) continue;
    if (field === "tags") {
      const tags = value as readonly string[];
      if (tags.length === 0) continue;
      fields.tags = [...tags].sort();
      continue;
    }
    if (field === "content") {
      // Fingerprints hash the PERSISTED form (attribute suffix + combined
      // sanitize), not the raw input — one instant of stored state, one
      // fingerprint (§13; issue #1989 PR2).
      fields.content = envelope.persistedBody;
      continue;
    }
    fields[field] = value;
  }
  // The write source (extraction vs wearable:bee vs observe replay, ...) is
  // identity: the same content arriving from two different sources must not
  // dedupe into one write (review finding on #1998). Not a MemoryWriteInput
  // key, so it rides beside the registry fields explicitly.
  fields.source = envelope.source;

  const scopeOut: Record<string, string> = {};
  for (const key of FINGERPRINT_SCOPE_FIELDS) {
    const value = scope[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`buildWriteIdempotencyPayload: scope.${key} must be a string`);
    }
    // Trimmed: "ns" and "ns " must not mint distinct fingerprints (review
    // finding on #1998). Empty-after-trim optional scope values are dropped.
    const cleanValue = value.trim();
    if (key === "surface" || cleanValue.length > 0) {
      scopeOut[key] = cleanValue;
    }
  }

  return { v: 1, kind: "memory-write", fields, scope: scopeOut };
}
