/**
 * Host-agnostic active-context SUMMARY/FILTER plans (issue #2347).
 *
 * Core receives a short message list, checks the trusted scope first,
 * then IDs and limits, and returns a content-addressed plan. Core never
 * mutates host state or saved memory: the host adapter owns save, apply,
 * and undo; it reports back through {@link ActiveContextApplyReceipt}.
 * Plans and telemetry carry hashes and counts only — never raw message
 * text, keep rules, or summary output.
 *
 * Paper basis: AgeMem (arXiv:2601.01885v3) §3.1/A.1 eq. (14) Summary and
 * eq. (15) Filter. Selection is host-bounded (explicit IDs or one closed
 * span); `all` / last-N spans are never inferred. Filter keeps messages
 * with `score >= threshold` using a caller-supplied fixed score rule — an
 * LLM never picks drop IDs. Event counts back the design; no ship claim.
 */
import { createHash } from "node:crypto";
import { DEFAULT_ACTIVE_CONTEXT_CAPS, type ActiveContextCapabilitySet } from "./active-context-config.js";
import {
  ContextSummaryUnavailableError,
  summarizeContextPure,
  type SummarizeFn,
} from "./context-summary.js";
import { evaluateActiveContextTransformPolicy } from "./memory-action-policy.js";

export const ACTIVE_CONTEXT_ALGORITHM_VERSION = "active-context-transform/1";
export const ACTIVE_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1;
export const ACTIVE_CONTEXT_PLAN_SCHEMA_VERSION = 1;
export const ACTIVE_CONTEXT_RECEIPT_SCHEMA_VERSION = 1;
export const ACTIVE_CONTEXT_RECORD_SCHEMA_VERSION = 1;

export type ActiveContextOperation = "SUMMARY" | "FILTER";
export type ActiveContextPhase = "plan" | "prepare";
export type ActiveContextMessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export type ActiveContextErrorCode =
  | "feature_disabled"
  | "scope_mismatch"
  | "invalid_request"
  | "stale_context"
  | "plan_conflict"
  | "preserve_conflict"
  | "filter_unavailable"
  | "summary_unavailable"
  | "unsupported"
  | "retention_unavailable"
  | "retention_expired"
  | "invalid_receipt"
  | "host_error";

/** Roles that can never be removed by any operation or selector. */
const PROTECTED_ROLES: Record<string, true> = { system: true, developer: true };

export interface ActiveContextMessage {
  id: string;
  /** Snapshot order; plans sort by it and never reorder sources. */
  ordinal: number;
  role: ActiveContextMessageRole;
  content: string;
  /** Caller-marked protection; equivalent to a preserve-listed ID. */
  protected?: boolean;
}

export interface ActiveContextSnapshot {
  schemaVersion: 1;
  sessionKey: string;
  /** Data routing only — never authorization. */
  namespace: string;
  /** Host revision/turn identifier the plan binds as a precondition. */
  revision: string | number;
  messages: ActiveContextMessage[];
}

/**
 * Trusted scope resolved by the access layer BEFORE any plan work
 * (mirrors `ResolvedIdentity` from adapters/types.ts). Core never treats
 * `snapshot.namespace` as auth.
 */
export interface ActiveContextResolvedScope {
  sessionKey: string;
  namespace: string;
  principal: string;
  adapterId: string;
}

/** Fixed, caller-supplied score rule. Must return a finite score in [0,1]. */
export type ActiveContextScoreMessageFn = (message: ActiveContextMessage) => number | undefined;

export interface ActiveContextTransformDeps {
  resolvedScope: ActiveContextResolvedScope;
  /** Filter score rule — required for FILTER plans. */
  scoreMessage?: ActiveContextScoreMessageFn;
  /** Model seam for SUMMARY; the same pure seam LCM uses. */
  summarize?: SummarizeFn;
  /** Config-projected caps; defaults are conservative (see capabilities.ts). */
  caps?: ActiveContextCapabilitySet;
  /** Gate override; defaults to `caps.activeContextTransforms`. */
  actionsEnabled?: boolean;
  /** Clock seam for deterministic expiry tests. */
  now?: () => Date;
}

export interface ActiveContextSpanSelector {
  /** Closed span: inclusive start (by snapshot order). */
  startMessageId: string;
  /** Closed span: inclusive end (by snapshot order). */
  endMessageId: string;
}

export interface ActiveContextTransformRequest {
  schemaVersion: 1;
  operation: ActiveContextOperation;
  phase: ActiveContextPhase;
  snapshot: ActiveContextSnapshot;
  /** Exactly one of `messageIds` or `span`. */
  selector: { messageIds?: string[]; span?: ActiveContextSpanSelector };
  preserve?: {
    messageIds?: string[];
    roles?: ActiveContextMessageRole[];
    minRetainedMessages?: number;
  };
  summary?: { method: "deterministic" | "llm" | "auto"; targetTokens?: number };
  filter?: { keepCriterion: string; threshold: number };
  expectedRevision?: string | number;
  requestId?: string;
  sourcePromptHash?: string;
}

export interface ActiveContextScoreRow {
  messageId: string;
  score: number;
  decision: "keep" | "drop";
}

export interface ActiveContextPlanReplacement {
  messageId: string;
  /** Filled by prepare — plans never carry raw text. */
  contentHash?: string;
  sourceMessageIds: string[];
  method: "deterministic" | "llm";
  /** Whether prepare may degrade to deterministic output (auto mode only). */
  fallbackPolicy: "allowed" | "none";
  targetTokens: number;
  modelUsed?: string;
  fallback?: boolean;
}

export interface ActiveContextTransformPlan {
  schemaVersion: 1;
  planId: string;
  planHash: string;
  operation: ActiveContextOperation;
  status: "ready" | "rejected";
  errorCode?: ActiveContextErrorCode;
  precondition: {
    principal: string;
    sessionKey: string;
    namespace: string;
    adapterId: string;
    snapshotRevision: string | number;
    expiresAt: string;
  };
  /** Selected sources in snapshot order. */
  selectedMessageIds: string[];
  /** Messages that stay after the plan applies. */
  retainedMessageIds: string[];
  /** Removable IDs the plan proposes to drop or fold into a replacement. */
  proposedRemovalIds: string[];
  scoreRows?: ActiveContextScoreRow[];
  replacement?: ActiveContextPlanReplacement;
  preserve: { protectedMessageIds: string[]; minimumRetainedMessages: number };
  inverse: {
    kind: "restore-source-message-ids";
    sourceMessageIds: string[];
    removeReplacementMessageId?: string;
    expectedAppliedPlanHash?: string;
  };
  retention: {
    planId: string;
    mode: "adapter-local";
    expiresAt: string;
    maxBytes: number;
    snapshotContentHash: string;
  };
  provenance: {
    algorithmVersion: string;
    selectorHash: string;
    snapshotContentHash: string;
    criterionHash?: string;
    sourcePromptHash?: string;
    generatedAt: string;
  };
  policy: { decision: "allow" | "deny"; rationale: string };
}

export interface ActiveContextHostCapability {
  capabilityId: string;
  trustedScope: ActiveContextResolvedScope;
  hostRevision: string | number;
  operations: ActiveContextOperation[];
  expiresAt: string;
}

export interface ActiveContextApplyReceipt {
  schemaVersion: 1;
  planId: string;
  planHash: string;
  adapterId: string;
  outcome: "applied" | "skipped" | "failed";
  errorCode?: ActiveContextErrorCode;
  hostRevisionBefore?: string | number;
  hostRevisionAfter?: string | number;
  appliedMessageIds?: string[];
  removedMessageIds?: string[];
  replacementMessageId?: string;
  retentionExpiresAt?: string;
  appliedAt: string;
}

/** Discriminated ledger record appended to `state/memory-actions.jsonl`. */
export interface ContextTransformTelemetryRecord {
  recordKind: "context_transform";
  schemaVersion: 1;
  timestamp: string;
  /** Plan ID doubles as the record action ID. */
  actionId: string;
  action: "summarize_context" | "filter_context";
  outcome: "applied" | "skipped" | "failed";
  status: "validated" | "applied" | "rejected";
  actor?: string;
  subsystem: string;
  namespace: string;
  sourceSessionKey: string;
  planHash: string;
  snapshotRevision: string | number;
  adapterId?: string;
  algorithmVersion?: string;
  selectedCount: number;
  retainedCount: number;
  proposedRemovalCount: number;
  receiptOutcome?: "applied" | "skipped" | "failed";
  selectorHash: string;
  snapshotContentHash: string;
  criterionHash?: string;
  sourcePromptHash?: string;
  replacementContentHash?: string;
  policyDecision?: "allow" | "defer" | "deny";
  policyRationale?: string;
  telemetryRecorded?: boolean;
}

export interface ActiveContextPreparedReplacement {
  messageId: string;
  text: string;
  contentHash: string;
  method: "deterministic" | "llm";
  modelUsed?: string;
  fallback: boolean;
  sourceMessageIds: string[];
}

export interface ActiveContextPreparedTransform {
  status: "ready" | "rejected" | "failed";
  plan: ActiveContextTransformPlan;
  replacement?: ActiveContextPreparedReplacement;
  errorCode?: ActiveContextErrorCode;
}

// ── hashing ────────────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic JSON: sorted keys, so field order never changes a hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

function hashSnapshot(snapshot: ActiveContextSnapshot): string {
  return sha256Hex(
    canonicalJson({
      namespace: snapshot.namespace,
      revision: snapshot.revision,
      sessionKey: snapshot.sessionKey,
      messages: snapshot.messages.map((m) => ({
        contentHash: sha256Hex(m.content),
        id: m.id,
        ordinal: m.ordinal,
        role: m.role,
      })),
    }),
  );
}

// ── shared validation ──────────────────────────────────────────────────────

interface PlanContext {
  caps: ActiveContextCapabilitySet;
  scope: ActiveContextResolvedScope;
  snapshotRevision: string | number;
  byId: Map<string, ActiveContextMessage>;
  ordered: ActiveContextMessage[];
  snapshotContentHash: string;
  generatedAt: string;
  expiresAt: string;
}

const VALID_PHASES: Record<string, true> = { plan: true, prepare: true };
const VALID_ROLES: Record<string, true> = {
  system: true,
  developer: true,
  user: true,
  assistant: true,
  tool: true,
};

function rejectedPlan(
  operation: ActiveContextOperation,
  errorCode: ActiveContextErrorCode,
  context: PlanContext | null,
  policy: { decision: "allow" | "deny"; rationale: string },
): ActiveContextTransformPlan {
  const planId = `actx-rejected-${sha256Hex(`${operation}:${errorCode}:${policy.rationale}`).slice(0, 12)}`;
  return {
    schemaVersion: ACTIVE_CONTEXT_PLAN_SCHEMA_VERSION,
    planId,
    planHash: sha256Hex(canonicalJson({ planId, errorCode, operation })),
    operation,
    status: "rejected",
    errorCode,
    precondition: context
      ? {
          principal: context.scope.principal,
          sessionKey: context.scope.sessionKey,
          namespace: context.scope.namespace,
          adapterId: context.scope.adapterId,
          snapshotRevision: context.snapshotRevision,
          expiresAt: context.expiresAt,
        }
      : {
          principal: "",
          sessionKey: "",
          namespace: "",
          adapterId: "",
          snapshotRevision: "",
          expiresAt: "",
        },
    selectedMessageIds: [],
    retainedMessageIds: [],
    proposedRemovalIds: [],
    preserve: { protectedMessageIds: [], minimumRetainedMessages: 0 },
    inverse: { kind: "restore-source-message-ids", sourceMessageIds: [] },
    retention: {
      planId,
      mode: "adapter-local",
      expiresAt: "",
      maxBytes: 0,
      snapshotContentHash: context?.snapshotContentHash ?? "",
    },
    provenance: {
      algorithmVersion: ACTIVE_CONTEXT_ALGORITHM_VERSION,
      selectorHash: "",
      snapshotContentHash: context?.snapshotContentHash ?? "",
      generatedAt: context?.generatedAt ?? new Date().toISOString(),
    },
    policy,
  };
}

/** Scope + snapshot validation shared by plan and prepare. Throws PlanReject. */
class PlanReject extends Error {
  constructor(readonly code: ActiveContextErrorCode) {
    super(code);
  }
}

function buildContext(
  request: ActiveContextTransformRequest,
  deps: ActiveContextTransformDeps,
): PlanContext {
  const caps = deps.caps ?? {
    ...DEFAULT_ACTIVE_CONTEXT_CAPS,
    activeContextTransforms: true,
    activeContextLlm: false,
  };
  const scope = deps.resolvedScope;
  if (!scope || !scope.sessionKey || !scope.namespace || !scope.principal || !scope.adapterId) {
    throw new PlanReject("scope_mismatch");
  }
  // Trusted-scope checks run before any ID selection or model work.
  if (request.snapshot.sessionKey !== scope.sessionKey) throw new PlanReject("scope_mismatch");
  if (request.snapshot.namespace !== scope.namespace) throw new PlanReject("scope_mismatch");

  const snapshot = request.snapshot;
  if (snapshot.schemaVersion !== ACTIVE_CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
    throw new PlanReject("invalid_request");
  }
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
    throw new PlanReject("invalid_request");
  }
  const byId = new Map<string, ActiveContextMessage>();
  let totalChars = 0;
  for (const message of snapshot.messages) {
    if (
      typeof message?.id !== "string" ||
      message.id.length === 0 ||
      typeof message.content !== "string" ||
      VALID_ROLES[message.role] !== true
    ) {
      throw new PlanReject("invalid_request");
    }
    if (byId.has(message.id)) throw new PlanReject("invalid_request"); // duplicate IDs
    byId.set(message.id, message);
    totalChars += message.content.length;
  }
  if (snapshot.messages.length > caps.activeContextMaxMessages) throw new PlanReject("invalid_request");
  if (totalChars > caps.activeContextMaxSnapshotChars) throw new PlanReject("invalid_request");

  const now = (deps.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + caps.activeContextPlanTtlMinutes * 60_000).toISOString();
  return {
    caps,
    scope,
    snapshotRevision: snapshot.revision,
    byId,
    ordered: [...snapshot.messages].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)),
    snapshotContentHash: hashSnapshot(snapshot),
    generatedAt,
    expiresAt,
  };
}

/** Resolve the selector to ordered source messages. Exactly one form allowed. */
function resolveSelection(
  request: ActiveContextTransformRequest,
  context: PlanContext,
): ActiveContextMessage[] {
  const messageIds = request.selector?.messageIds;
  const span = request.selector?.span;
  const hasIds = Array.isArray(messageIds) && messageIds.length > 0;
  if (hasIds === (span !== undefined)) throw new PlanReject("invalid_request"); // both or neither

  if (hasIds && messageIds) {
    const seen = new Set<string>();
    const picked: ActiveContextMessage[] = [];
    for (const id of messageIds) {
      if (seen.has(id)) throw new PlanReject("invalid_request"); // duplicate IDs
      seen.add(id);
      const message = context.byId.get(id);
      if (!message) throw new PlanReject("invalid_request"); // unknown IDs
      picked.push(message);
    }
    return picked.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)); // snapshot order
  }

  if (!span) throw new PlanReject("invalid_request");
  const { startMessageId, endMessageId } = span;
  const start = context.byId.get(startMessageId);
  const end = context.byId.get(endMessageId);
  if (!start || !end) throw new PlanReject("invalid_request");
  if (start.ordinal > end.ordinal) throw new PlanReject("invalid_request"); // inverted span
  const inSpan = context.ordered.filter(
    (m) => m.ordinal >= start.ordinal && m.ordinal <= end.ordinal, // closed and full
  );
  if (inSpan.length === 0) throw new PlanReject("invalid_request"); // empty span
  return inSpan;
}

function protectedIdSet(
  request: ActiveContextTransformRequest,
  context: PlanContext,
): Set<string> {
  const protectedIds = new Set<string>();
  for (const message of context.ordered) {
    if (PROTECTED_ROLES[message.role] === true || message.protected === true) {
      protectedIds.add(message.id);
    }
  }
  for (const role of request.preserve?.roles ?? []) {
    if (PROTECTED_ROLES[role] === true) continue;
    for (const message of context.ordered) {
      if (message.role === role) protectedIds.add(message.id);
    }
  }
  for (const id of request.preserve?.messageIds ?? []) {
    if (context.byId.has(id)) protectedIds.add(id);
  }
  return protectedIds;
}

// ── plan ───────────────────────────────────────────────────────────────────

/**
 * Build one bounded, content-addressed SUMMARY or FILTER plan. Returns a
 * rejected plan (with a stable error code) instead of throwing on bad
 * input — bad input is never hidden behind a no-op. `planHash` binds the
 * scope, revision, and every selected/removal/replacement ID; replay
 * across principal, session, namespace, adapter, or revision therefore
 * fails the adapter's comparisons before retain, apply, or undo.
 */
export function planActiveContextTransform(
  request: ActiveContextTransformRequest,
  deps: ActiveContextTransformDeps,
): ActiveContextTransformPlan {
  const caps =
    deps.caps ?? { ...DEFAULT_ACTIVE_CONTEXT_CAPS, activeContextTransforms: true, activeContextLlm: false };
  const policy = evaluateActiveContextTransformPolicy({
    actionsEnabled: deps.actionsEnabled ?? caps.activeContextTransforms,
    operation: request.operation,
  });
  if (policy.decision === "deny") {
    // feature_disabled — evaluated before scope or selection work.
    return rejectedPlan(request.operation, "feature_disabled", null, policy);
  }
  let context: PlanContext | null = null;
  try {
    if (request.schemaVersion !== ACTIVE_CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
      throw new PlanReject("invalid_request");
    }
    if (request.operation !== "SUMMARY" && request.operation !== "FILTER") {
      throw new PlanReject("invalid_request");
    }
    if (VALID_PHASES[request.phase] !== true) throw new PlanReject("invalid_request");
    context = buildContext(request, deps);

    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== request.snapshot.revision
    ) {
      throw new PlanReject("stale_context");
    }

    const selected = resolveSelection(request, context);
    const protectedIds = protectedIdSet(request, context);
    const removable = selected.filter((m) => !protectedIds.has(m.id));
    if (removable.length === 0) {
      throw new PlanReject("preserve_conflict"); // nothing chosen is removable
    }

    const minimumRetained = Math.max(
      1,
      request.preserve?.minRetainedMessages ?? caps.activeContextMinRetainedMessages,
    );
    const idList = (messages: ActiveContextMessage[]) => messages.map((m) => m.id);
    const allIds = idList(context.ordered);
    const selectorHash = sha256Hex(canonicalJson(request.selector ?? {}));

    if (request.operation === "FILTER") {
      return buildFilterPlan(request, deps, context, {
        selected,
        removable,
        protectedIds,
        minimumRetained,
        allIds,
        selectorHash,
        policy,
      });
    }
    return buildSummaryPlan(request, deps, context, {
      selected,
      removable,
      protectedIds,
      minimumRetained,
      allIds,
      selectorHash,
      policy,
    });
  } catch (err) {
    if (err instanceof PlanReject) {
      return rejectedPlan(request.operation, err.code, context, policy);
    }
    throw err;
  }
}

interface SelectionBundle {
  selected: ActiveContextMessage[];
  removable: ActiveContextMessage[];
  protectedIds: Set<string>;
  minimumRetained: number;
  allIds: string[];
  selectorHash: string;
  policy: { decision: "allow" | "deny"; rationale: string };
}

function finalizePlan(
  operation: ActiveContextOperation,
  context: PlanContext,
  bundle: SelectionBundle,
  proposedRemovalIds: string[],
  extras: {
    scoreRows?: ActiveContextScoreRow[];
    replacement?: ActiveContextPlanReplacement;
    criterionHash?: string;
    sourcePromptHash?: string;
  },
): ActiveContextTransformPlan {
  const retainedIds = bundle.allIds.filter((id) => !proposedRemovalIds.includes(id));
  if (retainedIds.length < bundle.minimumRetained) {
    throw new PlanReject("preserve_conflict"); // below keep floor / no safe message left
  }
  const sourceMessageIds = bundle.removable.map((m) => m.id);
  const precondition = {
    principal: context.scope.principal,
    sessionKey: context.scope.sessionKey,
    namespace: context.scope.namespace,
    adapterId: context.scope.adapterId,
    snapshotRevision: context.snapshotRevision,
    expiresAt: context.expiresAt,
  };
  const provenance = {
    algorithmVersion: ACTIVE_CONTEXT_ALGORITHM_VERSION,
    selectorHash: bundle.selectorHash,
    snapshotContentHash: context.snapshotContentHash,
    ...(extras.criterionHash ? { criterionHash: extras.criterionHash } : {}),
    ...(extras.sourcePromptHash ? { sourcePromptHash: extras.sourcePromptHash } : {}),
    generatedAt: context.generatedAt,
  };
  const planId = `actx-${sha256Hex(
    canonicalJson({
      adapterId: precondition.adapterId,
      criterionHash: extras.criterionHash,
      namespace: precondition.namespace,
      operation,
      principal: precondition.principal,
      selectorHash: bundle.selectorHash,
      sessionKey: precondition.sessionKey,
      snapshotContentHash: context.snapshotContentHash,
    }),
  ).slice(0, 16)}`;
  const planBody = {
    operation,
    planId,
    precondition,
    proposedRemovalIds,
    replacementMessageId: extras.replacement?.messageId,
    replacementSourceIds: extras.replacement?.sourceMessageIds,
    retainedIds,
    selectedIds: bundle.selected.map((m) => m.id),
  };
  const planHash = sha256Hex(canonicalJson(planBody));
  return {
    schemaVersion: ACTIVE_CONTEXT_PLAN_SCHEMA_VERSION,
    planId,
    planHash,
    operation,
    status: "ready",
    precondition,
    selectedMessageIds: planBody.selectedIds,
    retainedMessageIds: retainedIds,
    proposedRemovalIds,
    ...(extras.scoreRows ? { scoreRows: extras.scoreRows } : {}),
    ...(extras.replacement ? { replacement: extras.replacement } : {}),
    preserve: {
      protectedMessageIds: [...bundle.protectedIds],
      minimumRetainedMessages: bundle.minimumRetained,
    },
    inverse: {
      kind: "restore-source-message-ids",
      sourceMessageIds,
      ...(extras.replacement ? { removeReplacementMessageId: extras.replacement.messageId } : {}),
      expectedAppliedPlanHash: planHash,
    },
    retention: {
      planId,
      mode: "adapter-local",
      expiresAt: context.expiresAt,
      maxBytes: context.caps.activeContextRetentionMaxBytes,
      snapshotContentHash: context.snapshotContentHash,
    },
    provenance,
    policy: bundle.policy,
  };
}

function buildFilterPlan(
  request: ActiveContextTransformRequest,
  deps: ActiveContextTransformDeps,
  context: PlanContext,
  bundle: SelectionBundle,
): ActiveContextTransformPlan {
  const filter = request.filter;
  if (!filter || typeof filter.keepCriterion !== "string" || filter.keepCriterion.length === 0) {
    throw new PlanReject("invalid_request"); // Filter needs keepCriterion
  }
  const threshold = filter.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new PlanReject("invalid_request"); // fixed limit in [0,1], never defaulted
  }
  if (!deps.scoreMessage) {
    throw new PlanReject("filter_unavailable"); // Filter needs a score function
  }

  const scoreRows: ActiveContextScoreRow[] = [];
  const removalIds: string[] = [];
  for (const message of bundle.removable) {
    const score = deps.scoreMessage(message);
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new PlanReject("filter_unavailable"); // missing / NaN / out of range
    }
    const decision = score >= threshold ? "keep" : "drop"; // fixed keep rule
    scoreRows.push({ messageId: message.id, score, decision });
    if (decision === "drop") removalIds.push(message.id);
  }

  return finalizePlan("FILTER", context, bundle, removalIds, {
    scoreRows,
    criterionHash: sha256Hex(filter.keepCriterion), // hash, never the rule text
    sourcePromptHash: request.sourcePromptHash,
  });
}

function buildSummaryPlan(
  request: ActiveContextTransformRequest,
  deps: ActiveContextTransformDeps,
  context: PlanContext,
  bundle: SelectionBundle,
): ActiveContextTransformPlan {
  const requested = request.summary?.method ?? "deterministic";
  const llmEnabled = context.caps.activeContextLlm;
  let method: "deterministic" | "llm";
  let fallbackPolicy: "allowed" | "none";
  if (requested === "deterministic") {
    method = "deterministic";
    fallbackPolicy = "none";
  } else if (requested === "llm") {
    if (!llmEnabled) throw new PlanReject("unsupported"); // explicit llm behind a closed gate
    method = "llm";
    fallbackPolicy = "none"; // fallback only in auto mode
  } else {
    // auto: prefer the LLM seam when allowed; deterministic otherwise.
    method = llmEnabled && deps.summarize ? "llm" : "deterministic";
    fallbackPolicy = method === "llm" ? "allowed" : "none";
  }

  const requestedTokens = request.summary?.targetTokens ?? context.caps.activeContextSummaryMaxTokens;
  if (
    typeof requestedTokens !== "number" ||
    !Number.isFinite(requestedTokens) ||
    requestedTokens <= 0 ||
    requestedTokens > context.caps.activeContextSummaryMaxTokens
  ) {
    throw new PlanReject("invalid_request");
  }
  const targetTokens = Math.floor(requestedTokens);

  // planId is derived inside finalizePlan; the replacement ID must be stable
  // relative to it, so derive from the same stable inputs.
  const replacementSeed = sha256Hex(
    canonicalJson({
      operation: "SUMMARY",
      selectorHash: bundle.selectorHash,
      snapshotContentHash: context.snapshotContentHash,
      sessionKey: context.scope.sessionKey,
      namespace: context.scope.namespace,
      principal: context.scope.principal,
      adapterId: context.scope.adapterId,
    }),
  );
  const replacement: ActiveContextPlanReplacement = {
    messageId: `actxr-${replacementSeed.slice(0, 16)}`,
    sourceMessageIds: bundle.removable.map((m) => m.id),
    method,
    fallbackPolicy,
    targetTokens,
  };

  const plan = finalizePlan("SUMMARY", context, bundle, [...replacement.sourceMessageIds], {
    replacement,
    sourcePromptHash: request.sourcePromptHash,
  });
  return plan;
}

// ── prepare ────────────────────────────────────────────────────────────────

/**
 * Produce the SUMMARY replacement text for a ready plan through the pure
 * summary seam (context-summary.ts). Never calls `LcmSummarizer`. FILTER
 * plans pass through unchanged after revalidation. The caller must supply
 * the same snapshot the plan was built from; a changed transcript fence
 * rejects with `plan_conflict`.
 */
export async function prepareActiveContextTransform(
  plan: ActiveContextTransformPlan,
  deps: ActiveContextTransformDeps & { snapshot: ActiveContextSnapshot },
): Promise<ActiveContextPreparedTransform> {
  if (plan.status !== "ready") {
    return { status: "rejected", plan, errorCode: plan.errorCode ?? "invalid_request" };
  }

  const scope = deps.resolvedScope;
  const p = plan.precondition;
  if (
    !scope ||
    scope.principal !== p.principal ||
    scope.sessionKey !== p.sessionKey ||
    scope.namespace !== p.namespace ||
    scope.adapterId !== p.adapterId
  ) {
    return { status: "rejected", plan, errorCode: "scope_mismatch" };
  }
  const now = deps.now?.() ?? new Date();
  if (now.getTime() >= new Date(plan.retention.expiresAt).getTime()) {
    return { status: "rejected", plan, errorCode: "stale_context" }; // expired plan
  }
  if (deps.snapshot.sessionKey !== p.sessionKey || deps.snapshot.namespace !== p.namespace) {
    return { status: "rejected", plan, errorCode: "scope_mismatch" };
  }
  const fenceHash = hashSnapshot(deps.snapshot);
  if (fenceHash !== plan.provenance.snapshotContentHash) {
    return { status: "rejected", plan, errorCode: "plan_conflict" }; // changed fence
  }

  if (plan.operation === "FILTER") {
    return { status: "ready", plan };
  }

  const replacement = plan.replacement;
  if (!replacement) {
    return { status: "failed", plan, errorCode: "invalid_request" };
  }
  const byId = new Map(deps.snapshot.messages.map((m) => [m.id, m] as const));
  const sourceText = replacement.sourceMessageIds
    .map((id) => byId.get(id))
    .filter((m): m is ActiveContextMessage => m !== undefined)
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
    .map((m) => m.content)
    .join("\n\n"); // exact order, exact text

  const method =
    replacement.method === "deterministic"
      ? "deterministic"
      : replacement.fallbackPolicy === "allowed"
        ? "auto"
        : "llm";
  try {
    const result = await summarizeContextPure(sourceText, replacement.targetTokens, method, {
      llm: deps.summarize,
      deterministicMaxTokens: deps.caps?.activeContextSummaryMaxTokens ?? replacement.targetTokens,
    });
    if (result.text.trim().length === 0) {
      return { status: "failed", plan, errorCode: "summary_unavailable" }; // bad model text
    }
    return {
      status: "ready",
      plan,
      replacement: {
        messageId: replacement.messageId,
        text: result.text,
        contentHash: sha256Hex(result.text),
        method: result.method,
        ...(result.modelUsed ? { modelUsed: result.modelUsed } : {}),
        fallback: result.fallback,
        sourceMessageIds: replacement.sourceMessageIds,
      },
    };
  } catch (err) {
    if (err instanceof ContextSummaryUnavailableError) {
      return { status: "failed", plan, errorCode: "summary_unavailable" };
    }
    throw err;
  }
}

// ── receipts and telemetry ─────────────────────────────────────────────────

/**
 * Validate a host receipt against the plan's bindings and append one
 * context record to the ledger. Order of checks: scope → hash → revision →
 * shape. One-time use is enforced by the adapter's persisted apply/undo
 * markers (retention store); this recorder appends only. A ledger write
 * failure returns `recorded: false` and never fabricates an apply.
 */
export async function recordActiveContextApplyReceipt(
  plan: ActiveContextTransformPlan,
  receipt: ActiveContextApplyReceipt,
  trustedScope: ActiveContextResolvedScope,
  recorder: {
    append(record: ContextTransformTelemetryRecord): Promise<boolean>;
  },
): Promise<{ recorded: boolean; event: ContextTransformTelemetryRecord }> {
  const p = plan.precondition;
  const scopeMatch =
    trustedScope.principal === p.principal &&
    trustedScope.sessionKey === p.sessionKey &&
    trustedScope.namespace === p.namespace &&
    trustedScope.adapterId === p.adapterId &&
    receipt.adapterId === trustedScope.adapterId;
  if (!scopeMatch) throw new PlanReject("scope_mismatch");
  if (receipt.planHash !== plan.planHash) throw new PlanReject("plan_conflict"); // bad hash
  if (receipt.hostRevisionBefore === undefined || receipt.hostRevisionBefore !== p.snapshotRevision) {
    throw new PlanReject("stale_context"); // old plan / bad revision
  }
  const shapeOk =
    receipt.schemaVersion === ACTIVE_CONTEXT_RECEIPT_SCHEMA_VERSION &&
    receipt.planId === plan.planId &&
    (receipt.outcome === "applied" || receipt.outcome === "skipped" || receipt.outcome === "failed") &&
    typeof receipt.appliedAt === "string" &&
    !Number.isNaN(Date.parse(receipt.appliedAt));
  if (!shapeOk) throw new PlanReject("invalid_receipt");

  const event: ContextTransformTelemetryRecord = {
    recordKind: "context_transform",
    schemaVersion: ACTIVE_CONTEXT_RECORD_SCHEMA_VERSION,
    timestamp: receipt.appliedAt,
    actionId: plan.planId,
    action: plan.operation === "SUMMARY" ? "summarize_context" : "filter_context",
    outcome: receipt.outcome,
    status: receipt.outcome === "applied" ? "applied" : receipt.outcome === "failed" ? "rejected" : "validated",
    subsystem: "active-context",
    namespace: p.namespace,
    sourceSessionKey: p.sessionKey,
    planHash: plan.planHash,
    snapshotRevision: p.snapshotRevision,
    adapterId: receipt.adapterId,
    algorithmVersion: plan.provenance.algorithmVersion,
    selectedCount: plan.selectedMessageIds.length,
    retainedCount: plan.retainedMessageIds.length,
    proposedRemovalCount: plan.proposedRemovalIds.length,
    receiptOutcome: receipt.outcome,
    selectorHash: plan.provenance.selectorHash,
    snapshotContentHash: plan.provenance.snapshotContentHash,
    ...(plan.provenance.criterionHash ? { criterionHash: plan.provenance.criterionHash } : {}),
    ...(plan.provenance.sourcePromptHash ? { sourcePromptHash: plan.provenance.sourcePromptHash } : {}),
    policyDecision: plan.policy.decision,
    policyRationale: plan.policy.rationale,
  };

  let recorded = false;
  try {
    recorded = await recorder.append(event);
  } catch {
    recorded = false; // ledger errors surface in the result, never as an apply
  }
  return { recorded, event: { ...event, telemetryRecorded: recorded } };
}

/**
 * Build a plan-stage ledger record (plan produced, rejected, skipped, or
 * failed before host apply). Receipt-backed applies use
 * {@link recordActiveContextApplyReceipt} instead.
 */
export function buildContextTransformPlanEvent(
  plan: ActiveContextTransformPlan,
  outcome: "skipped" | "failed",
): ContextTransformTelemetryRecord {
  return {
    recordKind: "context_transform",
    schemaVersion: ACTIVE_CONTEXT_RECORD_SCHEMA_VERSION,
    timestamp: plan.provenance.generatedAt,
    actionId: plan.planId,
    action: plan.operation === "SUMMARY" ? "summarize_context" : "filter_context",
    outcome,
    status: plan.status === "ready" ? "validated" : "rejected",
    subsystem: "active-context",
    namespace: plan.precondition.namespace,
    sourceSessionKey: plan.precondition.sessionKey,
    planHash: plan.planHash,
    snapshotRevision: plan.precondition.snapshotRevision,
    algorithmVersion: plan.provenance.algorithmVersion,
    selectedCount: plan.selectedMessageIds.length,
    retainedCount: plan.retainedMessageIds.length,
    proposedRemovalCount: plan.proposedRemovalIds.length,
    selectorHash: plan.provenance.selectorHash,
    snapshotContentHash: plan.provenance.snapshotContentHash,
    ...(plan.provenance.criterionHash ? { criterionHash: plan.provenance.criterionHash } : {}),
    ...(plan.provenance.sourcePromptHash ? { sourcePromptHash: plan.provenance.sourcePromptHash } : {}),
    policyDecision: plan.policy.decision,
    policyRationale: plan.policy.rationale,
    telemetryRecorded: true,
  };
}
