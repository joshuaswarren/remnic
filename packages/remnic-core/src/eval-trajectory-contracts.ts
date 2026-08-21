/**
 * Issue #2345 — internal contracts, config bounds, digests, and validators for
 * the privacy-safe action-to-outcome trajectory evaluator.
 *
 * Internal module: never re-exported from the package root by itself. The
 * public surface is `eval-trajectory.ts` (builder) and `eval-trajectory-store.ts`
 * (validation, persistence, promotion gate). Keeping this layer separate holds
 * every file under the #1995 new-file ratchet cap while preserving one
 * subsystem.
 */

import { createHash } from "node:crypto";
import type { MemoryActionOutcome, MemoryActionPolicyDecision, MemoryActionType } from "./types.js";

// ---------------------------------------------------------------------------
// Constants and bounded config
// ---------------------------------------------------------------------------

export const EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION = 1;

/** Default delayed-outcome window: 7 days, half-open `actionAt < outcomeAt < actionAt + window`. */
export const DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS = 604_800_000;
/** Default allowed clock skew for input timestamps beyond `asOf`. */
export const DEFAULT_EVAL_TRAJECTORY_MAX_FUTURE_SKEW_MS = 300_000;
/** Default cap on emitted rows per report. */
export const DEFAULT_EVAL_TRAJECTORY_MAX_ROWS = 5_000;
export const MAX_EVAL_TRAJECTORY_ROWS_LIMIT = 50_000;
/** Default reader expiry: a report older than 30 days fails the checked read. */
export const DEFAULT_EVAL_TRAJECTORY_REPORT_MAX_AGE_MS = 2_592_000_000;

export interface EvalTrajectoryWeights {
  task: number;
  context: number;
  trust: number;
  stale: number;
}

export const DEFAULT_EVAL_TRAJECTORY_WEIGHTS: Readonly<EvalTrajectoryWeights> = Object.freeze({
  task: 1,
  context: 0.25,
  trust: 1,
  stale: 0.5,
});

const MEMORY_ACTION_TYPES: Record<string, true> = {
  store_episode: true,
  store_note: true,
  update_note: true,
  create_artifact: true,
  summarize_node: true,
  discard: true,
  link_graph: true,
};

/** Action types whose live execution is destructive (irreversible) for promotion gating. */
export const DESTRUCTIVE_ACTION_TYPES: Record<string, true> = { discard: true };

export const STALE_LIFECYCLE_STATES: Record<string, true> = {
  active: true,
  stale: true,
  archived: true,
  superseded: true,
};

export const STALE_OUTCOMES: Record<string, true> = {
  success: true,
  partial: true,
  failure: true,
  unknown: true,
};

/**
 * Fixed promotion thresholds for `deriveUnifiedMemoryPromotionReport`. These
 * are deliberately conservative named constants — #2348 owns application, and
 * any loosening must be a reviewed change, not a config knob.
 */
export const EVAL_TRAJECTORY_PROMOTION_THRESHOLDS = Object.freeze({
  minJoinedRows: 30,
  minReach: 0.5,
});

export interface EvalTrajectoryRunConfig {
  outcomeWindowMs: number;
  maxFutureSkewMs: number;
  weights: EvalTrajectoryWeights;
  maxRows: number;
}

export function resolveEvalTrajectoryRunConfig(partial?: Partial<EvalTrajectoryRunConfig>): EvalTrajectoryRunConfig {
  const source = partial ?? {};
  const weightsSource = source.weights ?? DEFAULT_EVAL_TRAJECTORY_WEIGHTS;
  const weights: EvalTrajectoryWeights = {
    task: Number(weightsSource.task),
    context: Number(weightsSource.context),
    trust: Number(weightsSource.trust),
    stale: Number(weightsSource.stale),
  };
  for (const [name, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`eval trajectory weight '${name}' must be a finite non-negative number`);
    }
  }
  const totalWeight = weights.task + weights.context + weights.trust + weights.stale;
  if (!(totalWeight > 0)) {
    throw new Error("eval trajectory weights must have a positive total weight");
  }

  const outcomeWindowMs = Number(source.outcomeWindowMs ?? DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS);
  if (!Number.isSafeInteger(outcomeWindowMs) || outcomeWindowMs <= 0) {
    throw new Error("outcomeWindowMs must be a positive integer");
  }
  const maxFutureSkewMs = Number(source.maxFutureSkewMs ?? DEFAULT_EVAL_TRAJECTORY_MAX_FUTURE_SKEW_MS);
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    throw new Error("maxFutureSkewMs must be a non-negative integer");
  }
  const maxRows = Number(source.maxRows ?? DEFAULT_EVAL_TRAJECTORY_MAX_ROWS);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_EVAL_TRAJECTORY_ROWS_LIMIT) {
    throw new Error(`maxRows must be an integer in [1, ${MAX_EVAL_TRAJECTORY_ROWS_LIMIT}]`);
  }
  return { outcomeWindowMs, maxFutureSkewMs, weights, maxRows };
}

// ---------------------------------------------------------------------------
// Input contracts (sanitized caller rows — raw IDs live here, never in output)
// ---------------------------------------------------------------------------

export type EvalTrajectoryTaskResult = "success" | "partial" | "failure";
export type EvalTrajectoryOutcomeSource = "eval_artifact" | "causal_trajectory" | "memory_outcome";
export type EvalStaleUseLifecycleState = "active" | "stale" | "archived" | "superseded";
export type EvalStaleUseOutcome = "success" | "partial" | "failure" | "unknown";

export interface EvalActionInput {
  schemaVersion: 1;
  /** Stable action identity. Required — rows without it are rejected. */
  actionId: string;
  namespace: string;
  actionAt: string;
  action: MemoryActionType;
  /** Immediate operation status. Never a delayed task result. */
  immediateStatus: MemoryActionOutcome;
  policyDecision?: MemoryActionPolicyDecision;
  policyVersion?: string;
  /** Producing subsystem tag (enum-like; exported through the projection). */
  subsystem?: string;
  sessionKey?: string;
  memoryId?: string;
  trajectoryId?: string;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
  contextTokenBudget?: number;
  contextOverflow?: boolean;
  replayMismatch?: boolean;
  missingReversibleGuard?: boolean;
  outsideEligibility?: boolean;
}

export interface EvalOutcomeInput {
  schemaVersion: 1;
  namespace: string;
  /** Stable local identity used only for digesting/dedup — never exported. */
  outcomeId: string;
  outcomeAt: string;
  source: EvalTrajectoryOutcomeSource;
  /** success | partial | failure. Memory-outcome results never become task results. */
  result?: EvalTrajectoryTaskResult;
  actionId?: string;
  trajectoryId?: string;
  memoryId?: string;
  sessionKey?: string;
}

export interface EvalStaleUseEvidenceInput {
  schemaVersion: 1;
  namespace: string;
  actionId: string;
  memoryId: string;
  lifecycleState: EvalStaleUseLifecycleState;
  usedAt: string;
  outcome: EvalStaleUseOutcome;
}

/**
 * Normalized digest-only projections. Joins run on these, so raw IDs never
 * reach the metric or export layers. Equality joins survive digesting because
 * equal raw keys digest to equal values under the same run salt.
 */
export interface EvalActionProjection {
  schemaVersion: 1;
  actionDigest: string;
  namespaceDigest: string;
  actionAt: string;
  action: MemoryActionType;
  immediateStatus: MemoryActionOutcome;
  policyDecision: MemoryActionPolicyDecision | null;
  policyVersion: string | null;
  source: string | null;
  actionIdDigest: string;
  sessionKeyDigest: string | null;
  memoryIdDigest: string | null;
  trajectoryIdDigest: string | null;
  contextTokenCost: number | null;
  trustViolation: 0 | 1;
}

export interface EvalOutcomeProjection {
  schemaVersion: 1;
  outcomeDigest: string;
  namespaceDigest: string;
  recordedAt: string;
  kind: EvalTrajectoryOutcomeSource;
  /** 1 | 0.5 | 0 for task sources; null when unknown or memory-sourced. */
  value: number | null;
  sourceRefDigest: string;
  actionIdDigest: string | null;
  trajectoryIdDigest: string | null;
  memoryIdDigest: string | null;
  sessionKeyDigest: string | null;
}

export interface EvalStaleUseEvidence {
  schemaVersion: 1;
  actionDigest: string;
  memoryDigest: string;
  lifecycleState: EvalStaleUseLifecycleState;
  usedAt: string;
  outcome: EvalStaleUseOutcome;
}

// ---------------------------------------------------------------------------
// Exported report contracts (digests, enums, numbers only)
// ---------------------------------------------------------------------------

export type EvalTrajectoryMetricName = "taskOutcome" | "contextTokenCost" | "trustViolation" | "staleMemoryHarm";

export type EvalTrajectoryJoinKind = "action_id" | "trajectory_id" | "memory_scope" | "session_scope";

export type EvalTrajectoryRowStatus =
  | "joined"
  | "ambiguous"
  | "late_outcome"
  | "future_outcome"
  | "missing_within_window";

export type EvalTrajectoryRejectionReason =
  | "missing_action_id"
  | "namespace_mismatch"
  | "invalid_timestamp"
  | "future_beyond_skew"
  | "malformed_row"
  | "invalid_context_budget"
  | "duplicate_row"
  | "max_rows_exceeded";

export interface EvalActionOutcomeRow {
  schemaVersion: 1;
  actionDigest: string;
  outcomeDigest: string | null;
  join: EvalTrajectoryJoinKind | null;
  status: EvalTrajectoryRowStatus;
  outcomeRecordedAt: string | null;
  taskOutcome: number | null;
  contextTokenCost: number | null;
  trustViolation: 0 | 1;
  staleMemoryHarm: 0 | 0.5 | 1;
  actionConditionedUtility: number | null;
  missingDimensions: EvalTrajectoryMetricName[];
}

export interface EvalTrajectoryAggregates {
  rowCount: number;
  statusCounts: Record<EvalTrajectoryRowStatus, number>;
  metricMeans: {
    taskOutcome: number | null;
    contextTokenCost: number | null;
    trustViolation: number | null;
    staleMemoryHarm: number | null;
    actionConditionedUtility: number | null;
  };
  coverage: {
    reach: number | null;
    joined: number;
    missingWithinWindow: number;
    lateOutcome: number;
    futureOutcome: number;
    ambiguous: number;
    excludedFromMeans: number;
  };
  byAction: Array<{ action: MemoryActionType; rowCount: number; meanUtility: number | null }>;
  byPolicyDecision: Array<{ policyDecision: string; rowCount: number; meanUtility: number | null }>;
}

export interface EvalTrajectoryReport {
  schemaVersion: 1;
  reportId: string;
  namespaceDigest: string;
  asOf: string;
  config: EvalTrajectoryRunConfig;
  sourceCounts: { actions: number; outcomes: number; staleUseEvidence: number };
  rejectionCounts: Record<EvalTrajectoryRejectionReason, number>;
  rows: EvalActionOutcomeRow[];
  aggregates: EvalTrajectoryAggregates;
  inputFingerprint: string;
  contentHash: string;
}

export type UnifiedMemoryPromotionState =
  | "insufficient_evidence"
  | "shadow_eligible"
  | "active_reversible_eligible"
  | "active_destructive_review_only"
  | "demote_to_shadow";

export interface UnifiedMemoryPromotionReport {
  schemaVersion: 1;
  sourceReportId: string;
  namespaceDigest: string;
  asOf: string;
  inputFingerprint: string;
  state: UnifiedMemoryPromotionState;
  reasons: string[];
  evidence: {
    joinedRows: number;
    reach: number | null;
    meanUtility: number | null;
    trustViolations: number;
    staleHarms: number;
    destructiveJoinedRows: number;
  };
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Digests and deterministic serialization
// ---------------------------------------------------------------------------

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function digestOf(salt: string, payload: unknown): string {
  return sha256Hex(`${salt}\n${canonicalJson(payload)}`);
}

/** Byte-identical serialization for given report content, independent of construction order. */
export function serializeEvalTrajectoryReport(report: EvalTrajectoryReport): string {
  return `${JSON.stringify(sortKeysDeep(report), null, 2)}\n`;
}

/** Total-order comparators (equality guarded — never let equal keys claim both orders). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareRows(a: EvalActionOutcomeRow, b: EvalActionOutcomeRow): number {
  const byTime = compareStrings(a.outcomeRecordedAt ?? "", b.outcomeRecordedAt ?? "");
  if (byTime !== 0) return byTime;
  return compareStrings(a.actionDigest, b.actionDigest);
}

// ---------------------------------------------------------------------------
// Small shared validators (local copies — evals.ts is at its ratchet ceiling)
// ---------------------------------------------------------------------------

const ISO_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isMemoryActionType(value: unknown): value is MemoryActionType {
  return typeof value === "string" && MEMORY_ACTION_TYPES[value] === true;
}

export function isRowStatus(value: unknown): value is EvalTrajectoryRowStatus {
  return (
    value === "joined" ||
    value === "ambiguous" ||
    value === "late_outcome" ||
    value === "future_outcome" ||
    value === "missing_within_window"
  );
}

export function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
