/**
 * correction/correction-contract.ts — Types for the Correction Contract
 * (issue #1580).
 *
 * The Correction Contract is the SINGLE plan/apply pipeline every memory
 * correction flows through: supersession, invalidation, tombstone, edit,
 * rescope, redaction. A correction arrives as a plain-language statement
 * ("we migrated to MySQL in March"); the planner turns it into a structured
 * {@link CorrectionPlan}; the executor applies the plan in non-destructive
 * order through the existing storage/orchestrator chokepoints.
 *
 * This module is PURE types + validation helpers — no I/O, no side effects.
 * The planner and executor live in sibling modules and inject their own
 * collaborators so the contract is testable in isolation (rule 33).
 *
 * Design rules honored (issue #1580 design section):
 *   - Plans are per-request state on disk, never module-level (rules 11/47).
 *   - Caller-supplied namespaces are NEVER trusted raw — the service
 *     resolves them through the normal namespace policy (rule 42).
 *   - Bulk operations refuse past maxAffected (no silent truncation, §39).
 *   - `never_store` redaction patterns must be bounded and safe (§34).
 */

import type { MemoryCategory, MemoryFrontmatter } from "../types.js";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * The user-facing input: a plain-language correction plus optional explicit
 * targets. This is what every surface (MCP / HTTP / CLI) collects before
 * handing off to the planner.
 */
export interface CorrectionRequest {
  /** Natural-language correction statement. Required, non-empty. */
  text: string;
  /**
   * Explicit target memory ids (or handles via #1582). When present the
   * planner resolves these directly; an unknown id is an explicit error
   * (rule 34), never a silent empty plan. When absent the planner searches.
   */
  targetIds?: string[];
  /** Session key for namespace/principal resolution. */
  sessionKey?: string;
  /** Authenticated principal (resolved by the service, never trusted raw). */
  principal?: string;
  /**
   * Caller-suggested namespace. ALWAYS re-resolved through the namespace
   * policy by the service before reaching the planner (rule 42). The
   * planner only sees the ALREADY-AUTHORIZED namespace.
   */
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Classification + actions
// ---------------------------------------------------------------------------

export type CorrectionClassification =
  | "wrong"
  | "outdated"
  | "incomplete"
  | "wrong_scope"
  | "never_store";

export const CORRECTION_CLASSIFICATIONS: readonly CorrectionClassification[] = [
  "wrong",
  "outdated",
  "incomplete",
  "wrong_scope",
  "never_store",
];

/**
 * A draft for a replacement memory (supersede action). Mirrors the subset of
 * {@link MemoryFrontmatter} a correction caller may legitimately set; the
 * executor fills in id/created/updated/source.
 */
export interface MemoryDraft {
  content: string;
  category?: MemoryCategory;
  confidence?: number;
  tags?: string[];
  entityRef?: string;
  /** Optional event-time anchor for bi-temporal supersession (#1578). */
  validAt?: string;
  /** Optional observed-at anchor for bi-temporal supersession (#1578). */
  observedAt?: string;
  structuredAttributes?: Record<string, string>;
}

/**
 * The known {@link MemoryCategory} values. A replacement/rescope category must
 * be one of these — rejecting path-like or unexpected strings before they reach
 * `StorageManager.writeMemory`, which incorporates the category into the
 * generated memory id/path (review thread Of-XJ).
 */
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "fact", "preference", "correction", "entity", "decision",
  "relationship", "principle", "commitment", "moment",
  "skill", "rule", "procedure", "reasoning_trace",
];

export type CorrectionAction =
  /** Outdated: a new fact replaces the loser. */
  | { kind: "supersede"; loserId: string; replacement?: MemoryDraft }
  /** Incomplete / minor-wrong: a versioned edit to an existing memory. */
  | { kind: "edit"; memoryId: string; patch: string }
  /** Wrong: retire + tombstone. */
  | { kind: "retract"; memoryId: string }
  /** Wrong scope: move to a different namespace. */
  | { kind: "rescope"; memoryId: string; toNamespace: string }
  /** Never-store: a future-extraction redaction rule. */
  | { kind: "redaction_rule"; pattern: string };

export const CORRECTION_ACTION_KINDS: readonly CorrectionAction["kind"][] = [
  "supersede",
  "edit",
  "retract",
  "rescope",
  "redaction_rule",
];

// ---------------------------------------------------------------------------
// Plan + outcome
// ---------------------------------------------------------------------------

/**
 * One affected memory in a plan: where it lives, an excerpt, why it is
 * affected, and (when available) the source quote that supports the
 * correction (#1575 provenance).
 */
export interface CorrectionAffectedEntry {
  memoryId: string;
  /** File path relative to the storage dir, for diff rendering. */
  path: string;
  excerpt: string;
  why: string;
  sourceQuote?: string;
}

/**
 * A persisted, expiring correction plan. Read-only artifact produced by the
 * planner; consumed (once) by the executor.
 */
export interface CorrectionPlan {
  planId: string;
  request: CorrectionRequest;
  /** Authorized namespace the plan is scoped to (resolved by the service). */
  namespace: string;
  affected: CorrectionAffectedEntry[];
  classification: CorrectionClassification;
  actions: CorrectionAction[];
  /** Human-readable diff preview rendered via page-versioning. */
  diff: string;
  /** Planner confidence in [0, 1]. `0` means manual selection required. */
  confidence: number;
  warnings: string[];
  createdAt: string;
  /** ISO timestamp after which apply rejects the plan as expired. */
  expiresAt: string;
  /**
   * Lifecycle: `pending` → `applying` → `applied`|`partial` (or `discarded`).
   * The executor flips a plan to `applying` BEFORE running any mutation
   * (review thread OgIqt): if the process dies mid-apply, the plan stays
   * `applying` and is NOT silently retryable — a partially-applied plan must
   * never be re-applied wholesale (it would duplicate succeeded actions).
   */
  status?: "pending" | "applying" | "applied" | "discarded" | "partial";
}

/**
 * Per-action outcome recorded by the executor. An action whose new-state
 * write failed is `failed`; the executor never destroys old state for a
 * failed action (rule 25 / checklist §14).
 */
export interface CorrectionActionResult {
  action: CorrectionAction;
  status: "applied" | "failed" | "skipped";
  /** For supersede: the new memory id. For edit: the memory id. */
  memoryId?: string;
  /** For supersede/retract: the emitted tombstone id (if any). */
  tombstoneId?: string;
  error?: string;
}

export interface CorrectionOutcome {
  planId: string;
  status: "applied" | "partial";
  results: CorrectionActionResult[];
  /** Audit-record memory id (corrections are themselves memories). */
  auditMemoryId: string;
  /** ISO timestamp of the apply. */
  appliedAt: string;
}

// ---------------------------------------------------------------------------
// Validation helpers (pure) — shared by planner, executor, and surface tests
// ---------------------------------------------------------------------------

/** Maximum supported `text` length. Surfaces bound this earlier; the planner
 *  re-validates so a direct-service caller cannot bypass. */
export const CORRECTION_TEXT_MAX = 10_000;

/** Maximum supported redaction pattern length (§34 — bounded patterns). */
export const REDACTION_PATTERN_MAX = 256;

/**
 * Validate a {@link CorrectionRequest}'s invariants. Returns the cleaned
 * request or throws with a field-specific message (rule 51 — list valid
 * options, never silently default).
 */
export function validateCorrectionRequest(request: CorrectionRequest): CorrectionRequest {
  if (!request || typeof request !== "object") {
    throw new CorrectionContractError("CorrectionRequest must be an object.");
  }
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (text.length === 0) {
    throw new CorrectionContractError("CorrectionRequest.text is required and must be non-empty.");
  }
  if (text.length > CORRECTION_TEXT_MAX) {
    throw new CorrectionContractError(
      `CorrectionRequest.text exceeds the ${CORRECTION_TEXT_MAX}-character limit (${text.length}).`,
    );
  }
  const targetIds = Array.isArray(request.targetIds)
    ? request.targetIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  if (targetIds !== undefined && targetIds.length === 0) {
    // An empty array is treated as "not provided" so callers can forward
    // optional fields without a separate presence flag.
    return {
      text,
      ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
      ...(request.principal ? { principal: request.principal } : {}),
      ...(request.namespace ? { namespace: request.namespace } : {}),
    };
  }
  return {
    text,
    ...(targetIds ? { targetIds } : {}),
    ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
    ...(request.principal ? { principal: request.principal } : {}),
    ...(request.namespace ? { namespace: request.namespace } : {}),
  };
}

/**
 * Validate a redaction pattern (§34 — bounded, literal-or-safe-regex; reject
 * catastrophic patterns). Returns the cleaned pattern or throws.
 */
export function validateRedactionPattern(pattern: string): string {
  if (typeof pattern !== "string") {
    throw new CorrectionContractError("redaction_rule.pattern must be a string.");
  }
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new CorrectionContractError("redaction_rule.pattern is required.");
  }
  if (trimmed.length > REDACTION_PATTERN_MAX) {
    throw new CorrectionContractError(
      `redaction_rule.pattern exceeds the ${REDACTION_PATTERN_MAX}-character bound.`,
    );
  }
  // Reject patterns that could match an unbounded string (overly-broad) OR
  // exhibit catastrophic backtracking (nested quantifiers like `(a+)+`). We do
  // NOT execute the regex (that would be ReDoS itself); we only inspect shape.
  if (isRegexLike(trimmed) && isUnsafeRedactionRegex(trimmed)) {
    throw new CorrectionContractError(
      "redaction_rule.pattern is unsafe — use a bounded literal or a regex without nested quantifiers / overlapping alternation.",
    );
  }
  return trimmed;
}

/** Heuristic: treat `/.../` or presence of regex metacharacters as regex. */
function isRegexLike(pattern: string): boolean {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2) return true;
  return /[\\^$.|?*+()[\]{}]/.test(pattern);
}

/**
 * Reject a regex that would either match an arbitrary-length run of any
 * character (overly-broad) OR exhibit catastrophic backtracking (ReDoS).
 * Mirrors the safe-regex heuristic in extraction-redaction-rules.ts so the
 * apply-time chokepoint and the extraction-time defense agree on what is
 * pathological — intentionally not imported to keep the two modules decoupled
 * (contract owns validation; extraction owns consultation).
 */
function isUnsafeRedactionRegex(pattern: string): boolean {
  const body = pattern.startsWith("/") && pattern.endsWith("/")
    ? pattern.slice(1, -1)
    : pattern;
  // `.*`, `.+`, `.`, or `(.*)` etc. anywhere → overly broad.
  if (/(?:^|[^\\])\(\.\*\)|(?:^|[^\\])\.\*|(?:^|[^\\])\.\+|^\.([^*+]?)$/.test(body)) {
    return true;
  }
  // Nested quantifier: a group (...) whose body ends with a quantifier and
  // which is itself quantified → exponential blowup on near-miss inputs
  // (classic ReDoS shapes: (a+)+, (a*)*, (a?)+). Also catches overlapping
  // alternation under repetition: (a|a)+ where branches share a prefix.
  if (body.length > 512) return true;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "(") continue;
    let depth = 1;
    let j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === "\\") { j += 2; continue; }
      if (body[j] === "(") depth++;
      else if (body[j] === ")") depth--;
      j++;
    }
    if (depth !== 0) continue;
    const afterGroup = body[j];
    if (afterGroup !== "+" && afterGroup !== "*" && afterGroup !== "{") continue;
    const groupBody = body.slice(i + 1, j - 1);
    if (/[+*?]$/.test(groupBody) || /\{\d+,?\d*\}[+*?]?$/.test(groupBody)) {
      return true;
    }
    if (groupBody.includes("|")) {
      const branches = groupBody.split("|");
      if (branches.length >= 2) {
        const firstChars = new Set(branches.map((b) => b[0]).filter(Boolean));
        if (firstChars.size < branches.filter((b) => b.length > 0).length) {
          return true;
        }
      }
    }
    i = j;
  }
  return false;
}

/**
 * Validate the shape of a {@link CorrectionAction}. Used by the executor
 * before applying and by the surface layer to reject malformed client input
 * (rule 51 — list valid kinds).
 */
export function validateCorrectionAction(action: unknown): asserts action is CorrectionAction {
  if (!action || typeof action !== "object") {
    throw new CorrectionContractError("CorrectionAction must be an object.");
  }
  const a = action as Record<string, unknown>;
  if (typeof a.kind !== "string" || !CORRECTION_ACTION_KINDS.includes(a.kind as CorrectionAction["kind"])) {
    throw new CorrectionContractError(
      `CorrectionAction.kind must be one of: ${CORRECTION_ACTION_KINDS.join(", ")}.`,
    );
  }
  switch (a.kind) {
    case "supersede":
      if (typeof a.loserId !== "string" || a.loserId.length === 0) {
        throw new CorrectionContractError("supersede.loserId is required.");
      }
      if (a.replacement !== undefined && a.replacement !== null) {
        validateMemoryDraft(a.replacement);
      }
      break;
    case "edit":
      if (typeof a.memoryId !== "string" || a.memoryId.length === 0) {
        throw new CorrectionContractError("edit.memoryId is required.");
      }
      if (typeof a.patch !== "string" || a.patch.length === 0) {
        throw new CorrectionContractError("edit.patch is required and must be non-empty.");
      }
      break;
    case "retract":
      if (typeof a.memoryId !== "string" || a.memoryId.length === 0) {
        throw new CorrectionContractError("retract.memoryId is required.");
      }
      break;
    case "rescope":
      if (typeof a.memoryId !== "string" || a.memoryId.length === 0) {
        throw new CorrectionContractError("rescope.memoryId is required.");
      }
      if (typeof a.toNamespace !== "string" || a.toNamespace.trim().length === 0) {
        throw new CorrectionContractError("rescope.toNamespace is required.");
      }
      break;
    case "redaction_rule":
      if (typeof a.pattern !== "string") {
        throw new CorrectionContractError("redaction_rule.pattern is required.");
      }
      validateRedactionPattern(a.pattern);
      break;
  }
}

/** Validate a {@link MemoryDraft}. Throws on invalid shape. */
export function validateMemoryDraft(draft: unknown): asserts draft is MemoryDraft {
  if (!draft || typeof draft !== "object") {
    throw new CorrectionContractError("MemoryDraft must be an object.");
  }
  const d = draft as Record<string, unknown>;
  if (typeof d.content !== "string" || d.content.trim().length === 0) {
    throw new CorrectionContractError("MemoryDraft.content is required and must be non-empty.");
  }
  if (d.category !== undefined) {
    if (typeof d.category !== "string" || !(MEMORY_CATEGORIES as readonly string[]).includes(d.category)) {
      throw new CorrectionContractError(
        `MemoryDraft.category must be one of: ${MEMORY_CATEGORIES.join(", ")}.`,
      );
    }
  }
  if (d.confidence !== undefined && (typeof d.confidence !== "number" || d.confidence < 0 || d.confidence > 1)) {
    throw new CorrectionContractError("MemoryDraft.confidence must be a number in [0, 1].");
  }
  if (d.tags !== undefined && !Array.isArray(d.tags)) {
    throw new CorrectionContractError("MemoryDraft.tags must be an array.");
  }
  if (d.structuredAttributes !== undefined && (typeof d.structuredAttributes !== "object" || d.structuredAttributes === null)) {
    throw new CorrectionContractError("MemoryDraft.structuredAttributes must be an object.");
  }
}

/**
 * Deterministic fallback plan (rule 13): when the planner's LLM is
 * unavailable, the plan degrades to a search result, never an error page.
 * Classification `outdated`, confidence `0`, actions empty.
 */
export function deterministicFallbackPlan(args: {
  request: CorrectionRequest;
  namespace: string;
  affected: CorrectionAffectedEntry[];
  warnings: string[];
  createdAt: string;
  expiresAt: string;
}): CorrectionPlan {
  return {
    planId: newPlanId(),
    request: args.request,
    namespace: args.namespace,
    affected: args.affected,
    classification: "outdated",
    actions: [],
    diff: "",
    confidence: 0,
    warnings: [...args.warnings, "planner LLM unavailable — manual action selection required"],
    createdAt: args.createdAt,
    expiresAt: args.expiresAt,
    status: "pending",
  };
}

/** Generate a stable plan id. Exposed for tests + deterministic fallback. */
export function newPlanId(): string {
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Error class for contract violations. Surfaces map it to a 400 / input error. */
export class CorrectionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionContractError";
  }
}
