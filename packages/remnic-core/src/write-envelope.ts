
import { isMemorySubject } from "./memory-subject.js";
import type { MemoryCategory, MemorySubject } from "./types.js";
import { normalizeTags } from "./recall-tag-filter.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
import { assemblePersistedBody } from "./structured-attributes.js";

// ---------------------------------------------------------------------------

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
  /** Origin class stamped at creation time (issue #1955). */
  origin?: string;
  /** Whom the memory models (issue #2372): "user" or "agent". */
  subject?: MemorySubject;
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

/**
 * Canonical category spellings, sorted. Runtime counterpart of the
 * `MemoryCategory` union for error messages and cross-module consistency
 * checks (issue #2829).
 */
export const MEMORY_CATEGORY_NAMES = Object.keys(MEMORY_CATEGORY_TABLE).sort();

export function isMemoryCategory(value: string): value is MemoryCategory {
  return Object.prototype.hasOwnProperty.call(MEMORY_CATEGORY_TABLE, value);
}

// ---------------------------------------------------------------------------
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
  readonly rawStructuredAttributes: Readonly<Record<string, string>> | undefined;
  readonly entityRef: string | undefined;
  readonly confidence: number | undefined;
  readonly ttl: string | undefined;
  readonly validAt: string | undefined;
  readonly sourceConnector: string | undefined;
  readonly origin: string | undefined;
  readonly subject: MemorySubject | undefined;
  readonly sourceReason: string | undefined;
  readonly source: string;
  /** ISO timestamp the envelope was composed (from ctx.now). */
  readonly composedAt: string;
}

function fail(field: string, message: string): never {
  throw new Error(`composeMemoryEnvelope: ${field} ${message}`);
}

export interface ComposeEnvelopeOptions {
  salvage?: boolean;
}

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
  const FORBIDDEN_ATTRIBUTE_KEYS = ["__proto__", "constructor", "prototype"];
  const out: Record<string, string> = Object.create(null);
  const survivingOriginal: Array<[string, string]> = [];
  for (const [key, value] of entries) {
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

  let subject: MemorySubject | undefined;
  if (input.subject !== undefined) {
    if (!isMemorySubject(input.subject)) {
      hygiene.flag(
        "subject",
        `must be "user" or "agent" (got ${JSON.stringify(input.subject)}) — dropped`,
      );
    } else {
      subject = input.subject;
    }
  }

  const validAt =
    input.validAt === undefined ? undefined : validateIsoTimestamp("validAt", input.validAt);

  const now = ctx.now ? ctx.now() : new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("ctx.now", "must return a valid Date");
  }

  const attributes = normalizeStructuredAttributes(input.structuredAttributes, hygiene);
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
    origin: normalizeOptionalString("origin", input.origin, hygiene),
    subject,
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

const SEALED_ENVELOPES = new WeakSet<object>();

function hasOnlyFrozenDataProperties(value: object): boolean {
  if (!Object.isFrozen(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) return false;
  } else if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
      return false;
    }
  }
  return true;
}


export function isSealedMemoryEnvelope(value: unknown): value is SealedMemoryEnvelope {
  if (typeof value !== "object" || value === null) return false;
  if (SEALED_ENVELOPES.has(value)) return true;
  if (!hasOnlyFrozenDataProperties(value)) return false;
  const v = value as Partial<SealedMemoryEnvelope>;
  if (
    typeof v.content !== "string" ||
    typeof v.persistedBody !== "string" ||
    typeof v.source !== "string" ||
    typeof v.composedAt !== "string" ||
    typeof v.category !== "string" ||
    !isMemoryCategory(v.category) ||
    !Array.isArray(v.tags) ||
    !hasOnlyFrozenDataProperties(v.tags) ||
    !Array.isArray(v.sanitizeViolations) ||
    !hasOnlyFrozenDataProperties(v.sanitizeViolations) ||
    !Array.isArray(v.salvageNotes) ||
    !hasOnlyFrozenDataProperties(v.salvageNotes)
  ) {
    return false;
  }
  const attrs = v.rawStructuredAttributes;
  if (
    attrs !== undefined &&
    (attrs === null || typeof attrs !== "object" || Array.isArray(attrs) || !hasOnlyFrozenDataProperties(attrs))
  ) {
    return false;
  }
  const canonicalAttrs = v.structuredAttributes;
  if (
    canonicalAttrs !== undefined &&
    (canonicalAttrs === null ||
      typeof canonicalAttrs !== "object" ||
      Array.isArray(canonicalAttrs) ||
      !hasOnlyFrozenDataProperties(canonicalAttrs))
  ) {
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
        ...(v.origin !== undefined ? { origin: v.origin } : {}),
        ...(v.sourceReason !== undefined ? { sourceReason: v.sourceReason } : {}),
      },
      { source: v.source, now: () => new Date(v.composedAt as string) },
    );
  } catch {
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
    rebuilt.origin === v.origin &&
    rebuilt.sourceReason === v.sourceReason &&
    sameArray(rebuilt.tags, v.tags as string[]) &&
    sameArray(rebuilt.sanitizeViolations, v.sanitizeViolations as string[]) &&
    sameMap(rebuilt.structuredAttributes, v.structuredAttributes) &&
    sameMap(rebuilt.rawStructuredAttributes, attrs)
  );
}

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
      structuredAttributes: envelope.rawStructuredAttributes
        ? { ...envelope.rawStructuredAttributes }
        : undefined,
      origin: envelope.origin,
      sourceConnector: envelope.sourceConnector,
      subject: envelope.subject,
    },
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

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

export const FINGERPRINT_EXEMPT_FIELDS = [
  "confidence",
  "origin",
  "subject",
  "sourceReason",
] as const satisfies readonly (keyof MemoryWriteInput)[];

/** Scope keys always folded into the fingerprint payload. */
export const FINGERPRINT_SCOPE_FIELDS = [
  "surface",
  "namespace",
  "principal",
  "codingContext",
] as const satisfies readonly (keyof FingerprintScope)[];


type RegistryField = (typeof WRITE_FINGERPRINT_FIELDS)[number];
type ExemptField = (typeof FINGERPRINT_EXEMPT_FIELDS)[number];
type UnclassifiedField = Exclude<keyof MemoryWriteInput, RegistryField | ExemptField>;
type DoublyClassifiedField = RegistryField & ExemptField;

const assertEveryFieldClassified: UnclassifiedField extends never ? true : never = true;
const assertNoDoubleClassification: DoublyClassifiedField extends never ? true : never = true;
void assertEveryFieldClassified;
void assertNoDoubleClassification;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

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
      fields.content = envelope.persistedBody;
      continue;
    }
    fields[field] = value;
  }
  fields.source = envelope.source;

  const scopeOut: Record<string, string> = {};
  for (const key of FINGERPRINT_SCOPE_FIELDS) {
    const value = scope[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`buildWriteIdempotencyPayload: scope.${key} must be a string`);
    }
    const cleanValue = value.trim();
    if (key === "surface" || cleanValue.length > 0) {
      scopeOut[key] = cleanValue;
    }
  }

  return { v: 1, kind: "memory-write", fields, scope: scopeOut };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//
//

/** The raw request fields the write surfaces fingerprint (legacy shape). */
export interface AccessWriteFingerprintParts {
  schemaVersion: number;
  namespace: string;
  content: string;
  category?: string;
  confidence?: number;
  tags?: string[];
  entityRef?: string;
  ttl?: string;
  sourceReason?: string;
  sourceConnector?: string;
}

type AccessSurfaceUnrepresentable = "structuredAttributes" | "validAt";
type UncoveredAccessFingerprintField = Exclude<
  Extract<RegistryField, keyof MemoryWriteInput>,
  keyof AccessWriteFingerprintParts | AccessSurfaceUnrepresentable
>;
const assertAccessFingerprintCoversRegistry: UncoveredAccessFingerprintField extends never
  ? true
  : never = true;
void assertAccessFingerprintCoversRegistry;

export function buildAccessWriteRequestFingerprint(
  parts: AccessWriteFingerprintParts,
): Record<string, unknown> {
  return {
    schemaVersion: parts.schemaVersion,
    content: parts.content,
    category: parts.category,
    confidence: parts.confidence,
    namespace: parts.namespace,
    tags: parts.tags,
    entityRef: parts.entityRef,
    ttl: parts.ttl,
    sourceReason: parts.sourceReason,
    sourceConnector: parts.sourceConnector,
  };
}

/** The raw request fields the observe surface fingerprints (legacy shape). */
export interface ObserveFingerprintParts {
  sessionKey: string;
  messages: unknown;
  namespace?: string;
  skipExtraction?: boolean;
  authenticatedPrincipal?: string;
  cwd?: string;
  projectTag?: string;
  /** Resolved coding context — `null` (not undefined) when absent, matching the historical literal. */
  effectiveCodingContext: unknown;
  sourceConnector?: string;
}

/**
 * Fingerprint payload for `observe` — turn ingestion, not a memory write,
 * so it fingerprints session/message identity rather than MemoryWriteInput
 * fields. Shape reproduces the historical inline literal exactly.
 */
export function buildObserveRequestFingerprint(
  parts: ObserveFingerprintParts,
): Record<string, unknown> {
  return {
    sessionKey: parts.sessionKey,
    messages: parts.messages,
    namespace: parts.namespace,
    skipExtraction: parts.skipExtraction,
    authenticatedPrincipal: parts.authenticatedPrincipal,
    cwd: parts.cwd,
    projectTag: parts.projectTag,
    effectiveCodingContext: parts.effectiveCodingContext,
    sourceConnector: parts.sourceConnector,
  };
}
