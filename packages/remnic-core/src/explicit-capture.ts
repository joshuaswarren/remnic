import { randomUUID } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";
import { isSafeRouteNamespace } from "./routing/engine.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import { ContentHashIndex } from "./storage.js";
import type { CaptureMode, MemoryCategory, MemoryLifecycleEvent, PluginConfig } from "./types.js";

export type ExplicitCaptureInput = {
  content: string;
  category?: string;
  confidence?: number;
  namespace?: string;
  tags?: string[];
  entityRef?: string;
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
  expiresAt?: string;
  sourceReason?: string;
};

export type ExplicitCaptureSource = "memory_store" | "memory_capture" | "suggestion_submit" | "inline";
type ExplicitCaptureValidationMode = "legacy_tool" | "strict_explicit";

const INLINE_NOTE_RE = /<memory_note>\s*([\s\S]*?)\s*<\/memory_note>/gi;
const INLINE_NOTE_MARKUP_RE = /<memory_note>\s*[\s\S]*?\s*<\/memory_note>/i;
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

function normalizeCaptureContent(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
  if (!orchestrator.config.namespacesEnabled) {
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

function parseInlineNote(block: string): ExplicitCaptureInput | null {
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

  return asTrimmed(note.content) ? (note as ExplicitCaptureInput) : null;
}

export function parseInlineExplicitCaptureNotes(text: string): ExplicitCaptureInput[] {
  const notes: ExplicitCaptureInput[] = [];
  for (const match of text.matchAll(INLINE_NOTE_RE)) {
    const parsed = parseInlineNote(match[1] ?? "");
    if (parsed) notes.push(parsed);
  }
  return notes;
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

  return {
    content,
    category,
    confidence,
    namespace: asTrimmed(input.namespace),
    tags: Array.from(new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))),
    entityRef: asTrimmed(input.entityRef),
    expiresAt,
    sourceReason: asTrimmed(input.sourceReason),
  };
}

async function findDuplicateExplicitCapture(
  orchestrator: Orchestrator,
  resolvedNamespace: string | undefined,
  candidate: ValidExplicitCapture,
): Promise<string | null> {
  const storage = await orchestrator.getStorage(resolvedNamespace);
  if (
    candidate.category === "fact"
    && typeof (storage as { hasFactContentHash?: (content: string) => Promise<boolean> }).hasFactContentHash === "function"
  ) {
    try {
      const hasHash = await (storage as { hasFactContentHash: (content: string) => Promise<boolean> }).hasFactContentHash(
        candidate.content,
      );
      if (!hasHash) {
        const authoritative =
          typeof (storage as { isFactContentHashAuthoritative?: () => Promise<boolean> | boolean }).isFactContentHashAuthoritative
            === "function"
            ? await (storage as { isFactContentHashAuthoritative: () => Promise<boolean> | boolean })
              .isFactContentHashAuthoritative()
            : false;
        if (authoritative) return null;
      }
    } catch (err) {
      // Fail open: hash index is only an optimization, so fall back to the full corpus scan.
      void err;
    }
  }
  const existing = await storage.readAllMemories();
  const normalizedCandidate = normalizeCaptureContent(candidate.content);
  const match = existing.find((memory) => {
    const status = memory.frontmatter.status ?? "active";
    if (status !== "active") return false;
    if (memory.frontmatter.category !== candidate.category) return false;
    return normalizeCaptureContent(memory.content) === normalizedCandidate;
  });
  return match?.frontmatter.id ?? null;
}

export async function persistExplicitCapture(
  orchestrator: Orchestrator,
  candidate: ValidExplicitCapture,
  source: ExplicitCaptureSource,
): Promise<{ id: string; duplicateOf?: string }> {
  const resolvedNamespace = resolveExplicitCaptureNamespace(orchestrator, candidate.namespace);
  const duplicateOf = await findDuplicateExplicitCapture(orchestrator, resolvedNamespace, candidate);
  if (duplicateOf) {
    return { id: duplicateOf, duplicateOf };
  }

  const storage = await orchestrator.getStorage(resolvedNamespace);
  const id = await storage.writeMemory(candidate.category, candidate.content, {
    confidence: candidate.confidence,
    tags: candidate.tags,
    entityRef: candidate.entityRef,
    expiresAt: candidate.expiresAt,
    source: source === "inline" ? "explicit-inline" : "explicit",
  });

  const created = new Date().toISOString();
  const event: MemoryLifecycleEvent = {
    eventId: `mle-${randomUUID()}`,
    memoryId: id,
    eventType: "explicit_capture_accepted",
    timestamp: created,
    actor: explicitCaptureActor(source),
    reasonCode: candidate.sourceReason,
    ruleVersion: "explicit-capture.v1",
  };
  await storage.appendMemoryLifecycleEvents([event]);

  return { id };
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
): Promise<string | null> {
  const storage = await orchestrator.getStorage(namespace);
  const existing = await storage.readAllMemories();
  const normalized = normalizeCaptureContent(content);
  const match = existing.find((memory) => {
    const status = memory.frontmatter.status ?? "active";
    if (status !== "pending_review") return false;
    if (!(memory.frontmatter.tags ?? []).includes("queued-review")) return false;
    return normalizeCaptureContent(memory.content) === normalized;
  });
  return match?.frontmatter.id ?? null;
}

export async function queueExplicitCaptureForReview(
  orchestrator: Orchestrator,
  input: ExplicitCaptureInput,
  source: ExplicitCaptureSource,
  error: unknown,
): Promise<{ id: string; duplicateOf?: string }> {
  const reason = sanitizeReviewText(normalizeExplicitCaptureError(error), "explicit capture failed");
  const requestedNamespace = asTrimmed(input.namespace);
  const queueNamespace = resolveExplicitCaptureReviewNamespace(orchestrator, requestedNamespace);
  const content = buildExplicitCaptureReviewContent(input, reason);
  const duplicateOf = await findQueuedExplicitCaptureDuplicate(orchestrator, queueNamespace, content);
  if (duplicateOf) {
    return { id: duplicateOf, duplicateOf };
  }

  const requestedCategory = asTrimmed(input.category);
  const reviewCategory = requestedCategory && INLINE_ALLOWED_CATEGORIES.has(requestedCategory as MemoryCategory)
    ? requestedCategory as MemoryCategory
    : "fact";
  const requestedTags = sanitizeReviewTags(input.tags);
  const storage = await orchestrator.getStorage(queueNamespace);
  const id = await storage.writeMemory(reviewCategory, content, {
    confidence: 0.2,
    tags: Array.from(new Set([...EXPLICIT_CAPTURE_REVIEW_TAGS, ...requestedTags])),
    entityRef: sanitizeReviewMetadata(input.entityRef),
    source: source === "inline" ? "explicit-inline-review" : "explicit-review",
  });
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
