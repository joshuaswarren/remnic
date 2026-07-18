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
  readonly content: string;
  readonly category: MemoryCategory;
  readonly tags: readonly string[];
  readonly structuredAttributes: Readonly<Record<string, string>> | undefined;
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

function normalizeEnvelopeTags(raw: string[] | undefined): readonly string[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) fail("tags", "must be an array of strings");
  for (const tag of raw) {
    if (typeof tag !== "string") {
      fail("tags", `entries must be strings (got ${typeof tag})`);
    }
    if (tag.trim().length > TAG_LIMITS.maxTagLength) {
      fail("tags", `entry exceeds ${TAG_LIMITS.maxTagLength} characters: ${JSON.stringify(tag.slice(0, 40))}…`);
    }
  }
  const normalized = normalizeTags(raw) ?? [];
  if (normalized.length > TAG_LIMITS.maxTags) {
    fail("tags", `exceed the ${TAG_LIMITS.maxTags}-tag limit (got ${normalized.length})`);
  }
  return Object.freeze(normalized);
}

function normalizeStructuredAttributes(
  raw: Record<string, string> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("structuredAttributes", "must be a plain object of string values");
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;
  if (entries.length > STRUCTURED_ATTRIBUTE_LIMITS.maxEntries) {
    fail(
      "structuredAttributes",
      `exceed the ${STRUCTURED_ATTRIBUTE_LIMITS.maxEntries}-entry limit (got ${entries.length})`,
    );
  }
  // Keys that collide with Object.prototype machinery are REJECTED outright:
  // `hashAccessIdempotencyPayload`'s stableStringify rebuilds objects with
  // plain assignment, where a "__proto__" own property silently vanishes —
  // so such a key can never round-trip through the fingerprint faithfully
  // (review finding on #1998 round 3). Rejection beats smuggling (§1/§39).
  const FORBIDDEN_ATTRIBUTE_KEYS = ["__proto__", "constructor", "prototype"];
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    // Canonicalize exactly like storage's normalizeAttributePairs
    // (storage.ts:1277): keys trim+lowercase, values trim — so the
    // fingerprint and the persisted searchable form can never diverge
    // (review finding on #1998; AGENTS.md §13 hash-consistency).
    const cleanKey = key.trim().toLowerCase();
    if (cleanKey.length === 0) fail("structuredAttributes", "contain an empty key");
    if (cleanKey.length > STRUCTURED_ATTRIBUTE_LIMITS.maxKeyLength) {
      fail("structuredAttributes", `key exceeds ${STRUCTURED_ATTRIBUTE_LIMITS.maxKeyLength} characters: ${JSON.stringify(cleanKey.slice(0, 40))}…`);
    }
    if (typeof value !== "string") {
      fail("structuredAttributes", `value for ${JSON.stringify(cleanKey)} must be a string (got ${typeof value}) — stringify numbers/booleans at the call site`);
    }
    const cleanValue = value.trim();
    if (FORBIDDEN_ATTRIBUTE_KEYS.includes(cleanKey)) {
      fail(
        "structuredAttributes",
        `contain the reserved key ${JSON.stringify(cleanKey)} — prototype-machinery names cannot round-trip through fingerprint serialization`,
      );
    }
    if (cleanValue.length > STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength) {
      fail("structuredAttributes", `value for ${JSON.stringify(cleanKey)} exceeds ${STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength} characters`);
    }
    if (Object.hasOwn(out, cleanKey)) {
      fail("structuredAttributes", `contain duplicate key after canonicalization (trim + lowercase): ${JSON.stringify(cleanKey)}`);
    }
    out[cleanKey] = cleanValue;
  }
  // Copy onto a normal object so downstream JSON/stableStringify behavior is
  // unchanged; keys are already validated.
  return Object.freeze({ ...out });
}

function normalizeOptionalString(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(field, `must be a string (got ${typeof value})`);
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(field, "must be non-empty when provided");
  return trimmed;
}

/**
 * Compose (normalize + validate + seal) a memory-write envelope.
 *
 * Throws on invalid input — never silently defaults (AGENTS.md §1/§39).
 */
export function composeMemoryEnvelope(
  input: MemoryWriteInput,
  ctx: WriteContext,
): SealedMemoryEnvelope {
  if (input === null || typeof input !== "object") fail("input", "must be an object");
  if (ctx === null || typeof ctx !== "object") fail("ctx", "must be an object");

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
    if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence)) {
      fail("confidence", "must be a finite number");
    }
    if (input.confidence < 0 || input.confidence > 1) {
      fail("confidence", `must be within [0, 1] (got ${input.confidence})`);
    }
    confidence = input.confidence;
  }

  const validAt =
    input.validAt === undefined ? undefined : validateIsoTimestamp("validAt", input.validAt);

  const now = ctx.now ? ctx.now() : new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("ctx.now", "must return a valid Date");
  }

  const envelope = Object.freeze({
    [sealedBrand]: true,
    // Trimmed: other write paths persist trimmed content (e.g. explicit
    // capture), so the sealed form and fingerprint must match what storage
    // will actually hold (review finding on #1998).
    content: input.content.trim(),
    category: input.category,
    tags: normalizeEnvelopeTags(input.tags),
    structuredAttributes: normalizeStructuredAttributes(input.structuredAttributes),
    entityRef: normalizeOptionalString("entityRef", input.entityRef),
    confidence,
    ttl: normalizeOptionalString("ttl", input.ttl),
    validAt,
    sourceConnector: normalizeOptionalString("sourceConnector", input.sourceConnector),
    sourceReason: normalizeOptionalString("sourceReason", input.sourceReason),
    source: ctx.source.trim(),
    composedAt: now.toISOString(),
  }) as unknown as SealedMemoryEnvelope;
  return envelope;
}

// The runtime carrier for the compile-time brand. The declared `sealed`
// unique symbol never exists at runtime; the single mint site above casts
// through `unknown`, which is safe precisely because no other module can
// name the brand. Runtime consumers can verify a value came through the
// composer with `isSealedMemoryEnvelope`.
const sealedBrand = Symbol("remnic.sealedMemoryEnvelope");

/** Runtime check (belt) — true only for composer-minted envelopes. */
export function isSealedMemoryEnvelope(value: unknown): value is SealedMemoryEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[sealedBrand] === true
  );
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
