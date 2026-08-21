/**
 * Issue #2345 — validation, redaction, persistence, and the promotion gate for
 * trajectory-eval reports.
 *
 * Fail-closed by construction:
 *   - every report is redaction-scanned before it can be validated or written,
 *   - the content hash and row-derived aggregates are recomputed on read,
 *   - the checked reader rejects tampered, future-dated, and expired reports,
 *   - the promotion gate can only recommend; it never runs an action.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EVAL_TRAJECTORY_REPORT_MAX_AGE_MS,
  DESTRUCTIVE_ACTION_TYPES,
  EVAL_TRAJECTORY_PROMOTION_THRESHOLDS,
  EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION,
  type EvalActionOutcomeRow,
  type EvalTrajectoryReport,
  type EvalTrajectoryRowStatus,
  type EvalTrajectoryRunConfig,
  type UnifiedMemoryPromotionReport,
  type UnifiedMemoryPromotionState,
  canonicalJson,
  compareRows,
  isFiniteNumber,
  isHexSha256,
  isIsoTimestamp,
  isMemoryActionType,
  isRowStatus,
  resolveEvalTrajectoryRunConfig,
  serializeEvalTrajectoryReport,
  sha256Hex,
} from "./eval-trajectory-contracts.js";
import { resolveEvalStoreDir } from "./evals.js";

// ---------------------------------------------------------------------------
// Promotion gate derivation (#2348 consumes this; it never runs actions here)
// ---------------------------------------------------------------------------

export function deriveUnifiedMemoryPromotionReport(report: EvalTrajectoryReport): UnifiedMemoryPromotionReport {
  const { aggregates } = report;
  const trustViolations = report.rows.reduce(
    (sum, row) => sum + (row.status === "joined" && row.trustViolation === 1 ? 1 : 0),
    0
  );
  const staleHarms = report.rows.reduce(
    (sum, row) => sum + (row.status === "joined" && row.staleMemoryHarm > 0 ? 1 : 0),
    0
  );
  const destructiveJoinedRows = aggregates.byAction
    .filter((group) => DESTRUCTIVE_ACTION_TYPES[group.action] === true)
    .reduce((sum, group) => sum + group.rowCount, 0);

  const reasons: string[] = [];
  let state: UnifiedMemoryPromotionState;
  if (trustViolations > 0 || staleHarms > 0) {
    state = "demote_to_shadow";
    reasons.push("safety_fault_present");
  } else if (aggregates.coverage.joined < EVAL_TRAJECTORY_PROMOTION_THRESHOLDS.minJoinedRows) {
    state = "insufficient_evidence";
    reasons.push("insufficient_joined_rows");
  } else if (
    aggregates.coverage.reach !== null &&
    aggregates.coverage.reach < EVAL_TRAJECTORY_PROMOTION_THRESHOLDS.minReach
  ) {
    state = "shadow_eligible";
    reasons.push("reach_below_floor");
  } else if (destructiveJoinedRows > 0) {
    state = "active_destructive_review_only";
    reasons.push("destructive_actions_present");
  } else if (aggregates.metricMeans.actionConditionedUtility === null) {
    state = "shadow_eligible";
    reasons.push("utility_mean_unavailable");
  } else {
    state = "active_reversible_eligible";
  }

  const draft: UnifiedMemoryPromotionReport = {
    schemaVersion: 1,
    sourceReportId: report.reportId,
    namespaceDigest: report.namespaceDigest,
    asOf: report.asOf,
    inputFingerprint: report.inputFingerprint,
    state,
    reasons,
    evidence: {
      joinedRows: aggregates.coverage.joined,
      reach: aggregates.coverage.reach,
      meanUtility: aggregates.metricMeans.actionConditionedUtility,
      trustViolations,
      staleHarms,
      destructiveJoinedRows,
    },
    contentHash: "",
  };
  draft.contentHash = sha256Hex(canonicalJson({ ...draft, contentHash: undefined }));
  return draft;
}

// ---------------------------------------------------------------------------
// Redaction (fail closed) + validation
// ---------------------------------------------------------------------------

const FORBIDDEN_EXPORT_KEYS: Record<string, true> = {
  inputSummary: true,
  goal: true,
  actionSummary: true,
  observationSummary: true,
  outcomeSummary: true,
  prompt: true,
  promptText: true,
  promptHash: true,
  memoryText: true,
  noteText: true,
  sessionKey: true,
  sourceSessionKey: true,
  filePath: true,
  path: true,
  storeDir: true,
  memoryDir: true,
  actionId: true,
  trajectoryId: true,
  memoryId: true,
  outcomeId: true,
  namespace: true,
  salt: true,
  rationale: true,
  summary: true,
  content: true,
  text: true,
};

export function assertEvalTrajectoryReportRedacted(value: unknown, label = "report"): void {
  const scan = (node: unknown, trail: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => scan(item, `${trail}[${index}]`));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_EXPORT_KEYS[key] === true) {
          throw new Error(`${label} contains forbidden field '${key}' at ${trail} — redaction fails closed`);
        }
        scan(child, `${trail}.${key}`);
      }
    }
  };
  scan(value, "$");
}

export function validateEvalTrajectoryReport(raw: unknown): EvalTrajectoryReport {
  if (typeof raw !== "object" || raw === null) throw new Error("eval trajectory report must be an object");
  assertEvalTrajectoryReportRedacted(raw, "eval trajectory report");
  const report = raw as Partial<EvalTrajectoryReport> & Record<string, unknown>;
  if (report.schemaVersion !== EVAL_TRAJECTORY_REPORT_SCHEMA_VERSION) {
    throw new Error("eval trajectory report schemaVersion must be 1");
  }
  if (!isHexSha256(report.reportId) || !isHexSha256(report.namespaceDigest) || !isHexSha256(report.inputFingerprint)) {
    throw new Error("eval trajectory report ids and digests must be sha256 hex");
  }
  if (!isIsoTimestamp(report.asOf)) throw new Error("eval trajectory report asOf must be an ISO timestamp");
  if (!Array.isArray(report.rows)) throw new Error("eval trajectory report rows must be an array");
  const contentHash = report.contentHash;
  if (!isHexSha256(contentHash)) throw new Error("eval trajectory report contentHash must be sha256 hex");
  const expectedHash = sha256Hex(canonicalJson({ ...report, contentHash: undefined }));
  if (contentHash !== expectedHash) {
    throw new Error("eval trajectory report contentHash mismatch — tampered or corrupted report");
  }
  // Bounds-check the embedded config through the same parser builders use.
  resolveEvalTrajectoryRunConfig(report.config as Partial<EvalTrajectoryRunConfig>);

  for (const row of report.rows) {
    if (typeof row !== "object" || row === null) throw new Error("report rows must be objects");
    const candidate = row as Partial<EvalActionOutcomeRow>;
    if (candidate.schemaVersion !== 1 || !isHexSha256(candidate.actionDigest)) {
      throw new Error("report row has invalid schemaVersion or actionDigest");
    }
    if (!isRowStatus(candidate.status)) throw new Error("report row has invalid status");
    if (
      candidate.outcomeDigest !== null &&
      candidate.outcomeDigest !== undefined &&
      !isHexSha256(candidate.outcomeDigest)
    ) {
      throw new Error("report row outcomeDigest must be sha256 hex or null");
    }
    if (
      (candidate.status === "joined" && (candidate.outcomeDigest == null || candidate.join == null)) ||
      (candidate.status !== "joined" && candidate.actionConditionedUtility !== null)
    ) {
      throw new Error("report row join/utility invariants violated");
    }
    for (const metric of ["taskOutcome", "contextTokenCost", "actionConditionedUtility"] as const) {
      const value = candidate[metric];
      if (value !== null && value !== undefined && !isFiniteNumber(value)) {
        throw new Error(`report row ${metric} must be numeric or null`);
      }
    }
    if (candidate.trustViolation !== 0 && candidate.trustViolation !== 1) {
      throw new Error("report row trustViolation must be 0 or 1");
    }
    if (candidate.staleMemoryHarm !== 0 && candidate.staleMemoryHarm !== 0.5 && candidate.staleMemoryHarm !== 1) {
      throw new Error("report row staleMemoryHarm must be 0, 0.5, or 1");
    }
  }
  for (let index = 1; index < report.rows.length; index += 1) {
    if (compareRows(report.rows[index - 1] as EvalActionOutcomeRow, report.rows[index] as EvalActionOutcomeRow) > 0) {
      throw new Error("report rows must be sorted by (outcomeRecordedAt, actionDigest)");
    }
  }

  // Derivable-aggregate verification: recompute from rows so tampering fails closed.
  const rows = report.rows as EvalActionOutcomeRow[];
  const statusCounts: Record<EvalTrajectoryRowStatus, number> = {
    joined: 0,
    ambiguous: 0,
    late_outcome: 0,
    future_outcome: 0,
    missing_within_window: 0,
  };
  for (const row of rows) statusCounts[row.status] += 1;
  const joinedRows = rows.filter((row) => row.status === "joined");
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const aggregates = report.aggregates;
  if (
    typeof aggregates !== "object" ||
    aggregates === null ||
    aggregates.rowCount !== rows.length ||
    canonicalJson(aggregates.statusCounts) !== canonicalJson(statusCounts) ||
    aggregates.coverage.joined !== statusCounts.joined ||
    aggregates.coverage.missingWithinWindow !== statusCounts.missing_within_window ||
    aggregates.coverage.lateOutcome !== statusCounts.late_outcome ||
    aggregates.coverage.futureOutcome !== statusCounts.future_outcome ||
    aggregates.coverage.ambiguous !== statusCounts.ambiguous ||
    aggregates.coverage.excludedFromMeans !== rows.length - statusCounts.joined ||
    aggregates.metricMeans.taskOutcome !== mean(joinedRows.map((row) => row.taskOutcome).filter(isFiniteNumber)) ||
    aggregates.metricMeans.actionConditionedUtility !==
      mean(joinedRows.map((row) => row.actionConditionedUtility).filter(isFiniteNumber)) ||
    !Array.isArray(aggregates.byAction) ||
    !aggregates.byAction.every((group) => isMemoryActionType(group.action))
  ) {
    throw new Error("eval trajectory report aggregates do not match rows — tampered or corrupted report");
  }

  return raw as EvalTrajectoryReport;
}

// ---------------------------------------------------------------------------
// Persistence (atomic write beside the existing shadow artifacts)
// ---------------------------------------------------------------------------

function assertPathWithin(rootDir: string, targetPath: string, field: string): void {
  const relative = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${field} must stay within ${rootDir}`);
}

export async function writeEvalTrajectoryReport(options: {
  memoryDir?: string;
  evalStoreDir?: string;
  report: EvalTrajectoryReport;
}): Promise<string> {
  const validated = validateEvalTrajectoryReport(options.report);
  if (!options.memoryDir && !options.evalStoreDir) {
    throw new Error("writeEvalTrajectoryReport requires memoryDir or evalStoreDir");
  }
  const rootDir = resolveEvalStoreDir(options.memoryDir ?? "", options.evalStoreDir);
  const trajectoryDir = path.join(rootDir, "trajectory", validated.asOf.slice(0, 10));
  const targetPath = path.join(trajectoryDir, `${validated.reportId}.json`);
  assertPathWithin(rootDir, targetPath, "eval trajectory report path");
  const payload = serializeEvalTrajectoryReport(validated);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await mkdir(trajectoryDir, { recursive: true });
  try {
    await writeFile(tmpPath, payload, "utf8");
    await rename(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return targetPath;
}

export async function readEvalTrajectoryReport(options: {
  reportPath: string;
  now?: string;
  maxReportAgeMs?: number;
}): Promise<EvalTrajectoryReport> {
  const raw = await readFile(options.reportPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("eval trajectory report file is not valid JSON");
  }
  const report = validateEvalTrajectoryReport(parsed);
  const nowMs = options.now !== undefined ? Date.parse(options.now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a parseable timestamp");
  const maxAgeMs = options.maxReportAgeMs ?? DEFAULT_EVAL_TRAJECTORY_REPORT_MAX_AGE_MS;
  const asOfMs = Date.parse(report.asOf);
  if (nowMs < asOfMs) throw new Error("eval trajectory report is dated after now — rejected");
  if (nowMs - asOfMs > maxAgeMs) throw new Error("eval trajectory report is expired — rejected");
  return report;
}
