/**
 * Issue #2345 — privacy-safe action-to-outcome trajectory evaluator (offline slice).
 *
 * Pure, local, deterministic evaluator that joins sanitized action rows to
 * delayed outcome rows inside ONE namespace and ONE bounded time window, then
 * emits a redacted shadow artifact (digests, enums, numbers, counts only).
 *
 * This module never:
 *   - reads live stores (inputs are synthetic or caller-sanitized rows),
 *   - calls a model or network,
 *   - mutates memories, counters, utility runtime, or policy decisions.
 *
 * Delivery note (issue "Delivery order"): schema + offline path first. The
 * live `EvalTrajectoryReader` projections and eval-queue wiring arrive with
 * #2348; this module ships the contract they will feed.
 *
 * Contracts and shared helpers live in `eval-trajectory-contracts.ts`;
 * validation, persistence, and the promotion gate live in
 * `eval-trajectory-store.ts`. Both are re-exported here so consumers import
 * one public surface.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS,
  EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION,
  type EvalActionInput,
  type EvalActionOutcomeRow,
  type EvalActionProjection,
  type EvalOutcomeInput,
  type EvalOutcomeProjection,
  type EvalStaleUseEvidence,
  type EvalStaleUseEvidenceInput,
  type EvalTrajectoryAggregates,
  type EvalTrajectoryJoinKind,
  type EvalTrajectoryMetricName,
  type EvalTrajectoryRejectionReason,
  type EvalTrajectoryReport,
  type EvalTrajectoryRowStatus,
  type EvalTrajectoryRunConfig,
  STALE_LIFECYCLE_STATES,
  STALE_OUTCOMES,
  canonicalJson,
  compareRows,
  compareStrings,
  digestOf,
  isFiniteNumber,
  isIsoTimestamp,
  isMemoryActionType,
  isNonEmptyString,
  resolveEvalTrajectoryRunConfig,
  serializeEvalTrajectoryReport,
  sha256Hex,
} from "./eval-trajectory-contracts.js";
import type { MemoryActionType } from "./types.js";

export {
  DEFAULT_EVAL_TRAJECTORY_MAX_FUTURE_SKEW_MS,
  DEFAULT_EVAL_TRAJECTORY_MAX_ROWS,
  DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS,
  DEFAULT_EVAL_TRAJECTORY_REPORT_MAX_AGE_MS,
  DEFAULT_EVAL_TRAJECTORY_WEIGHTS,
  EVAL_TRAJECTORY_PROMOTION_THRESHOLDS,
  EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION,
  MAX_EVAL_TRAJECTORY_ROWS_LIMIT,
  resolveEvalTrajectoryRunConfig,
  serializeEvalTrajectoryReport,
  type EvalActionInput,
  type EvalActionProjection,
  type EvalOutcomeInput,
  type EvalOutcomeProjection,
  type EvalStaleUseEvidence,
  type EvalStaleUseEvidenceInput,
  type EvalStaleUseLifecycleState,
  type EvalStaleUseOutcome,
  type EvalTrajectoryAggregates,
  type EvalTrajectoryJoinKind,
  type EvalTrajectoryMetricName,
  type EvalTrajectoryOutcomeSource,
  type EvalTrajectoryRejectionReason,
  type EvalTrajectoryReport,
  type EvalTrajectoryRowStatus,
  type EvalTrajectoryRunConfig,
  type EvalTrajectoryTaskResult,
  type EvalTrajectoryWeights,
  type UnifiedMemoryPromotionReport,
  type UnifiedMemoryPromotionState,
} from "./eval-trajectory-contracts.js";
export * from "./eval-trajectory-store.js";

/**
 * Future live-reader seam (#2348). Must receive a trusted principal and a
 * resolved namespace, verify access, and return sanitized rows only.
 */
export interface EvalTrajectoryReaderResult {
  actions: EvalActionInput[];
  outcomes: EvalOutcomeInput[];
  staleUseEvidence: EvalStaleUseEvidenceInput[];
}

export type EvalTrajectoryReader = (input: {
  trustedPrincipal: string;
  resolvedNamespace: string;
  asOf: string;
}) => Promise<EvalTrajectoryReaderResult> | EvalTrajectoryReaderResult;

/** Synthetic reader over caller-supplied clean rows (tests, offline runs). */
export function createSyntheticEvalTrajectoryReader(rows: EvalTrajectoryReaderResult): EvalTrajectoryReader {
  return () => rows;
}

// ---------------------------------------------------------------------------
// Input normalization with per-reason rejection counting
// ---------------------------------------------------------------------------

function emptyRejectionCounts(): Record<EvalTrajectoryRejectionReason, number> {
  return {
    missing_action_id: 0,
    namespace_mismatch: 0,
    invalid_timestamp: 0,
    future_beyond_skew: 0,
    malformed_row: 0,
    invalid_context_budget: 0,
    duplicate_row: 0,
    max_rows_exceeded: 0,
  };
}

interface NormalizeContext {
  namespace: string;
  namespaceDigest: string;
  salt: string;
  asOfMs: number;
  config: EvalTrajectoryRunConfig;
  rejections: Record<EvalTrajectoryRejectionReason, number>;
}

function normalizeAction(raw: unknown, context: NormalizeContext): EvalActionProjection | null {
  if (typeof raw !== "object" || raw === null) {
    context.rejections.malformed_row += 1;
    return null;
  }
  const row = raw as Partial<EvalActionInput>;
  if (!isNonEmptyString(row.actionId)) {
    context.rejections.missing_action_id += 1;
    return null;
  }
  if (row.namespace !== context.namespace) {
    context.rejections.namespace_mismatch += 1;
    return null;
  }
  if (!isIsoTimestamp(row.actionAt)) {
    context.rejections.invalid_timestamp += 1;
    return null;
  }
  if (Date.parse(row.actionAt) > context.asOfMs + context.config.maxFutureSkewMs) {
    context.rejections.future_beyond_skew += 1;
    return null;
  }
  if (!isMemoryActionType(row.action)) {
    context.rejections.malformed_row += 1;
    return null;
  }
  const immediateStatus = row.immediateStatus;
  if (immediateStatus !== "applied" && immediateStatus !== "skipped" && immediateStatus !== "failed") {
    context.rejections.malformed_row += 1;
    return null;
  }
  if (
    row.policyDecision !== undefined &&
    row.policyDecision !== "allow" &&
    row.policyDecision !== "defer" &&
    row.policyDecision !== "deny"
  ) {
    context.rejections.malformed_row += 1;
    return null;
  }

  const tokensPresent =
    row.contextTokensBefore !== undefined ||
    row.contextTokensAfter !== undefined ||
    row.contextTokenBudget !== undefined;
  let contextTokenCost: number | null = null;
  if (tokensPresent) {
    const before = row.contextTokensBefore;
    const after = row.contextTokensAfter;
    const budget = row.contextTokenBudget;
    if (
      (before !== undefined && (!isFiniteNumber(before) || before < 0)) ||
      (after !== undefined && (!isFiniteNumber(after) || after < 0)) ||
      budget === undefined ||
      !isFiniteNumber(budget)
    ) {
      context.rejections.malformed_row += 1;
      return null;
    }
    if (budget === 0) {
      context.rejections.invalid_context_budget += 1;
      return null;
    }
    contextTokenCost = after === undefined ? null : Math.min(1, Math.max(0, after / Math.max(1, budget)));
  }

  const appliedDeny = immediateStatus === "applied" && row.policyDecision === "deny";
  const trustViolation: 0 | 1 =
    appliedDeny || row.replayMismatch === true || row.missingReversibleGuard === true || row.outsideEligibility === true
      ? 1
      : 0;

  return {
    schemaVersion: 1,
    actionDigest: digestOf(context.salt, {
      kind: "action",
      namespace: context.namespace,
      actionId: row.actionId,
    }),
    namespaceDigest: context.namespaceDigest,
    actionAt: row.actionAt,
    action: row.action,
    immediateStatus,
    policyDecision: row.policyDecision ?? null,
    policyVersion: isNonEmptyString(row.policyVersion) ? row.policyVersion : null,
    source: isNonEmptyString(row.subsystem) ? row.subsystem : null,
    actionIdDigest: digestOf(context.salt, {
      kind: "actionId",
      namespace: context.namespace,
      actionId: row.actionId,
    }),
    sessionKeyDigest: isNonEmptyString(row.sessionKey)
      ? digestOf(context.salt, { kind: "sessionKey", namespace: context.namespace, sessionKey: row.sessionKey })
      : null,
    memoryIdDigest: isNonEmptyString(row.memoryId)
      ? digestOf(context.salt, { kind: "memoryId", namespace: context.namespace, memoryId: row.memoryId })
      : null,
    trajectoryIdDigest: isNonEmptyString(row.trajectoryId)
      ? digestOf(context.salt, {
          kind: "trajectoryId",
          namespace: context.namespace,
          trajectoryId: row.trajectoryId,
        })
      : null,
    contextTokenCost,
    trustViolation,
  };
}

function normalizeOutcome(raw: unknown, context: NormalizeContext): EvalOutcomeProjection | null {
  if (typeof raw !== "object" || raw === null) {
    context.rejections.malformed_row += 1;
    return null;
  }
  const row = raw as Partial<EvalOutcomeInput>;
  if (!isNonEmptyString(row.outcomeId)) {
    context.rejections.malformed_row += 1;
    return null;
  }
  if (row.namespace !== context.namespace) {
    context.rejections.namespace_mismatch += 1;
    return null;
  }
  if (row.source !== "eval_artifact" && row.source !== "causal_trajectory" && row.source !== "memory_outcome") {
    context.rejections.malformed_row += 1;
    return null;
  }
  if (!isIsoTimestamp(row.outcomeAt)) {
    context.rejections.invalid_timestamp += 1;
    return null;
  }
  if (Date.parse(row.outcomeAt) > context.asOfMs + context.config.maxFutureSkewMs) {
    context.rejections.future_beyond_skew += 1;
    return null;
  }
  if (row.result !== undefined && row.result !== "success" && row.result !== "partial" && row.result !== "failure") {
    context.rejections.malformed_row += 1;
    return null;
  }
  const hasJoinKey =
    isNonEmptyString(row.actionId) ||
    isNonEmptyString(row.trajectoryId) ||
    isNonEmptyString(row.sessionKey) ||
    (isNonEmptyString(row.memoryId) && isNonEmptyString(row.sessionKey));
  if (!hasJoinKey) {
    context.rejections.malformed_row += 1;
    return null;
  }

  const value =
    row.result === undefined || row.source === "memory_outcome"
      ? null
      : row.result === "success"
        ? 1
        : row.result === "partial"
          ? 0.5
          : 0;
  const ref = row.actionId ?? row.trajectoryId ?? row.memoryId ?? row.sessionKey ?? row.outcomeId;

  return {
    schemaVersion: 1,
    outcomeDigest: digestOf(context.salt, {
      kind: "outcome",
      namespace: context.namespace,
      outcomeId: row.outcomeId,
    }),
    namespaceDigest: context.namespaceDigest,
    recordedAt: row.outcomeAt,
    kind: row.source,
    value,
    sourceRefDigest: digestOf(context.salt, { kind: "sourceRef", namespace: context.namespace, ref }),
    actionIdDigest: isNonEmptyString(row.actionId)
      ? digestOf(context.salt, { kind: "actionId", namespace: context.namespace, actionId: row.actionId })
      : null,
    trajectoryIdDigest: isNonEmptyString(row.trajectoryId)
      ? digestOf(context.salt, {
          kind: "trajectoryId",
          namespace: context.namespace,
          trajectoryId: row.trajectoryId,
        })
      : null,
    memoryIdDigest: isNonEmptyString(row.memoryId)
      ? digestOf(context.salt, { kind: "memoryId", namespace: context.namespace, memoryId: row.memoryId })
      : null,
    sessionKeyDigest: isNonEmptyString(row.sessionKey)
      ? digestOf(context.salt, { kind: "sessionKey", namespace: context.namespace, sessionKey: row.sessionKey })
      : null,
  };
}

function normalizeStaleEvidence(raw: unknown, context: NormalizeContext): EvalStaleUseEvidence | null {
  if (typeof raw !== "object" || raw === null) {
    context.rejections.malformed_row += 1;
    return null;
  }
  const row = raw as Partial<EvalStaleUseEvidenceInput>;
  if (!isNonEmptyString(row.actionId) || !isNonEmptyString(row.memoryId)) {
    context.rejections.malformed_row += 1;
    return null;
  }
  if (row.namespace !== context.namespace) {
    context.rejections.namespace_mismatch += 1;
    return null;
  }
  if (typeof row.lifecycleState !== "string" || STALE_LIFECYCLE_STATES[row.lifecycleState] !== true) {
    context.rejections.malformed_row += 1;
    return null;
  }
  if (!isIsoTimestamp(row.usedAt) || typeof row.outcome !== "string" || STALE_OUTCOMES[row.outcome] !== true) {
    context.rejections.malformed_row += 1;
    return null;
  }
  return {
    schemaVersion: 1,
    actionDigest: digestOf(context.salt, {
      kind: "action",
      namespace: context.namespace,
      actionId: row.actionId,
    }),
    memoryDigest: digestOf(context.salt, {
      kind: "memoryId",
      namespace: context.namespace,
      memoryId: row.memoryId,
    }),
    lifecycleState: row.lifecycleState,
    usedAt: row.usedAt,
    outcome: row.outcome,
  };
}

// ---------------------------------------------------------------------------
// Join + metric core
// ---------------------------------------------------------------------------

interface JoinCandidateLevel {
  kind: EvalTrajectoryJoinKind;
  matches: (action: EvalActionProjection, outcome: EvalOutcomeProjection) => boolean;
}

const JOIN_LEVELS: JoinCandidateLevel[] = [
  {
    kind: "action_id",
    matches: (action, outcome) => outcome.actionIdDigest !== null && outcome.actionIdDigest === action.actionIdDigest,
  },
  {
    kind: "trajectory_id",
    matches: (action, outcome) =>
      action.trajectoryIdDigest !== null &&
      outcome.trajectoryIdDigest !== null &&
      outcome.trajectoryIdDigest === action.trajectoryIdDigest,
  },
  {
    kind: "memory_scope",
    matches: (action, outcome) =>
      outcome.kind === "memory_outcome" &&
      action.memoryIdDigest !== null &&
      outcome.memoryIdDigest !== null &&
      outcome.memoryIdDigest === action.memoryIdDigest &&
      action.sessionKeyDigest !== null &&
      outcome.sessionKeyDigest !== null &&
      outcome.sessionKeyDigest === action.sessionKeyDigest,
  },
  {
    kind: "session_scope",
    matches: (action, outcome) =>
      outcome.kind !== "memory_outcome" &&
      action.sessionKeyDigest !== null &&
      outcome.sessionKeyDigest !== null &&
      outcome.sessionKeyDigest === action.sessionKeyDigest,
  },
];

/** Half-open delayed window: `actionAt < outcomeAt < actionAt + outcomeWindowMs`. */
function outcomeInWindow(
  action: EvalActionProjection,
  outcome: EvalOutcomeProjection,
  config: EvalTrajectoryRunConfig
): boolean {
  const outcomeMs = Date.parse(outcome.recordedAt);
  return Date.parse(action.actionAt) < outcomeMs && outcomeMs < Date.parse(action.actionAt) + config.outcomeWindowMs;
}

function anyKeyMatch(action: EvalActionProjection, outcome: EvalOutcomeProjection): boolean {
  return JOIN_LEVELS.some((level) => level.matches(action, outcome));
}

function staleHarmFor(action: EvalActionProjection, evidence: EvalStaleUseEvidence[]): 0 | 0.5 | 1 {
  let harm: 0 | 0.5 | 1 = 0;
  for (const item of evidence) {
    if (item.actionDigest !== action.actionDigest) continue;
    if (item.lifecycleState !== "stale" && item.lifecycleState !== "archived") continue;
    if (Date.parse(item.usedAt) <= Date.parse(action.actionAt)) continue;
    if (item.outcome === "failure") return 1;
    if (item.outcome === "partial" || item.outcome === "unknown") harm = 0.5;
  }
  return harm;
}

function buildRow(
  action: EvalActionProjection,
  outcomes: EvalOutcomeProjection[],
  evidence: EvalStaleUseEvidence[],
  config: EvalTrajectoryRunConfig,
  asOfMs: number
): EvalActionOutcomeRow {
  let selected: EvalOutcomeProjection | null = null;
  let joinKind: EvalTrajectoryJoinKind | null = null;
  let ambiguous = false;

  for (const level of JOIN_LEVELS) {
    const inWindow = outcomes.filter(
      (outcome) =>
        level.matches(action, outcome) &&
        outcomeInWindow(action, outcome, config) &&
        Date.parse(outcome.recordedAt) <= asOfMs
    );
    if (inWindow.length === 1) {
      selected = inWindow[0] ?? null;
      joinKind = level.kind;
      break;
    }
    if (inWindow.length > 1) {
      ambiguous = true;
      joinKind = level.kind;
      break;
    }
  }

  let status: EvalTrajectoryRowStatus;
  let outcomeDigest: string | null = null;
  let outcomeRecordedAt: string | null = null;
  let lateProjection: EvalOutcomeProjection | null = null;
  if (ambiguous) {
    status = "ambiguous";
  } else if (selected !== null) {
    status = "joined";
    outcomeDigest = selected.outcomeDigest;
    outcomeRecordedAt = selected.recordedAt;
  } else {
    const keyMatches = outcomes.filter((outcome) => anyKeyMatch(action, outcome));
    // Prefer the in-data off-window result when one exists; a future result
    // (recorded after asOf) is reported but never matched.
    const lateCandidates = keyMatches
      .filter(
        (outcome) =>
          Date.parse(outcome.recordedAt) >= Date.parse(action.actionAt) + config.outcomeWindowMs &&
          Date.parse(outcome.recordedAt) <= asOfMs
      )
      .sort((a, b) => compareStrings(a.recordedAt, b.recordedAt));
    lateProjection = lateCandidates.length > 0 ? (lateCandidates[lateCandidates.length - 1] ?? null) : null;
    if (lateProjection !== null) {
      status = "late_outcome";
      outcomeDigest = lateProjection.outcomeDigest;
      outcomeRecordedAt = lateProjection.recordedAt;
    } else if (keyMatches.some((outcome) => Date.parse(outcome.recordedAt) > asOfMs)) {
      status = "future_outcome";
    } else {
      status = "missing_within_window";
    }
  }

  // Only task-source outcomes carry a task value; memory outcomes never do.
  const matched = selected ?? (status === "late_outcome" ? lateProjection : null);
  const taskOutcome: number | null =
    status === "joined" || status === "late_outcome"
      ? matched !== null && matched.kind !== "memory_outcome"
        ? matched.value
        : null
      : null;

  const staleMemoryHarm = staleHarmFor(action, evidence);
  const weights = config.weights;
  const missingDimensions: EvalTrajectoryMetricName[] = [];
  if (taskOutcome === null && weights.task > 0) missingDimensions.push("taskOutcome");
  if (action.contextTokenCost === null && weights.context > 0) missingDimensions.push("contextTokenCost");

  const actionConditionedUtility =
    status !== "joined" || missingDimensions.length > 0
      ? null
      : Math.min(
          1,
          Math.max(
            -1,
            weights.task * (taskOutcome ?? 0) -
              weights.context * (action.contextTokenCost ?? 0) -
              weights.trust * action.trustViolation -
              weights.stale * staleMemoryHarm
          )
        );

  return {
    schemaVersion: 1,
    actionDigest: action.actionDigest,
    outcomeDigest: status === "future_outcome" ? null : outcomeDigest,
    join: status === "joined" || status === "ambiguous" ? joinKind : null,
    status,
    outcomeRecordedAt: status === "future_outcome" ? null : outcomeRecordedAt,
    taskOutcome,
    contextTokenCost: action.contextTokenCost,
    trustViolation: action.trustViolation,
    staleMemoryHarm,
    actionConditionedUtility,
    missingDimensions,
  };
}

// ---------------------------------------------------------------------------
// Report builder (pure — no I/O, no model, no memory writes)
// ---------------------------------------------------------------------------

export interface BuildEvalTrajectoryReportOptions {
  /** Single resolved namespace for the whole run. Never "all namespaces". */
  namespace: string;
  asOf: string;
  /** Per-run salt. Required, never exported. */
  salt: string;
  actions: unknown[];
  outcomes?: unknown[];
  staleUseEvidence?: unknown[];
  config?: Partial<EvalTrajectoryRunConfig>;
}

export function buildEvalTrajectoryReport(options: BuildEvalTrajectoryReportOptions): EvalTrajectoryReport {
  if (!isNonEmptyString(options.namespace)) throw new Error("eval trajectory run requires a namespace");
  if (!isNonEmptyString(options.salt)) throw new Error("eval trajectory run requires a salt");
  if (!isIsoTimestamp(options.asOf)) throw new Error("asOf must be a normalized ISO-8601 UTC timestamp");
  const config = resolveEvalTrajectoryRunConfig(options.config);
  const asOfMs = Date.parse(options.asOf);
  const context: NormalizeContext = {
    namespace: options.namespace,
    namespaceDigest: digestOf(options.salt, { kind: "namespace", namespace: options.namespace }),
    salt: options.salt,
    asOfMs,
    config,
    rejections: emptyRejectionCounts(),
  };

  const actions: EvalActionProjection[] = [];
  const seenActionDigests = new Set<string>();
  for (const raw of options.actions ?? []) {
    const projection = normalizeAction(raw, context);
    if (projection === null) continue;
    if (seenActionDigests.has(projection.actionDigest)) {
      context.rejections.duplicate_row += 1;
      continue;
    }
    seenActionDigests.add(projection.actionDigest);
    actions.push(projection);
  }
  actions.sort((a, b) => compareStrings(a.actionDigest, b.actionDigest));
  if (actions.length > config.maxRows) {
    context.rejections.max_rows_exceeded += actions.length - config.maxRows;
    actions.length = config.maxRows;
  }

  const outcomes: EvalOutcomeProjection[] = [];
  const seenOutcomeDigests = new Set<string>();
  for (const raw of options.outcomes ?? []) {
    const projection = normalizeOutcome(raw, context);
    if (projection === null) continue;
    if (seenOutcomeDigests.has(projection.outcomeDigest)) {
      context.rejections.duplicate_row += 1;
      continue;
    }
    seenOutcomeDigests.add(projection.outcomeDigest);
    outcomes.push(projection);
  }
  outcomes.sort((a, b) => compareStrings(a.outcomeDigest, b.outcomeDigest));

  const evidence: EvalStaleUseEvidence[] = [];
  for (const raw of options.staleUseEvidence ?? []) {
    const projection = normalizeStaleEvidence(raw, context);
    if (projection !== null) evidence.push(projection);
  }
  evidence.sort((a, b) => {
    const byUsedAt = compareStrings(a.usedAt, b.usedAt);
    if (byUsedAt !== 0) return byUsedAt;
    return compareStrings(a.memoryDigest, b.memoryDigest);
  });

  const rows = actions.map((action) => buildRow(action, outcomes, evidence, config, asOfMs));
  rows.sort(compareRows);

  const inputFingerprint = sha256Hex(
    canonicalJson({
      schemaVersion: EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION,
      namespace: options.namespace,
      asOf: options.asOf,
      salt: options.salt,
      config,
      actions,
      outcomes,
      evidence,
    })
  );
  const reportId = sha256Hex(
    canonicalJson({
      kind: "eval-trajectory-report",
      inputFingerprint,
      namespaceDigest: context.namespaceDigest,
      asOf: options.asOf,
    })
  );

  const report: EvalTrajectoryReport = {
    schemaVersion: EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION,
    reportId,
    namespaceDigest: context.namespaceDigest,
    asOf: options.asOf,
    config,
    sourceCounts: { actions: actions.length, outcomes: outcomes.length, staleUseEvidence: evidence.length },
    rejectionCounts: context.rejections,
    rows,
    aggregates: computeAggregates(rows, actions),
    inputFingerprint,
    contentHash: "",
  };
  report.contentHash = sha256Hex(canonicalJson({ ...report, contentHash: undefined }));
  return report;
}

function computeAggregates(rows: EvalActionOutcomeRow[], actions: EvalActionProjection[]): EvalTrajectoryAggregates {
  const statusCounts: Record<EvalTrajectoryRowStatus, number> = {
    joined: 0,
    ambiguous: 0,
    late_outcome: 0,
    future_outcome: 0,
    missing_within_window: 0,
  };
  for (const row of rows) statusCounts[row.status] += 1;

  const digestToAction = new Map(actions.map((action) => [action.actionDigest, action]));
  const joinedRows = rows.filter((row) => row.status === "joined");
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  interface GroupTally {
    rowCount: number;
    utilitySum: number;
    utilityCount: number;
  }
  const bump = (map: Map<string, GroupTally>, key: string, utility: number | null): void => {
    const tally = map.get(key) ?? { rowCount: 0, utilitySum: 0, utilityCount: 0 };
    tally.rowCount += 1;
    if (utility !== null) {
      tally.utilitySum += utility;
      tally.utilityCount += 1;
    }
    map.set(key, tally);
  };
  const byActionMap = new Map<string, GroupTally>();
  const byPolicyMap = new Map<string, GroupTally>();
  for (const row of joinedRows) {
    const action = digestToAction.get(row.actionDigest);
    if (!action) continue;
    bump(byActionMap, action.action, row.actionConditionedUtility);
    bump(byPolicyMap, action.policyDecision ?? "unrecorded", row.actionConditionedUtility);
  }

  const reachDenominator = rows.length - statusCounts.future_outcome;
  return {
    rowCount: rows.length,
    statusCounts,
    metricMeans: {
      taskOutcome: mean(joinedRows.map((row) => row.taskOutcome).filter(isFiniteNumber)),
      contextTokenCost: mean(joinedRows.map((row) => row.contextTokenCost).filter(isFiniteNumber)),
      trustViolation: mean(joinedRows.map((row) => row.trustViolation).filter(isFiniteNumber)),
      staleMemoryHarm: mean(joinedRows.map((row) => row.staleMemoryHarm).filter(isFiniteNumber)),
      actionConditionedUtility: mean(joinedRows.map((row) => row.actionConditionedUtility).filter(isFiniteNumber)),
    },
    coverage: {
      reach: reachDenominator > 0 ? statusCounts.joined / reachDenominator : null,
      joined: statusCounts.joined,
      missingWithinWindow: statusCounts.missing_within_window,
      lateOutcome: statusCounts.late_outcome,
      futureOutcome: statusCounts.future_outcome,
      ambiguous: statusCounts.ambiguous,
      excludedFromMeans: rows.length - statusCounts.joined,
    },
    byAction: [...byActionMap.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([action, tally]) => ({
        action: action as MemoryActionType,
        rowCount: tally.rowCount,
        meanUtility: tally.utilityCount > 0 ? tally.utilitySum / tally.utilityCount : null,
      })),
    byPolicyDecision: [...byPolicyMap.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([policyDecision, tally]) => ({
        policyDecision,
        rowCount: tally.rowCount,
        meanUtility: tally.utilityCount > 0 ? tally.utilitySum / tally.utilityCount : null,
      })),
  };
}

// ---------------------------------------------------------------------------
// Self-check (minimal made-up fixture): npx tsx packages/remnic-core/src/eval-trajectory.ts
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith("eval-trajectory.ts") === true) {
  const report = buildEvalTrajectoryReport({
    namespace: "self-check",
    asOf: "2026-08-15T00:00:00.000Z",
    salt: "self-check-salt",
    actions: [
      {
        schemaVersion: 1,
        actionId: "act-1",
        namespace: "self-check",
        actionAt: "2026-08-10T00:00:00.000Z",
        action: "store_note",
        immediateStatus: "applied",
        sessionKey: "agent:main",
      },
    ],
    outcomes: [
      {
        schemaVersion: 1,
        namespace: "self-check",
        outcomeId: "out-1",
        outcomeAt: "2026-08-12T00:00:00.000Z",
        source: "causal_trajectory",
        result: "partial",
        sessionKey: "agent:main",
      },
    ],
  });
  const row = report.rows[0];
  assert.equal(row?.status, "joined", "self-check row must join");
  assert.equal(row?.taskOutcome, 0.5, "partial must score 0.5");
  assert.equal(report.aggregates.coverage.reach, 1, "reach must be 1");
  assert.ok(serializeEvalTrajectoryReport(report).includes('"contentHash"'), "report must serialize");
  assert.ok(DEFAULT_EVAL_TRAJECTORY_OUTCOME_WINDOW_MS === 604_800_000, "default window must stay 7 days");
  console.log("eval-trajectory self-check OK");
}
