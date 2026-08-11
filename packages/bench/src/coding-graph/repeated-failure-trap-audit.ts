import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { z } from "zod";
import { sanitizeFilenameSegment } from "../filename-safety.js";
import { compareCodePoints } from "../codepoint-order.js";
import {
  H6_FROZEN_SPLITS,
  validateH6Dataset,
  type H6BenchmarkDataset,
} from "./repo-gen/index.js";
import type {
  RepeatedFailureEpisodeDriver,
  RepeatedFailureFinalState,
  RepeatedFailureInvalidReason,
  RepeatedFailureEpisodeRow,
  RepeatedFailureRowCheckpoint,
  RepeatedFailureRowIdentity,
  RepeatedFailureTry,
  RepeatedFailureTokenUsage,
} from "./repeated-failure-types.js";
import type { ControlledResponsesCaps } from "./repeated-failure-responses-driver.js";
import {
  RepeatedFailureRowStore,
  MAX_ROW_ATTEMPTS,
  buildRepeatedFailureRowKey,
} from "./repeated-failure-store.js";
import {
  assertNoSymlinkComponents,
  containedPath,
  containedRegularFile,
} from "./repeated-failure-suite-shared.js";
import {
  loadFixtureBundle,
  computeAnalysisHarnessHash,
  buildModelProfileExecutionContract,
  loadModelProfile,
  createRepeatedFailureProfileDriver,
  runEpisodeForAudit,
} from "./repeated-failure-suite.js";
// Caps and tool-output limits are shared with the suite on purpose. A local
// copy silently diverged once and defeated a cap change, so import rather than
// redeclare.
import {
  DEFAULT_CAPS,
  DEFAULT_TOOL_OUTPUT_CHARS,
} from "./repeated-failure-suite-shared.js";

const ResumeTraceIdentitySchema = z.object({
  suiteVersion: z.string().min(1),
  taskId: z.string().min(1),
  variantId: z.string().min(1),
  modelProfileId: z.string().min(1),
  modelProfileHash: z.string().min(1),
  seed: z.number().int(),
  arm: z.string().min(1),
}).strict();
const ResumeTraceTokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative(),
  cacheWriteInput: z.number().int().nonnegative(),
  reasoningOutput: z.number().int().nonnegative(),
}).strict();
const ResumeTraceSchema = z.union([
  z.object({
    schemaVersion: z.literal(1),
    identity: ResumeTraceIdentitySchema,
    preflightInvalidReason: z.string().min(1),
  }).passthrough(),
  z.object({
    schemaVersion: z.literal(1),
    identity: ResumeTraceIdentitySchema,
    hostFault: z.object({ code: z.string().min(1) }).passthrough(),
    usage: ResumeTraceTokensSchema,
    finalRepoEvidence: z.object({
      checkResult: z.enum(["TRAPPED", "FIXED", "UNFIXED", "NO_TRAP", "INDETERMINATE"]),
    }).passthrough(),
  }).passthrough(),
  z.object({
    schemaVersion: z.literal(1),
    identity: ResumeTraceIdentitySchema,
    result: z.object({ usage: ResumeTraceTokensSchema }).passthrough(),
    finalRepoEvidence: z.object({
      checkResult: z.enum(["TRAPPED", "FIXED", "UNFIXED", "NO_TRAP", "INDETERMINATE"]),
    }).passthrough(),
    armAudit: z.object({ badStrategyExecuted: z.boolean() }).passthrough(),
  }).passthrough(),
]);

export interface RepeatedFailureTrapAuditRow {
  taskId: string;
  variantId: string;
  rowKey: string;
  finalState: RepeatedFailureFinalState;
  status: "VALID" | "INVALID";
  invalidReason?: RepeatedFailureInvalidReason;
  tryCount: number;
  durationMs: number;
  tokens: RepeatedFailureTokenUsage;
}

export interface RepeatedFailureTrapAuditThresholds {
  minimumTrappedRate: number;
  minimumNonFixedRate: number;
  maximumInvalidRows: 0;
  requireCompleteRows: true;
}

export interface RepeatedFailureTrapAuditMetrics {
  totalTasks: number;
  completedRows: number;
  trappedCount: number;
  trappedRate: number;
  nonFixedCount: number;
  nonFixedRate: number;
  fixedCount: number;
  unfixedCount: number;
  invalidCount: number;
  missingCount: number;
  passed: boolean;
}
export interface RepeatedFailureTrapAuditArtifact {
  schemaVersion: 1;
  modelProfileId: string;
  modelProfileHash: string;
  modelDigest: string;
  datasetInventoryHash: string;
  harnessSourceHash: string;
  decisionRuleHash: string;
  thresholds: RepeatedFailureTrapAuditThresholds;
  passed: boolean;
  metrics: RepeatedFailureTrapAuditMetrics;
  rows: readonly RepeatedFailureTrapAuditRow[];
  artifactHash: string;
}

export interface RepeatedFailureTrapAuditRowIdentity {
  taskId: string;
  variantId: string;
  rowKey: string;
}

export interface RepeatedFailureTrapAuditExpected {
  modelProfileId: string;
  modelProfileHash: string;
  modelDigest: string;
  datasetInventoryHash: string;
  harnessSourceHash: string;
  decisionRuleHash: string;
  thresholds: RepeatedFailureTrapAuditThresholds;
  rowIdentities: readonly RepeatedFailureTrapAuditRowIdentity[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

export async function assertTrapDatasetPreflight(
  dataset: H6BenchmarkDataset,
): Promise<void> {
  const report = await validateH6Dataset(dataset);
  if (report.valid) return;
  const codes = [...new Set(report.issues.map((issue) => issue.code))]
    .sort(compareCodePoints)
    .join(", ");
  throw new Error(`H6 trap dataset preflight failed: ${codes}`);
}

export function computeTrapAuditMetrics(
  rows: readonly RepeatedFailureTrapAuditRow[],
  totalTasks: number,
  thresholds: RepeatedFailureTrapAuditThresholds,
): RepeatedFailureTrapAuditMetrics {
  const completedRows = rows.length;
  let trappedCount = 0;
  let fixedCount = 0;
  let unfixedCount = 0;
  let invalidCount = 0;
  const seenTaskIds = new Set<string>();

  for (const row of rows) {
    if (seenTaskIds.has(row.taskId)) {
      invalidCount += 1;
    }
    seenTaskIds.add(row.taskId);

    if (row.status === "INVALID" || row.finalState === "INVALID") {
      invalidCount += 1;
    } else if (row.finalState === "TRAPPED") {
      trappedCount += 1;
    } else if (row.finalState === "FIXED" || row.finalState === "NO_TRAP") {
      fixedCount += 1;
    } else if (row.finalState === "UNFIXED") {
      unfixedCount += 1;
    }
  }

  const missingCount = Math.max(0, totalTasks - seenTaskIds.size);
  const nonFixedCount = trappedCount + unfixedCount + invalidCount + missingCount;
  const trappedRate = totalTasks > 0 ? trappedCount / totalTasks : 0;
  const nonFixedRate = totalTasks > 0 ? nonFixedCount / totalTasks : 0;

  const passed =
    (!thresholds.requireCompleteRows || (
      completedRows === totalTasks &&
      missingCount === 0
    )) &&
    invalidCount <= thresholds.maximumInvalidRows &&
    trappedRate >= thresholds.minimumTrappedRate &&
    nonFixedRate >= thresholds.minimumNonFixedRate;

  return {
    totalTasks,
    completedRows,
    trappedCount,
    trappedRate,
    nonFixedCount,
    nonFixedRate,
    fixedCount,
    unfixedCount,
    invalidCount,
    missingCount,
    passed,
  };
}

export function computeTrapAuditArtifactHash(
  artifactPayload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash">,
): string {
  return createHash("sha256").update(canonicalJson(artifactPayload)).digest("hex");
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTrapAuditRow(value: unknown): value is RepeatedFailureTrapAuditRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RepeatedFailureTrapAuditRow>;
  const tokens = row.tokens as Partial<RepeatedFailureTokenUsage> | undefined;
  if (
    typeof row.taskId !== "string" ||
    row.taskId.length === 0 ||
    typeof row.variantId !== "string" ||
    row.variantId.length === 0 ||
    typeof row.rowKey !== "string" ||
    row.rowKey.length === 0 ||
    !isNonnegativeSafeInteger(row.tryCount) ||
    row.tryCount < 1 ||
    row.tryCount > MAX_ROW_ATTEMPTS ||
    typeof row.durationMs !== "number" ||
    !Number.isFinite(row.durationMs) ||
    row.durationMs < 0 ||
    !tokens ||
    !isNonnegativeSafeInteger(tokens.input) ||
    !isNonnegativeSafeInteger(tokens.output) ||
    !isNonnegativeSafeInteger(tokens.total) ||
    tokens.total !== tokens.input + tokens.output ||
    !isNonnegativeSafeInteger(tokens.cachedInput) ||
    !isNonnegativeSafeInteger(tokens.cacheWriteInput) ||
    !isNonnegativeSafeInteger(tokens.reasoningOutput)
  ) {
    return false;
  }
  if (row.status === "VALID") {
    return row.finalState === "TRAPPED" ||
      row.finalState === "FIXED" ||
      row.finalState === "UNFIXED" ||
      row.finalState === "NO_TRAP";
  }
  return row.status === "INVALID" &&
    row.finalState === "INVALID" &&
    typeof row.invalidReason === "string";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort(compareCodePoints);
  const sortedExpectedKeys = [...expectedKeys].sort(compareCodePoints);
  return actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isTrapAuditThresholds(value: unknown): value is RepeatedFailureTrapAuditThresholds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, [
    "maximumInvalidRows",
    "minimumNonFixedRate",
    "minimumTrappedRate",
    "requireCompleteRows",
  ])) return false;
  const thresholds = value as Partial<RepeatedFailureTrapAuditThresholds>;
  return typeof thresholds.minimumTrappedRate === "number" &&
    Number.isFinite(thresholds.minimumTrappedRate) &&
    thresholds.minimumTrappedRate >= 0 &&
    thresholds.minimumTrappedRate <= 1 &&
    typeof thresholds.minimumNonFixedRate === "number" &&
    Number.isFinite(thresholds.minimumNonFixedRate) &&
    thresholds.minimumNonFixedRate >= 0 &&
    thresholds.minimumNonFixedRate <= 1 &&
    thresholds.maximumInvalidRows === 0 &&
    thresholds.requireCompleteRows === true;
}
type ResumeTrace = z.infer<typeof ResumeTraceSchema>;

function resumeTraceUsage(trace: ResumeTrace): RepeatedFailureTokenUsage | undefined {
  const record = trace as Record<string, unknown>;
  let candidate = record.usage;
  if (candidate === undefined) {
    const result = record.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      candidate = (result as Record<string, unknown>).usage;
    }
  }
  const parsed = ResumeTraceTokensSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

interface ResumeTraceAttempt {
  committedTry: RepeatedFailureTry;
  trace: ResumeTrace;
  usage: RepeatedFailureTokenUsage | undefined;
}

function committedTraceReference(
  entry: RepeatedFailureTry,
): { path: string; hash: string } | undefined {
  if (entry.outcome.kind === "HOST_API_FAULT") {
    return {
      path: entry.outcome.traceArtifactPath,
      hash: entry.outcome.traceArtifactHash,
    };
  }
  const evidence = entry.outcome.episode.evidence;
  return evidence
    ? { path: evidence.traceArtifactPath, hash: evidence.traceArtifactHash }
    : undefined;
}

async function loadCheckpointTraceAttempts(
  outputRoot: string,
  identity: RepeatedFailureRowIdentity,
  rowKey: string,
  checkpoint: RepeatedFailureRowCheckpoint,
): Promise<readonly ResumeTraceAttempt[] | undefined> {
  const terminal = checkpoint.terminal;
  if (!terminal || checkpoint.tries.length !== terminal.tryCount) return undefined;

  const attempts: ResumeTraceAttempt[] = [];
  for (const [index, committedTry] of checkpoint.tries.entries()) {
    const reference = committedTraceReference(committedTry);
    if (!reference || reference.path !== `traces/${rowKey}/attempt-${index + 1}.json`) {
      return undefined;
    }

    const tracePath = await containedRegularFile(outputRoot, reference.path);
    const traceBytes = await readFile(tracePath);
    if (createHash("sha256").update(traceBytes).digest("hex") !== reference.hash) {
      return undefined;
    }

    const parsed = ResumeTraceSchema.safeParse(JSON.parse(traceBytes.toString("utf8")));
    if (!parsed.success || canonicalJson(parsed.data.identity) !== canonicalJson(identity)) {
      return undefined;
    }
    const usage = resumeTraceUsage(parsed.data);
    if (usage
      ? canonicalJson(usage) !== canonicalJson(committedTry.tokens)
      : Object.values(committedTry.tokens).some((value) => value !== 0)) {
      return undefined;
    }
    attempts.push({ committedTry, trace: parsed.data, usage });
  }
  return attempts;
}

function cumulativeAttemptUsage(
  attempts: readonly ResumeTraceAttempt[],
): RepeatedFailureTokenUsage | undefined {
  const total: RepeatedFailureTokenUsage = {
    input: 0,
    output: 0,
    total: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    reasoningOutput: 0,
  };
  for (const attempt of attempts) {
    if (!attempt.usage) return undefined;
    total.input += attempt.usage.input;
    total.output += attempt.usage.output;
    total.total += attempt.usage.total;
    total.cachedInput += attempt.usage.cachedInput;
    total.cacheWriteInput += attempt.usage.cacheWriteInput;
    total.reasoningOutput += attempt.usage.reasoningOutput;
  }
  return total;
}

async function resumedTraceMatches(
  outputRoot: string,
  identity: RepeatedFailureRowIdentity,
  rowKey: string,
  checkpoint: RepeatedFailureRowCheckpoint,
): Promise<boolean> {
  const row = checkpoint.terminal;
  if (!row || !row.evidence) return false;
  try {
    const attempts = await loadCheckpointTraceAttempts(outputRoot, identity, rowKey, checkpoint);
    if (!attempts || attempts.length === 0) return false;
    const terminalAttempt = attempts.at(-1);
    if (!terminalAttempt) return false;
    const terminalReference = committedTraceReference(terminalAttempt.committedTry);
    if (!terminalReference ||
      row.evidence.traceArtifactPath !== terminalReference.path ||
      row.evidence.traceArtifactHash !== terminalReference.hash) {
      return false;
    }

    const trace = terminalAttempt.trace;
    if ("preflightInvalidReason" in trace) {
      return row.status === "INVALID" &&
        row.finalState === "INVALID" &&
        row.invalidReason === trace.preflightInvalidReason;
    }

    const cumulativeUsage = cumulativeAttemptUsage(attempts);
    if (!cumulativeUsage) return false;
    const traceCheckResult = trace.finalRepoEvidence.checkResult === "FIXED" ||
      trace.finalRepoEvidence.checkResult === "NO_TRAP"
      ? "PASS"
      : trace.finalRepoEvidence.checkResult === "INDETERMINATE"
        ? "INDETERMINATE"
        : "FAIL";
    if ("hostFault" in trace) {
      return row.status === "INVALID" &&
        row.finalState === "INVALID" &&
        row.invalidReason === "HOST_RETRIES_EXHAUSTED" &&
        canonicalJson(cumulativeUsage) === canonicalJson(row.tokens) &&
        traceCheckResult === row.evidence.checkResult;
    }
    const finalStateMatches = row.status === "VALID"
      ? row.finalState === trace.finalRepoEvidence.checkResult
      : row.finalState === "INVALID";
    return finalStateMatches &&
      canonicalJson(cumulativeUsage) === canonicalJson(row.tokens) &&
      traceCheckResult === row.evidence.checkResult &&
      row.evidence.repeatedFailure === (
        trace.finalRepoEvidence.checkResult === "TRAPPED" && trace.armAudit.badStrategyExecuted
      );
  } catch {
    return false;
  }
}

function rowIdentityKey(identity: RepeatedFailureTrapAuditRowIdentity): string {
  return canonicalJson({
    rowKey: identity.rowKey,
    taskId: identity.taskId,
    variantId: identity.variantId,
  });
}

function validatedExpectedRowIdentityKeys(
  identities: readonly RepeatedFailureTrapAuditRowIdentity[],
): string[] | undefined {
  if (identities.length === 0) return undefined;
  const keys = identities.map((identity) => {
    if (
      !identity ||
      typeof identity !== "object" ||
      typeof identity.taskId !== "string" ||
      identity.taskId.length === 0 ||
      typeof identity.variantId !== "string" ||
      identity.variantId.length === 0 ||
      typeof identity.rowKey !== "string" ||
      identity.rowKey.length === 0
    ) return undefined;
    return rowIdentityKey(identity);
  });
  if (keys.some((key) => key === undefined)) return undefined;
  const definedKeys = keys as string[];
  if (new Set(definedKeys).size !== definedKeys.length) return undefined;
  return definedKeys.sort(compareCodePoints);
}

export function verifyTrapAuditArtifact(
  artifact: unknown,
  expected: RepeatedFailureTrapAuditExpected,
): { valid: boolean; error?: string } {
  if (!expected) {
    return { valid: false, error: "expected decision rule is required for trap-audit verification" };
  }
  if (
    typeof expected.modelProfileId !== "string" ||
    expected.modelProfileId.length === 0 ||
    !isSha256(expected.modelProfileHash) ||
    !isSha256(expected.modelDigest) ||
    !isSha256(expected.datasetInventoryHash) ||
    !isSha256(expected.harnessSourceHash) ||
    !isSha256(expected.decisionRuleHash) ||
    !isTrapAuditThresholds(expected.thresholds) ||
    !Array.isArray(expected.rowIdentities)
  ) {
    return { valid: false, error: "expected trap-audit identity or decision rule is invalid" };
  }
  const expectedRowIdentityKeys = validatedExpectedRowIdentityKeys(expected.rowIdentities);
  if (!expectedRowIdentityKeys) {
    return { valid: false, error: "expected trap-audit row identities are invalid" };
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { valid: false, error: "audit artifact is not an object" };
  }
  if (!hasExactKeys(artifact, [
    "artifactHash",
    "datasetInventoryHash",
    "decisionRuleHash",
    "harnessSourceHash",
    "metrics",
    "modelProfileHash",
    "modelDigest",
    "modelProfileId",
    "passed",
    "rows",
    "schemaVersion",
    "thresholds",
  ])) {
    return { valid: false, error: "audit artifact fields do not match schemaVersion 1" };
  }

  const art = artifact as RepeatedFailureTrapAuditArtifact;
  if (art.schemaVersion !== 1) {
    return { valid: false, error: "invalid schemaVersion (expected 1)" };
  }
  if (
    typeof art.modelProfileId !== "string" ||
    art.modelProfileId.length === 0 ||
    !isSha256(art.modelProfileHash) ||
    !isSha256(art.modelDigest) ||
    !isSha256(art.datasetInventoryHash) ||
    !isSha256(art.harnessSourceHash) ||
    !isSha256(art.decisionRuleHash)
  ) {
    return { valid: false, error: "audit identity contains a missing or invalid hash" };
  }
  if (!isTrapAuditThresholds(art.thresholds)) {
    return { valid: false, error: "audit trap-audit thresholds are invalid" };
  }
  if (!isSha256(art.artifactHash)) {
    return { valid: false, error: "missing or invalid artifactHash" };
  }

  const { artifactHash, ...payload } = art;
  const computedHash = computeTrapAuditArtifactHash(payload);
  if (computedHash !== artifactHash) {
    return { valid: false, error: "artifactHash mismatch (tampered audit artifact)" };
  }
  if (art.modelProfileId !== expected.modelProfileId) {
    return {
      valid: false,
      error: `modelProfileId mismatch: expected ${expected.modelProfileId}, got ${art.modelProfileId}`,
    };
  }
  if (art.modelProfileHash !== expected.modelProfileHash) {
    return {
      valid: false,
      error: `modelProfileHash mismatch: expected ${expected.modelProfileHash}, got ${art.modelProfileHash}`,
    };
  }
  if (art.modelDigest !== expected.modelDigest) {
    return {
      valid: false,
      error: `modelDigest mismatch: expected ${expected.modelDigest}, got ${art.modelDigest}`,
    };
  }
  if (art.datasetInventoryHash !== expected.datasetInventoryHash) {
    return {
      valid: false,
      error: `datasetInventoryHash mismatch: expected ${expected.datasetInventoryHash}, got ${art.datasetInventoryHash}`,
    };
  }
  if (art.harnessSourceHash !== expected.harnessSourceHash) {
    return {
      valid: false,
      error: `harnessSourceHash mismatch: expected ${expected.harnessSourceHash}, got ${art.harnessSourceHash}`,
    };
  }
  if (art.decisionRuleHash !== expected.decisionRuleHash) {
    return {
      valid: false,
      error: `decisionRuleHash mismatch: expected ${expected.decisionRuleHash}, got ${art.decisionRuleHash}`,
    };
  }
  if (canonicalJson(art.thresholds) !== canonicalJson(expected.thresholds)) {
    return { valid: false, error: "trap-audit thresholds do not match the frozen decision rule" };
  }
  if (
    typeof art.passed !== "boolean" ||
    !art.metrics ||
    typeof art.metrics !== "object" ||
    Array.isArray(art.metrics) ||
    !hasExactKeys(art.metrics, [
      "completedRows",
      "fixedCount",
      "invalidCount",
      "missingCount",
      "nonFixedCount",
      "nonFixedRate",
      "passed",
      "totalTasks",
      "trappedCount",
      "trappedRate",
      "unfixedCount",
    ]) ||
    !isNonnegativeSafeInteger(art.metrics.totalTasks) ||
    !Array.isArray(art.rows) ||
    !art.rows.every(isTrapAuditRow)
  ) {
    return { valid: false, error: "audit rows or metrics are invalid" };
  }
  const actualRowIdentityKeys = art.rows
    .map(rowIdentityKey)
    .sort(compareCodePoints);
  if (canonicalJson(actualRowIdentityKeys) !== canonicalJson(expectedRowIdentityKeys)) {
    return { valid: false, error: "audit row identities do not match the frozen dataset" };
  }

  const totalTasks = expectedRowIdentityKeys.length;
  if (art.metrics.totalTasks !== totalTasks) {
    return {
      valid: false,
      error: `totalTasks mismatch: expected ${totalTasks}, got ${art.metrics.totalTasks}`,
    };
  }

  const recomputed = computeTrapAuditMetrics(
    art.rows,
    totalTasks,
    expected.thresholds,
  );
  if (
    canonicalJson(recomputed) !== canonicalJson(art.metrics) ||
    art.passed !== recomputed.passed
  ) {
    return { valid: false, error: "audit metrics or pass verdict recomputation mismatch" };
  }
  if (!recomputed.passed) {
    return {
      valid: false,
      error: `audit did not pass (trappedRate=${recomputed.trappedRate.toFixed(2)}, nonFixedRate=${recomputed.nonFixedRate.toFixed(2)}, invalidCount=${recomputed.invalidCount}, missingCount=${recomputed.missingCount})`,
    };
  }

  return { valid: true };
}

export interface RunTrapAuditOptions {
  driver: RepeatedFailureEpisodeDriver;
  outputDir: string;
  fixtureDir?: string;
  decisionRuleFile?: string;
  seed?: number;
  maxHostRetries?: 0 | 1 | 2 | 3 | 4 | 5;
  caps?: Partial<ControlledResponsesCaps>;
  maxToolOutputChars?: number;
}

export async function runTrapAudit(
  options: RunTrapAuditOptions,
): Promise<RepeatedFailureTrapAuditArtifact> {
  const outputRoot = path.resolve(options.outputDir);
  await assertNoSymlinkComponents(path.parse(outputRoot).root, outputRoot);
  const bundle = await loadFixtureBundle(options.fixtureDir, options.decisionRuleFile);
  await assertTrapDatasetPreflight(bundle.dataset);
  const harnessSourceHash = await computeAnalysisHarnessHash();
  await options.driver.preflight?.();
  await mkdir(outputRoot, { recursive: true });
  const seed = options.seed ?? 1;
  const store = new RepeatedFailureRowStore(outputRoot);
  const auditRows: RepeatedFailureTrapAuditRow[] = [];

  for (const task of bundle.dataset.tasks) {
    const variant = task.variants[0];
    if (!variant) continue;

    const identity: RepeatedFailureRowIdentity = {
      suiteVersion: `h6-failure-gate-v1-${bundle.dataset.inventoryHash}-${harnessSourceHash}`,
      taskId: task.id,
      variantId: variant.variantId,
      modelProfileId: options.driver.modelProfileId,
      modelProfileHash: options.driver.modelProfileHash,
      seed,
      arm: "NO_MEMORY",
    };

    const rowKey = buildRepeatedFailureRowKey(identity);

    const loaded = await store.load(identity);
    if (loaded.kind === "MALFORMED") throw loaded.error;
    const checkpoint = loaded.kind === "VALID" ? loaded.checkpoint : undefined;
    const resumedRow = checkpoint?.terminal;
    if (checkpoint?.terminal && !(await resumedTraceMatches(outputRoot, identity, rowKey, checkpoint))) {
      throw new Error(`trap-audit checkpoint ${rowKey} has invalid trace evidence`);
    }
    const episodeRow = resumedRow ?? await runEpisodeForAudit({
      identity,
      rowKey,
      task,
      variant,
      driver: options.driver,
      store,
      caps: options.caps,
      maxHostRetries: options.maxHostRetries,
      maxToolOutputChars: options.maxToolOutputChars,
    });
    auditRows.push({
      taskId: task.id,
      variantId: variant.variantId,
      rowKey,
      finalState: episodeRow.finalState,
      status: episodeRow.status,
      invalidReason: episodeRow.invalidReason,
      tryCount: episodeRow.tryCount,
      durationMs: episodeRow.durationMs,
      tokens: episodeRow.tokens,
    });
  }

  const metrics = computeTrapAuditMetrics(
    auditRows,
    bundle.dataset.tasks.length,
    bundle.decisionRule.trapAudit,
  );

  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: options.driver.modelProfileId,
    modelProfileHash: options.driver.modelProfileHash,
    modelDigest: options.driver.modelDigest,
    datasetInventoryHash: bundle.dataset.inventoryHash,
    harnessSourceHash,
    decisionRuleHash: createHash("sha256").update(bundle.decisionRuleBytes).digest("hex"),
    thresholds: bundle.decisionRule.trapAudit,
    passed: metrics.passed,
    metrics,
    rows: auditRows,
  };

  const artifactHash = computeTrapAuditArtifactHash(payload);
  const artifact: RepeatedFailureTrapAuditArtifact = {
    ...payload,
    artifactHash,
  };

  const profileId = sanitizeFilenameSegment(options.driver.modelProfileId);
  const filename = `trap-audit-${profileId}-${options.driver.modelProfileHash}.json`;
  const filePath = containedPath(outputRoot, filename);
  await assertNoSymlinkComponents(outputRoot, filePath);
  await writeFileAtomically(filePath, JSON.stringify(artifact, null, 2));

  return artifact;
}

export async function verifyMatchingTrapAudit(
  profile: { id: string; hash: string; modelDigest: string },
  datasetInventoryHash: string,
  harnessSourceHash: string,
  decisionRule: {
    hash: string;
    trapAudit: RepeatedFailureTrapAuditThresholds;
  },
  searchDirs: readonly string[],
): Promise<RepeatedFailureTrapAuditArtifact> {
  const targetFiles: string[] = [
    `trap-audit-${profile.id}-${profile.hash}.json`,
    `trap-audit-${profile.id}.json`,
    "trap-audit.json",
    "audit.json",
  ];
  const rowIdentities = [
    ...H6_FROZEN_SPLITS.dev,
    ...H6_FROZEN_SPLITS.pilot,
    ...H6_FROZEN_SPLITS.main,
  ].map((taskId): RepeatedFailureTrapAuditRowIdentity => {
    const variantId = `${taskId}-v1`;
    return {
      taskId,
      variantId,
      rowKey: buildRepeatedFailureRowKey({
        suiteVersion: `h6-failure-gate-v1-${datasetInventoryHash}-${harnessSourceHash}`,
        taskId,
        variantId,
        modelProfileId: profile.id,
        modelProfileHash: profile.hash,
        seed: 1,
        arm: "NO_MEMORY",
      }),
    };
  });

  for (const dir of searchDirs) {
    if (!dir) continue;
    try {
      const searchRoot = path.resolve(dir);
      await assertNoSymlinkComponents(path.parse(searchRoot).root, searchRoot);
      const filesInDir = await readdir(searchRoot).catch(() => []);
      for (const file of filesInDir) {
        if (!file.endsWith(".json")) continue;
        if (!targetFiles.includes(file) && !file.startsWith("trap-audit")) continue;

        const filePath = await containedRegularFile(searchRoot, file);
        const content = await readFile(filePath, "utf8").catch(() => undefined);
        if (!content) continue;

        try {
          const parsed = JSON.parse(content) as unknown;
          const verification = verifyTrapAuditArtifact(parsed, {
            modelProfileId: profile.id,
            modelProfileHash: profile.hash,
            modelDigest: profile.modelDigest,
            datasetInventoryHash,
            harnessSourceHash,
            decisionRuleHash: decisionRule.hash,
            thresholds: decisionRule.trapAudit,
            rowIdentities,
          });

          if (verification.valid) {
            return parsed as RepeatedFailureTrapAuditArtifact;
          }
        } catch {
          // ignore unparseable files
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  throw new Error(
    `No matching passed trap audit artifact found for model profile ${profile.id} (${profile.hash}). Run trap-audit before running pilot or main.`,
  );
}

export async function runTrapAuditCliCommand(input: {
  profilePaths: readonly string[];
  outputDir: string;
  fixtureDir?: string;
  maxSteps?: number;
  decisionRuleFile?: string;
  maxToolCalls?: number;
  maxOutputChars?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
}): Promise<{ exitCode: number; output: string }> {
  if (input.profilePaths.length === 0) {
    return { exitCode: 1, output: "trap-audit requires at least one --profile FILE" };
  }

  const bundle = await loadFixtureBundle(input.fixtureDir, input.decisionRuleFile);
  const caps: ControlledResponsesCaps = {
    ...DEFAULT_CAPS,
    ...(input.maxSteps !== undefined ? { maxTurns: input.maxSteps } : {}),
    ...(input.maxToolCalls !== undefined ? { maxToolCalls: input.maxToolCalls } : {}),
    ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
  };
  const maxToolOutputChars = input.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  const executionContract = buildModelProfileExecutionContract(
    bundle,
    caps,
    maxToolOutputChars,
  );

  const profiles = await Promise.all(
    input.profilePaths.map((profilePath) => loadModelProfile(profilePath, executionContract)),
  );

  const apiKey = process.env.OPENAI_API_KEY;
  if (
    profiles.some((entry) => (
      entry.profile.provider === "openai-responses" && entry.profile.endpoint === undefined
    )) &&
    !apiKey
  ) {
    throw new Error("OPENAI_API_KEY environment variable is required for official OpenAI model profiles");
  }

  const drivers = profiles.map(({ profile }) =>
    createRepeatedFailureProfileDriver(profile, executionContract, apiKey),
  );

  const results: RepeatedFailureTrapAuditArtifact[] = [];
  let allPassed = true;

  for (const driver of drivers) {
    const artifact = await runTrapAudit({
      driver,
      outputDir: input.outputDir,
      fixtureDir: input.fixtureDir,
      ...(input.decisionRuleFile === undefined ? {} : { decisionRuleFile: input.decisionRuleFile }),
      caps,
      maxToolOutputChars,
    });
    results.push(artifact);
    if (!artifact.passed) {
      allPassed = false;
    }
  }

  const outputLines = [
    `Trap-effectiveness audit finished: ${results.length} profile(s).`,
    ...results.map((art) =>
      `  - ${art.modelProfileId} (${art.modelProfileHash.slice(0, 12)}): ` +
      `${art.passed ? "PASSED" : "FAILED"} ` +
      `trapped=${art.metrics.trappedCount}/${art.metrics.totalTasks} (${(art.metrics.trappedRate * 100).toFixed(1)}%), ` +
      `nonFixed=${art.metrics.nonFixedCount}/${art.metrics.totalTasks} (${(art.metrics.nonFixedRate * 100).toFixed(1)}%), ` +
      `invalid=${art.metrics.invalidCount}`,
    ),
    `Artifacts saved to ${input.outputDir}`,
  ];

  return {
    exitCode: allPassed ? 0 : 1,
    output: outputLines.join("\n"),
  };
}
