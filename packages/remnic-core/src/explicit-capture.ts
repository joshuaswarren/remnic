import { composeMemoryEnvelope, TAG_LIMITS } from "./write-envelope.js";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { createHash, randomUUID } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";
import { log } from "./logger.js";
import { isSafeRouteNamespace } from "./routing/engine.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import { normalizeExplicitCaptureContent } from "./storage/tombstone-blocked-capture-index.js";
import type { CaptureMode, MemoryCategory, MemoryLifecycleEvent, PluginConfig } from "./types.js";
import type { StorageManager } from "./storage.js";

export type ExplicitCaptureInput = {
  content: string;
  category?: string;
  confidence?: number;
  namespace?: string;
  tags?: string[];
  entityRef?: string;
  sourceConnector?: string;
  ttl?: string;
  sourceReason?: string;
};

export type ValidExplicitCapture = {
  content: string;
  category: MemoryCategory;
  confidence: number;
  namespace?: string;
  tags: string[];
  entityRef?: string;
  sourceConnector?: string;
  expiresAt?: string;
  sourceReason?: string;
  /**
   * When true, `namespace` was already resolved AND authorized by the caller
   * (the access service's `resolveCodingScopedWriteNamespace`, which auth-checks
   * the base and derives a session-owned `project-*` overlay). The persist /
   * queue layer then routes to it directly instead of re-validating against the
   * static policy allow-list — which would otherwise reject legitimately-derived
   * dynamic project namespaces (#1434). Callers that do NOT pre-authorize the
   * namespace must leave this unset so the allow-list guard still applies.
   */
  namespacePreResolved?: boolean;
};

export type ExplicitCaptureSource = "memory_store" | "memory_capture" | "suggestion_submit" | "inline";
type ExplicitCaptureValidationMode = "legacy_tool" | "strict_explicit";

// Bounded body {0,100000} instead of an unbounded lazy *? so scanning for the
// closing tag cannot backtrack polynomially on unterminated <memory_note>
// markup in hostile turn text (CodeQL js/polynomial-redos). 100 000 chars far
// exceeds any real inline note, so matching is behavior-preserving; the outer
// \s* groups were also dropped (body absorbs whitespace; captures are trimmed).
const INLINE_NOTE_RE = /<memory_note>([\s\S]{0,100000}?)<\/memory_note>/gi;
const INLINE_NOTE_MARKUP_RE = /<memory_note>[\s\S]{0,100000}?<\/memory_note>/i;
const INLINE_ALLOWED_CATEGORIES = new Set<MemoryCategory>([
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
  "procedure",
  "reasoning_trace",
]);

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*[^\s]{8,}\b/i,
  /\b(?:authorization)\s*:\s*[^\s]{8,}\b/i,
];
const SECRET_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replacement: "[redacted openai key]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted aws key]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, replacement: "Bearer [redacted token]" },
  {
    pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*[^\s]{8,}\b/gi,
    replacement: "[redacted credential]",
  },
  {
    pattern: /\b(?:authorization)\s*:\s*[^\s]{8,}\b/gi,
    replacement: "authorization: [redacted credential]",
  },
];
const EXPLICIT_CAPTURE_REVIEW_TAGS = ["explicit-capture", "queued-review"];

function explicitCaptureActor(source: ExplicitCaptureSource): string {
  switch (source) {
    case "inline":
      return "inline.memory_note";
    case "memory_store":
      return "tool.memory_store";
    case "suggestion_submit":
      return "tool.suggestion_submit";
    default:
      return "tool.memory_capture";
  }
}

function asTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function redactSecrets(value: string): string {
  let redacted = value;
  for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function containsSecretLikeValue(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function assertNoSecretLikeMetadata(field: string, value: string | undefined): void {
  const trimmed = asTrimmed(value);
  if (trimmed && containsSecretLikeValue(trimmed)) {
    throw new Error(`${field} appears to contain a secret or credential`);
  }
}

function assertNoSecretLikeMetadataList(field: string, values: string[] | undefined): void {
  for (const value of values ?? []) {
    assertNoSecretLikeMetadata(field, value);
  }
}

function sanitizeReviewText(value: string | undefined, fallback: string): string {
  const redacted = redactSecrets(asTrimmed(value) ?? fallback);
  const sanitized = sanitizeMemoryContent(redacted);
  const safe = sanitized.text.trim();
  return safe.length > 0 ? safe : fallback;
}

function sanitizeReviewMetadata(value: string | undefined): string | undefined {
  const trimmed = asTrimmed(value);
  if (!trimmed) return undefined;
  return sanitizeReviewText(trimmed, "[redacted]");
}

function sanitizeReviewTags(tags: string[] | undefined): string[] {
  return Array.from(new Set((tags ?? [])
    .map((tag) => sanitizeReviewMetadata(tag))
    .filter((tag): tag is string => typeof tag === "string" && tag.length > 0)));
}

function normalizeExplicitCaptureError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  const rendered = String(error).trim();
  return rendered.length > 0 ? rendered : "explicit capture failed";
}

function resolveExplicitCaptureReviewNamespace(
  orchestrator: Orchestrator,
  namespace: string | undefined,
): string | undefined {
  const normalized = asTrimmed(namespace);
  if (!normalized) return undefined;
  return resolveExplicitCaptureNamespace(orchestrator, normalized);
}

function resolveExplicitCaptureNamespace(
  orchestrator: Orchestrator,
  namespace: string | undefined,
): string | undefined {
  const normalized = asTrimmed(namespace);
  if (!normalized) return undefined;
  if (!resolveNamespaceCapabilities(orchestrator.config).namespaces) {
    if (normalized !== orchestrator.config.defaultNamespace) {
      throw new Error(`unsupported namespace: ${normalized}`);
    }
    return normalized;
  }
  const allowed = new Set([
    orchestrator.config.defaultNamespace,
    orchestrator.config.sharedNamespace,
    ...orchestrator.config.namespacePolicies.map((policy) => policy.name),
  ].map((value) => value.trim()).filter(Boolean));
  if (!allowed.has(normalized)) {
    throw new Error(`unsupported namespace: ${normalized}`);
  }
  return normalized;
}

function parseExplicitCaptureTtl(ttl: string | undefined): string | undefined {
  const raw = asTrimmed(ttl);
  if (!raw) return undefined;

  const absoluteMs = Date.parse(raw);
  if (Number.isFinite(absoluteMs)) {
    return new Date(absoluteMs).toISOString();
  }

  const relative = raw.match(/^(\d+)\s*([mhdw])$/i);
  if (!relative) {
    throw new Error("ttl must be an ISO-8601 timestamp or relative duration like 30m, 12h, 7d, or 2w");
  }

  const amount = Number.parseInt(relative[1] ?? "", 10);
  const unit = (relative[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("ttl duration must be a positive integer");
  }

  const multiplier =
    unit === "m" ? 60_000
      : unit === "h" ? 60 * 60_000
        : unit === "d" ? 24 * 60 * 60_000
          : 7 * 24 * 60 * 60_000;
  return new Date(Date.now() + amount * multiplier).toISOString();
}

function parseInlineConfidence(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    return Number.NaN;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseInlineNote(block: string): ExplicitCaptureInput {
  const lines = block.replace(/\r/g, "").split("\n");
  const note: Partial<ExplicitCaptureInput> = {};
  let idx = 0;

  while (idx < lines.length) {
    const rawLine = lines[idx] ?? "";
    const line = rawLine.trim();
    idx += 1;
    if (line.length === 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "content" && value === "|") {
      const contentLines: string[] = [];
      while (idx < lines.length) {
        const next = lines[idx] ?? "";
        if (next.startsWith("  ") || next.startsWith("\t")) {
          contentLines.push(next.replace(/^(  |\t)/, ""));
          idx += 1;
          continue;
        }
        if (next.trim().length === 0) {
          contentLines.push("");
          idx += 1;
          continue;
        }
        break;
      }
      note.content = contentLines.join("\n").trim();
      continue;
    }

    switch (key) {
      case "content":
        note.content = value;
        break;
      case "category":
        note.category = value;
        break;
      case "confidence":
        note.confidence = parseInlineConfidence(value);
        break;
      case "namespace":
        note.namespace = value;
        break;
      case "tags":
        note.tags = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case "entityRef":
        note.entityRef = value;
        break;
      case "ttl":
        note.ttl = value;
        break;
      case "sourceReason":
        note.sourceReason = value;
        break;
      default:
        break;
    }
  }

  return { content: "", ...note };
}

function parseInlineExplicitCaptureCandidates(text: string): ExplicitCaptureInput[] {
  const notes: ExplicitCaptureInput[] = [];
  for (const match of text.matchAll(INLINE_NOTE_RE)) {
    notes.push(parseInlineNote(match[1] ?? ""));
  }
  return notes;
}

export function parseInlineExplicitCaptureNotes(text: string): ExplicitCaptureInput[] {
  return parseInlineExplicitCaptureCandidates(text).filter((note) => asTrimmed(note.content));
}

export function hasInlineExplicitCaptureMarkup(text: string): boolean {
  return INLINE_NOTE_MARKUP_RE.test(text);
}

export function stripInlineExplicitCaptureNotes(text: string): string {
  return text.replace(INLINE_NOTE_RE, "").trim();
}

export function validateExplicitCaptureInput(
  input: ExplicitCaptureInput,
  mode: ExplicitCaptureValidationMode = "strict_explicit",
): ValidExplicitCapture {
  const content = asTrimmed(input.content);
  if (!content) throw new Error("content is required");
  if (mode === "strict_explicit") {
    if (content.length < 10) throw new Error("content must be at least 10 characters");
    if (content.length > 4000) throw new Error("content must be 4000 characters or fewer");
  }
  if (/<memory_note>/i.test(content) || /<\/memory_note>/i.test(content)) {
    throw new Error("nested memory_note blocks are not allowed");
  }

  const category = (asTrimmed(input.category) ?? "fact") as MemoryCategory;
  if (!INLINE_ALLOWED_CATEGORIES.has(category)) {
    throw new Error(`unsupported category: ${input.category ?? category}`);
  }

  const sanitized = sanitizeMemoryContent(content);
  if (!sanitized.clean) {
    throw new Error("content failed memory sanitization");
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error("content appears to contain a secret or credential");
    }
  }
  assertNoSecretLikeMetadata("sourceReason", input.sourceReason);
  assertNoSecretLikeMetadata("entityRef", input.entityRef);
  assertNoSecretLikeMetadata("ttl", input.ttl);
  assertNoSecretLikeMetadataList("tags", input.tags);

  if (input.confidence !== undefined && !Number.isFinite(input.confidence)) {
    throw new Error("confidence must be a finite number");
  }
  const confidence = input.confidence === undefined ? 0.95 : Number(input.confidence);
  if (confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  const requestedNamespace = asTrimmed(input.namespace);
  if (requestedNamespace && !isSafeRouteNamespace(requestedNamespace)) {
    throw new Error(`unsafe namespace: ${requestedNamespace}`);
  }
  const expiresAt = parseExplicitCaptureTtl(input.ttl);

  // #2014 review round: enforce the composer's tag contract HERE so a capture
  // that passes validation can never fail later at strict compose time
  // (validated-then-thrown was a broken contract). Same limits as TAG_LIMITS.
  const dedupedTags = Array.from(new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)));
  if (dedupedTags.length > TAG_LIMITS.maxTags) {
    throw new Error(`too many tags: ${dedupedTags.length} exceeds the ${TAG_LIMITS.maxTags}-tag limit`);
  }
  for (const tag of dedupedTags) {
    if (tag.length > TAG_LIMITS.maxTagLength) {
      throw new Error(`tag exceeds ${TAG_LIMITS.maxTagLength} characters: ${JSON.stringify(tag.slice(0, 40))}…`);
    }
  }

  return {
    content,
    category,
    confidence,
    namespace: asTrimmed(input.namespace),
    tags: dedupedTags,
    entityRef: asTrimmed(input.entityRef),
    sourceReason: asTrimmed(input.sourceReason),
    // Trimmed like the other optional metadata (#2017 review round): a
    // whitespace-only connector previously passed validation and then blew
    // up at strict compose time - validated input must always compose.
    sourceConnector: asTrimmed(input.sourceConnector),
    expiresAt,
  };
}

async function findDuplicateExplicitCapture(
  orchestrator: Orchestrator,
  resolvedNamespace: string | undefined,
  candidate: ValidExplicitCapture,
  storageOverride?: StorageManager,
): Promise<{ id: string; tombstoneBlocked: boolean } | null> {
  const storage = storageOverride ?? await orchestrator.getStorage(resolvedNamespace);
  // Tombstone-blocked rows are absent from the active fact hash index. An
  // authoritative miss can therefore skip the corpus scan only after the
  // targeted blocked-row index reports a miss and remains authoritative.
  let activeFactHashMayMatch = true;
  let authoritativeFactHashMiss = false;
  if (
    candidate.category === "fact"
    && typeof storage.hasFactContentHash === "function"
  ) {
    try {
      const hasHash = await storage.hasFactContentHash(candidate.content);
      if (!hasHash) {
        const authoritative =
          typeof storage.isFactContentHashAuthoritative === "function"
            ? await storage.isFactContentHashAuthoritative()
            : false;
        activeFactHashMayMatch = !authoritative;
        authoritativeFactHashMiss = authoritative;
      }
    } catch (err) {
      // Fail open: hash indexes are only an optimization, so fall back to the
      // full corpus scan when either index cannot answer.
      void err;
    }
  }
  if (authoritativeFactHashMiss) {
    const checkBlockedIndex = storage.checkTombstoneBlockedExplicitCapture;
    if (typeof checkBlockedIndex === "function") {
      try {
        const result = await checkBlockedIndex.call(
          storage,
          candidate.content,
          candidate.category,
          candidate.sourceConnector,
        );
        if (!result.has && result.authoritative) return null;
      } catch (err) {
        // Fail open: an unavailable targeted index must not hide a durable
        // pending-review duplicate.
        void err;
      }
    } else {
      const hasBlockedIndex = storage.hasTombstoneBlockedExplicitCapture;
      if (typeof hasBlockedIndex === "function") {
        try {
          const hasBlocked = await hasBlockedIndex.call(
            storage,
            candidate.content,
            candidate.category,
            candidate.sourceConnector,
          );
          if (!hasBlocked) {
            const isIndexAuthoritative =
              typeof storage.isTombstoneBlockedExplicitCaptureIndexAuthoritative === "function"
                ? await storage.isTombstoneBlockedExplicitCaptureIndexAuthoritative()
                : false;
            if (isIndexAuthoritative) return null;
          }
        } catch (err) {
          // Fail open: an unavailable targeted index must not hide a durable
          // pending-review duplicate.
          void err;
        }
      }
    }
  }
  const hotMemories = await storage.readAllMemories();
  const coldMemories =
    typeof storage.readAllColdMemories === "function"
      ? await storage.readAllColdMemories()
      : [];
  const existing = [...hotMemories, ...coldMemories];
  const normalizedCandidate = normalizeExplicitCaptureContent(candidate.content);
  const match = existing.find((memory) => {
    const status = memory.frontmatter.status ?? "active";
    if (
      (status !== "active" && (status !== "pending_review" || !memory.frontmatter.blockedBy))
      || (status === "active" && !activeFactHashMayMatch)
    ) {
      return false;
    }
    if (memory.frontmatter.category !== candidate.category) return false;
    if (normalizeExplicitCaptureContent(memory.content) !== normalizedCandidate) return false;
    // Connector-aware dedup: same content from different connectors is NOT
    // a duplicate. Operator (undefined) and connector-tagged memories are
    // always distinct. Normalize empty strings to undefined.
    const existingConnector = memory.frontmatter.sourceConnector?.trim() || undefined;
    const newConnector = candidate.sourceConnector?.trim() || undefined;
    if (existingConnector !== newConnector) return false;
    return true;
  });
  return match
    ? {
        id: match.frontmatter.id,
        tombstoneBlocked:
          match.frontmatter.status === "pending_review" && Boolean(match.frontmatter.blockedBy),
      }
    : null;
}
async function persistExplicitCaptureUnlocked(
  orchestrator: Orchestrator,
  candidate: ValidExplicitCapture,
  source: ExplicitCaptureSource,
  resolvedNamespace: string | undefined,
  storage: StorageManager,
): Promise<{ id: string; duplicateOf?: string; tombstoneBlocked?: boolean }> {
  const duplicate = await findDuplicateExplicitCapture(
    orchestrator,
    resolvedNamespace,
    candidate,
    storage,
  );
  if (duplicate) {
    return duplicate.tombstoneBlocked
      ? { id: duplicate.id, duplicateOf: duplicate.id, tombstoneBlocked: true }
      : { id: duplicate.id, duplicateOf: duplicate.id };
  }

  // #1645 (review thread yG-): surface the tombstone block so callers
  // (memory_store tool, access-service HTTP/MCP) can report the capture as
  // queued for review instead of a successfully stored active memory.
  // Sealed-envelope write (issue #1989 PR2).
  const captureEnvelope = composeMemoryEnvelope(
    {
      content: candidate.content,
      category: candidate.category,
      confidence: candidate.confidence,
      tags: candidate.tags,
      ...(candidate.entityRef ? { entityRef: candidate.entityRef } : {}),
      ...(candidate.expiresAt ? { ttl: candidate.expiresAt } : {}),
      ...(candidate.sourceConnector ? { sourceConnector: candidate.sourceConnector } : {}),
      ...(candidate.sourceReason ? { sourceReason: candidate.sourceReason } : {}),
    },
    { source: source === "inline" ? "explicit-inline" : "explicit" },
  );
  const { id, tombstoneBlocked } = await storage.writeSealedMemory(captureEnvelope);
  // #1522: catalog touch handled at the storage chokepoint — the StorageManager's
  // post-write hook records the namespace touch automatically.

  const created = new Date().toISOString();
  const event: MemoryLifecycleEvent = {
    eventId: `mle-${randomUUID()}`,
    memoryId: id,
    eventType: tombstoneBlocked ? "explicit_capture_queued" : "explicit_capture_accepted",
    timestamp: created,
    actor: explicitCaptureActor(source),
    reasonCode: candidate.sourceReason,
    ruleVersion: "explicit-capture.v1",
  };
  await storage.appendMemoryLifecycleEvents([event]);

  return { id, tombstoneBlocked };
}

export async function persistExplicitCapture(
  orchestrator: Orchestrator,
  candidate: ValidExplicitCapture,
  source: ExplicitCaptureSource,
): Promise<{ id: string; duplicateOf?: string; tombstoneBlocked?: boolean }> {
  const resolvedNamespace = candidate.namespacePreResolved
    ? asTrimmed(candidate.namespace)
    : resolveExplicitCaptureNamespace(orchestrator, candidate.namespace);
  const storage = await orchestrator.getStorage(resolvedNamespace);
  const persist = () =>
    persistExplicitCaptureUnlocked(orchestrator, candidate, source, resolvedNamespace, storage);
  if (typeof storage.withTombstoneBlockedCaptureWriteLock !== "function") return await persist();
  return await storage.withTombstoneBlockedCaptureWriteLock(persist);
}

function buildExplicitCaptureReviewContent(input: ExplicitCaptureInput, reason: string): string {
  const requestedContent = asTrimmed(input.content);
  const safeContent = sanitizeReviewText(requestedContent, "[empty explicit capture]");
  const safeCategory = sanitizeReviewMetadata(input.category);
  const safeNamespace = sanitizeReviewMetadata(input.namespace);
  const safeEntityRef = sanitizeReviewMetadata(input.entityRef);
  const safeTtl = sanitizeReviewMetadata(input.ttl);
  const safeSourceReason = sanitizeReviewMetadata(input.sourceReason);
  const safeTags = sanitizeReviewTags(input.tags);
  const lines = [
    "Explicit capture queued for review.",
    "",
    `Reason: ${reason}`,
    "",
    "Submitted content:",
    safeContent,
  ];
  const metadata = [
    safeCategory ? `Requested category: ${safeCategory}` : undefined,
    safeNamespace ? `Requested namespace: ${safeNamespace}` : undefined,
    safeEntityRef ? `Requested entityRef: ${safeEntityRef}` : undefined,
    safeTtl ? `Requested ttl: ${safeTtl}` : undefined,
    safeSourceReason ? `Requested sourceReason: ${safeSourceReason}` : undefined,
    safeTags.length > 0 ? `Requested tags: ${safeTags.join(", ")}` : undefined,
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (metadata.length > 0) {
    lines.push("", ...metadata);
  }
  return lines.join("\n");
}

async function findQueuedExplicitCaptureDuplicate(
  orchestrator: Orchestrator,
  namespace: string | undefined,
  content: string,
  sourceConnector?: string,
): Promise<string | null> {
  const storage = await orchestrator.getStorage(namespace);
  const hotMemories = await storage.readAllMemories();
  const coldMemories =
    typeof storage.readAllColdMemories === "function"
      ? await storage.readAllColdMemories()
      : [];
  const existing = [...hotMemories, ...coldMemories];
  const normalized = normalizeExplicitCaptureContent(content);
  const match = existing.find((memory) => {
    const status = memory.frontmatter.status ?? "active";
    if (status !== "pending_review") return false;
    if (!(memory.frontmatter.tags ?? []).includes("queued-review")) return false;
    if (normalizeExplicitCaptureContent(memory.content) !== normalized) return false;
    const existingConnector = memory.frontmatter.sourceConnector?.trim() || undefined;
    const newConnector = sourceConnector?.trim() || undefined;
    if (existingConnector !== newConnector) return false;
    return true;
  });
  return match?.frontmatter.id ?? null;
}

export type ExplicitCaptureReviewQueueOptions = {
  /** A server-authorized namespace resolved from the authenticated session. */
  resolvedNamespace?: string;
};

export async function queueExplicitCaptureForReview(
  orchestrator: Orchestrator,
  input: ExplicitCaptureInput,
  source: ExplicitCaptureSource,
  error: unknown,
  options: ExplicitCaptureReviewQueueOptions = {},
): Promise<{ id: string; duplicateOf?: string }> {
  const reason = sanitizeReviewText(normalizeExplicitCaptureError(error), "explicit capture failed");
  const requestedNamespace = asTrimmed(input.namespace);
  const resolvedNamespace = asTrimmed(options.resolvedNamespace);
  // A caller-pre-authorized namespace (e.g. a session-owned project overlay
  // from the access service) routes directly; otherwise apply the static
  // policy allow-list guard (#1434).
  const queueNamespace = resolvedNamespace ??
    ((input as { namespacePreResolved?: boolean }).namespacePreResolved
      ? requestedNamespace
      : resolveExplicitCaptureReviewNamespace(orchestrator, requestedNamespace));
  const content = buildExplicitCaptureReviewContent(input, reason);
  const duplicateOf = await findQueuedExplicitCaptureDuplicate(orchestrator, queueNamespace, content, input.sourceConnector);
  if (duplicateOf) {
    return { id: duplicateOf, duplicateOf };
  }

  const requestedCategory = asTrimmed(input.category);
  const reviewCategory = requestedCategory && INLINE_ALLOWED_CATEGORIES.has(requestedCategory as MemoryCategory)
    ? requestedCategory as MemoryCategory
    : "fact";
  const requestedTags = sanitizeReviewTags(input.tags);
  const storage = await orchestrator.getStorage(queueNamespace);
  const reviewEnvelope = composeMemoryEnvelope(
    {
      content,
      category: reviewCategory,
      confidence: 0.2,
      tags: Array.from(new Set([...EXPLICIT_CAPTURE_REVIEW_TAGS, ...requestedTags])),
      ...(sanitizeReviewMetadata(input.entityRef) ? { entityRef: sanitizeReviewMetadata(input.entityRef) } : {}),
      ...(input.sourceConnector ? { sourceConnector: input.sourceConnector } : {}),
    },
    { source: source === "inline" ? "explicit-inline-review" : "explicit-review" },
    // The review queue is the FALLBACK for a capture that already failed
    // primary validation — it must never be un-queueable. The tag list is
    // machine-assembled (requested tags + the two fixed review tags), so 49+
    // requested tags would push past the 50-tag limit and strict compose
    // would throw, losing the capture (#2014 review round). Salvage clamps
    // instead; the fixed review tags sort first in the assembly above, so
    // they always survive the clamp.
    { salvage: true },
  );
  const { id: id } = await storage.writeSealedMemory(reviewEnvelope);
  try {
    const created = await storage.getMemoryById(id);
    if (created) {
      await storage.writeMemoryFrontmatter(created, {
        status: "pending_review",
        updated: new Date().toISOString(),
      }, {
        actor: explicitCaptureActor(source),
        reasonCode: reason,
        ruleVersion: "explicit-capture.v1",
      });
    }
  } finally {
    // Record the catalog write touch (issue #1499, round 5/6 codex P2; NIhUg).
    // A queued review capture writes memory to the namespace's root (the DEFAULT
    // root when undefined), so its `lastWriteAt` must reflect the write once
    // `writeMemory` returns an id. If the later pending-review frontmatter update
    // fails, the memory file is still durable and must not disappear from
    // writtenSince/maintenance scheduling. Guarded optional hook (rule #33).
    // #1522: catalog touch handled at the storage chokepoint.
  }
  const event: MemoryLifecycleEvent = {
    eventId: `mle-${randomUUID()}`,
    memoryId: id,
    eventType: "explicit_capture_queued",
    timestamp: new Date().toISOString(),
    actor: explicitCaptureActor(source),
    reasonCode: reason,
    ruleVersion: "explicit-capture.v1",
  };
  await storage.appendMemoryLifecycleEvents([event]);
  return { id };
}

export function shouldSkipImplicitExtraction(cfg: Pick<PluginConfig, "captureMode">): boolean {
  return cfg.captureMode === "explicit";
}

export function shouldProcessInlineExplicitCapture(cfg: Pick<PluginConfig, "captureMode">): boolean {
  return cfg.captureMode !== "implicit";
}

export interface InlineExplicitCaptureProcessRequest {
  content: string;
  captureMode: CaptureMode;
  dedupeKeys?: readonly string[];
  namespace?: string;
  namespacePreResolved?: boolean;
  reviewNamespace?: string;
  reviewNamespacePreResolved?: boolean;
  sourceConnector?: string;
}

export interface InlineExplicitCaptureProcessResult {
  content: string;
  processed: number;
  accepted: number;
  queued: number;
  duplicates: number;
  failed: number;
}

export interface InlineExplicitCaptureProcessorOptions {
  sourceConnector?: string;
  maxDedupeKeys?: number;
}

const DEFAULT_INLINE_CAPTURE_DEDUPE_KEY_LIMIT = 1024;

export class InlineExplicitCaptureProcessor {
  private readonly observedKeys = new Set<string>();
  private readonly observedKeyOrder: string[] = [];
  private readonly maxDedupeKeys: number;
  private readonly processingTails = new Map<string, Promise<void>>();

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly options: InlineExplicitCaptureProcessorOptions = {},
  ) {
    const requestedLimit = options.maxDedupeKeys ?? DEFAULT_INLINE_CAPTURE_DEDUPE_KEY_LIMIT;
    this.maxDedupeKeys =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.max(1, Math.floor(requestedLimit))
        : DEFAULT_INLINE_CAPTURE_DEDUPE_KEY_LIMIT;
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.processingTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.processingTails.set(key, current);
    return previous.then(operation).finally(() => {
      if (this.processingTails.get(key) === current) this.processingTails.delete(key);
      release();
    });
  }

  private buildDedupeKeys(
    dedupeKeys: readonly string[] | undefined,
    input: ExplicitCaptureInput,
    namespacePreResolved: boolean,
    fallbackReviewNamespace?: string,
  ): { replayKeys: string[]; validationFailureKey: string } {
    let effectiveNamespace = asTrimmed(input.namespace);
    if (!namespacePreResolved) {
      try {
        effectiveNamespace = resolveExplicitCaptureNamespace(
          this.orchestrator,
          effectiveNamespace,
        );
      } catch {
        effectiveNamespace = asTrimmed(fallbackReviewNamespace) ?? asTrimmed(input.namespace);
      }
    }
    const namespaceScope =
      effectiveNamespace ?? this.orchestrator.config.defaultNamespace;
    const sourceConnectorScope = asTrimmed(input.sourceConnector) ?? "";
    const noteHash = createHash("sha256")
      .update(
        JSON.stringify({
          content: normalizeExplicitCaptureContent(input.content),
          category: asTrimmed(input.category) ?? "fact",
        }),
      )
      .digest("hex");
    const validationTags = Array.from(
      new Set(
        (input.tags ?? [])
          .map((tag) => asTrimmed(tag))
          .filter((tag): tag is string => tag !== undefined),
      ),
    ).sort();
    const validationHash = createHash("sha256")
      .update(
        JSON.stringify({
          content: asTrimmed(input.content) ?? "",
          category: asTrimmed(input.category) ?? "fact",
          confidence:
            input.confidence === undefined
              ? "default"
              : Number.isFinite(input.confidence)
                ? input.confidence
                : "invalid",
          namespace: asTrimmed(input.namespace),
          tags: validationTags,
          entityRef: asTrimmed(input.entityRef),
          sourceReason: asTrimmed(input.sourceReason),
          ttl: asTrimmed(input.ttl),
        }),
      )
      .digest("hex");
    const deliveryKeys = (dedupeKeys ?? [])
      .map((key) => asTrimmed(key))
      .filter((key): key is string => key !== undefined);
    const identityPrefix = `${namespaceScope}\u0000${sourceConnectorScope}\u0000`;
    const fallbackKey = `${identityPrefix}fallback:inline-memory-note:${noteHash}`;
    return {
      replayKeys: [
        ...deliveryKeys.map(
          (key) => `${identityPrefix}${key}:inline-memory-note:${noteHash}`,
        ),
        fallbackKey,
      ],
      validationFailureKey: `${identityPrefix}validation:inline-memory-note:${validationHash}`,
    };
  }

  private isNamespacePolicyAuthorized(namespace: string | undefined): boolean {
    try {
      resolveExplicitCaptureNamespace(this.orchestrator, namespace);
      return true;
    } catch {
      return false;
    }
  }

  private remember(keys: readonly string[]): void {
    for (const key of keys) {
      if (this.observedKeys.has(key)) continue;
      this.observedKeys.add(key);
      this.observedKeyOrder.push(key);
    }
    while (this.observedKeyOrder.length > this.maxDedupeKeys) {
      const expired = this.observedKeyOrder.shift();
      if (expired) this.observedKeys.delete(expired);
    }
  }

  private async processNote(
    request: InlineExplicitCaptureProcessRequest,
    input: ExplicitCaptureInput,
    replayKeys: readonly string[],
    validationFailureKey: string,
  ): Promise<
    Pick<InlineExplicitCaptureProcessResult, "processed" | "accepted" | "queued" | "duplicates" | "failed">
  > {
    const serializationKey = replayKeys.at(-1) ?? validationFailureKey;
    return this.enqueue(serializationKey, async () => {
      if (
        replayKeys.some((key) => this.observedKeys.has(key))
        || this.observedKeys.has(validationFailureKey)
      ) {
        return { processed: 0, accepted: 0, queued: 0, duplicates: 1, failed: 0 };
      }

      let validationSucceeded = false;
      try {
        const candidate = validateExplicitCaptureInput(input);
        if (request.namespacePreResolved === true) candidate.namespacePreResolved = true;
        validationSucceeded = true;
        const persisted = await persistExplicitCapture(this.orchestrator, candidate, "inline");
        this.remember(replayKeys);
        if (persisted.duplicateOf) {
          return { processed: 1, accepted: 0, queued: 0, duplicates: 1, failed: 0 };
        }
        if (persisted.tombstoneBlocked) {
          this.orchestrator.requestQmdMaintenanceForTool("inline.memory_note.review");
          return { processed: 1, accepted: 0, queued: 1, duplicates: 0, failed: 0 };
        }
        this.orchestrator.requestQmdMaintenanceForTool("inline.memory_note");
        return { processed: 1, accepted: 1, queued: 0, duplicates: 0, failed: 0 };
      } catch (error) {
        const queueInput = request.namespacePreResolved === true
          ? { ...input, namespacePreResolved: true }
          : input;
        const reviewNamespace =
          request.reviewNamespacePreResolved === true &&
          request.namespacePreResolved !== true &&
          !this.isNamespacePolicyAuthorized(input.namespace)
            ? request.reviewNamespace
            : undefined;
        try {
          const review = await queueExplicitCaptureForReview(
            this.orchestrator,
            queueInput,
            "inline",
            error,
            reviewNamespace ? { resolvedNamespace: reviewNamespace } : undefined,
          );
          this.remember(validationSucceeded ? replayKeys : [validationFailureKey]);
          if (review.duplicateOf) {
            return { processed: 1, accepted: 0, queued: 0, duplicates: 1, failed: 0 };
          }
          this.orchestrator.requestQmdMaintenanceForTool("inline.memory_note.review");
          return { processed: 1, accepted: 0, queued: 1, duplicates: 0, failed: 0 };
        } catch (queueError) {
          log.warn(
            `explicit inline capture rejected: ${normalizeExplicitCaptureError(error)}; review queue fallback failed: ${normalizeExplicitCaptureError(queueError)}`,
          );
          return { processed: 0, accepted: 0, queued: 0, duplicates: 0, failed: 1 };
        }
      }
    });
  }

  async process(request: InlineExplicitCaptureProcessRequest): Promise<InlineExplicitCaptureProcessResult> {
    if (!shouldProcessInlineExplicitCapture({ captureMode: request.captureMode })) {
      return { content: request.content, processed: 0, accepted: 0, queued: 0, duplicates: 0, failed: 0 };
    }
    if (request.namespacePreResolved === true && !asTrimmed(request.namespace)) {
      throw new Error("namespacePreResolved requires a resolved namespace");
    }
    if (request.reviewNamespacePreResolved === true && !asTrimmed(request.reviewNamespace)) {
      throw new Error("reviewNamespacePreResolved requires a resolved namespace");
    }

    const notes = parseInlineExplicitCaptureCandidates(request.content);
    const content = hasInlineExplicitCaptureMarkup(request.content)
      ? stripInlineExplicitCaptureNotes(request.content)
      : request.content;
    const sourceConnector = asTrimmed(request.sourceConnector) ?? asTrimmed(this.options.sourceConnector);
    let processed = 0;
    let accepted = 0;
    let queued = 0;
    let duplicates = 0;
    let failed = 0;

    for (const note of notes) {
      const input: ExplicitCaptureInput = {
        ...note,
        ...(request.namespace !== undefined ? { namespace: request.namespace } : {}),
        ...(sourceConnector ? { sourceConnector } : {}),
      };
      const { replayKeys, validationFailureKey } = this.buildDedupeKeys(
        request.dedupeKeys,
        input,
        request.namespacePreResolved === true,
        request.reviewNamespacePreResolved === true
          ? request.reviewNamespace
          : undefined,
      );
      const result = await this.processNote(request, input, replayKeys, validationFailureKey);
      processed += result.processed;
      accepted += result.accepted;
      queued += result.queued;
      duplicates += result.duplicates;
      failed += result.failed;
    }

    return { content, processed, accepted, queued, duplicates, failed };
  }
}
