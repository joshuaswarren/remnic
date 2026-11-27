
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchJudge } from "../adapters/types.js";
import type { BenchmarkArtifactJudgeCalibration } from "../published-artifact.js";
import {
  DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
  binarizeJudgeScore,
  bootstrapCohensKappaConfidenceInterval,
  computeCohensKappa,
  DEFAULT_KAPPA_BOOTSTRAP_SAMPLES,
  DEFAULT_KAPPA_CONFIDENCE_LEVEL,
  type BootstrapKappaOptions,
  type BootstrapKappaResult,
  type KappaConfidenceInterval,
  type CohenKappaResult,
  type JudgeCategory,
} from "./cohen-kappa.js";
export interface JudgeCalibrationIdentities {
  localJudgeProvider: string;
  localJudgeModel: string;
  frontierJudgeProvider: string;
  frontierJudgeModel: string;
}

export type LoadedJudgeCalibrationState = BenchmarkArtifactJudgeCalibration &
  Partial<JudgeCalibrationIdentities> & {
    /** Stored-result id that pins the answer payload across recalibrations. */
    sourceResultId?: string;
    /** Stable hash of the exact question/predicted/expected triples judged. */
    answerSetHash?: string;
    /** Stable hash of the full ordered source question-id list. */
    orderedQuestionIdsHash?: string;
    /** Question ids in the pinned calibration slice, in verdict order. */
    sliceQuestionIds?: readonly string[];
    /** Full sanitized provider configuration hashes bound to this calibration. */
    localJudgeConfigHash?: string;
    frontierJudgeConfigHash?: string;
  };

export const CALIBRATION_SLICE_SIZE = 200;

export const MIN_CALIBRATION_SOURCE_TASKS = 10;

/**
 * Kappa below this triggers a loud "local judge unreliable for this
 * benchmark" warning in the report and on the artifact. 0.7 is the
 * conventional "substantial agreement" cut-off (Landis & Koch 1977).
 */
export const JUDGE_CALIBRATION_KAPPA_THRESHOLD = 0.7;

export interface CalibrationAnswer {
  /** Stable question id (matches `BenchmarkArtifactPerTaskScore.taskId`). */
  questionId: string;
  question: string;
  predicted: string;
  expected: string;
}

export interface CalibrationVerdictPair {
  questionId: string;
  localCategory: JudgeCategory;
  frontierCategory: JudgeCategory;
}

export const JUDGE_CALIBRATION_PROTOCOL_VERSION = "judge-calibration-v3";

export const DEFAULT_JUDGE_BINNING_IDENTITY =
  "default-binary-score-v1:incorrect<0.5,correct>=0.5,nonfinite=incorrect";

export interface JudgeCalibrationCheckpointProvenance {
  dir: string;
  sourceResultId: string;
  sourceResultSha256: string;
  orderedQuestionIdsHash: string;
  localJudgePromptIdentity: string;
  frontierJudgePromptIdentity: string;
  localJudgeConfigHash: string;
  frontierJudgeConfigHash: string;
}

export interface RunJudgeCalibrationOptions {
  benchmarkId: string;
  localJudge: BenchJudge;
  frontierJudge: BenchJudge;
  answers: readonly CalibrationAnswer[];
  /**
   * Maps a numeric judge score to a category label. Defaults to
   * `binarizeJudgeScore` (correct/incorrect at 0.5). Both judges share one
   * binning function so they are compared on the same scale.
   */
  binScore?: (score: number) => JudgeCategory;
  /** Stable identity of `binScore`; required with a custom mapper and checkpointing. */
  binningIdentity?: string;
  /** Override the slice size (default 200; mainly for tests). */
  sliceSize?: number;
  /** Override the warning threshold (default 0.7). */
  threshold?: number;
  /** Override paired-bootstrap resamples (default 2,000; mainly for tests). */
  bootstrapSamples?: number;
  /** Override confidence level (default 0.95). */
  confidenceLevel?: number;
  /** Exact persisted question-id slice to reuse instead of reselecting. */
  pinnedQuestionIds?: readonly string[];
  /** Fail before judge calls when the pinned answer payload changed. */
  expectedAnswerSetHash?: string;
  /** Fail before judge calls when the full source task-id order changed. */
  expectedOrderedQuestionIdsHash?: string;
  /** Durable per-judge-side resume state. A mismatch or corrupt file fails closed. */
  checkpoint?: JudgeCalibrationCheckpointProvenance;
}

export interface JudgeCalibrationResult extends CohenKappaResult {
  benchmarkId: string;
  sliceQuestionIds: readonly string[];
  threshold: number;
  warning: boolean;
  /** Paired-bootstrap percentile interval for kappa. */
  confidenceInterval: KappaConfidenceInterval;
  /** Number of paired-bootstrap resamples. */
  bootstrapSamples: number;
  /** SHA-256 of the exact ordered answer triples used for calibration. */
  answerSetHash: string;
  /** Per-question verdict pairs, in slice order. */
  verdicts: readonly CalibrationVerdictPair[];
  /** Execution provenance distinguishes resumed outputs from fresh model calls. */
  execution: {
    localJudgeCalls: number;
    frontierJudgeCalls: number;
    resumedJudgeOutputs: number;
    checkpointPath?: string;
    checkpointContractHash?: string;
  };
}

export function selectCalibrationSlice(
  questionIds: readonly string[],
  size: number = CALIBRATION_SLICE_SIZE,
): string[] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`selectCalibrationSlice: size must be a positive integer; got ${String(size)}.`);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of questionIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`selectCalibrationSlice: question ids must be non-empty strings; got ${String(id)}.`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique
    .map((id) => ({ id, digest: createHash("sha256").update(id, "utf8").digest("hex") }))
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0))
    .slice(0, Math.min(size, unique.length))
    .map((entry) => entry.id);
}

export async function runJudgeCalibration(
  options: RunJudgeCalibrationOptions,
): Promise<JudgeCalibrationResult> {
  const binScore = options.binScore ?? ((score: number) => binarizeJudgeScore(score));
  const threshold = options.threshold ?? JUDGE_CALIBRATION_KAPPA_THRESHOLD;
  const sliceSize = options.sliceSize ?? CALIBRATION_SLICE_SIZE;

  const availableIds = new Set(options.answers.map((answer) => answer.questionId));
  const sliceIds = options.pinnedQuestionIds
    ? validatePinnedQuestionIds(options.pinnedQuestionIds, availableIds)
    : selectCalibrationSlice([...availableIds], sliceSize);
  const sliceIdSet = new Set(sliceIds);
  const answerById = new Map<string, CalibrationAnswer>();
  for (const answer of options.answers) {
    if (sliceIdSet.has(answer.questionId) && !answerById.has(answer.questionId)) {
      answerById.set(answer.questionId, answer);
    }
  }
  const sliceAnswers = sliceIds
    .map((id) => answerById.get(id))
    .filter((answer): answer is CalibrationAnswer => answer !== undefined);
  const answerSetHash = hashCalibrationAnswerSet(sliceAnswers);
  const orderedQuestionIdsHash = hashOrderedQuestionIds(options.answers.map((answer) => answer.questionId));
  if (
    options.expectedOrderedQuestionIdsHash !== undefined &&
    orderedQuestionIdsHash !== options.expectedOrderedQuestionIdsHash
  ) {
    throw new Error(
      `runJudgeCalibration: ordered question-id list changed (expected sha256:${options.expectedOrderedQuestionIdsHash}, got sha256:${orderedQuestionIdsHash}).`,
    );
  }
  if (
    options.expectedAnswerSetHash !== undefined &&
    answerSetHash !== options.expectedAnswerSetHash
  ) {
    throw new Error(
      `runJudgeCalibration: pinned answer set changed (expected sha256:${options.expectedAnswerSetHash}, got sha256:${answerSetHash}). Restore the original stored result or intentionally reset calibration state.`,
    );
  }

  if (options.checkpoint && options.binScore && !options.binningIdentity) {
    throw new Error("runJudgeCalibration: checkpointed custom binScore requires an explicit binningIdentity.");
  }
  const binningIdentity = options.binningIdentity ?? DEFAULT_JUDGE_BINNING_IDENTITY;
  const checkpoint = options.checkpoint
    ? await loadOrInitializeCheckpoint(
      options.benchmarkId,
      { ...options.checkpoint, binningIdentity },
      sliceIds,
      answerSetHash,
      orderedQuestionIdsHash,
    )
    : undefined;

  const localLabels: JudgeCategory[] = [];
  const frontierLabels: JudgeCategory[] = [];
  const verdicts: CalibrationVerdictPair[] = [];
  let localJudgeCalls = 0;
  let frontierJudgeCalls = 0;
  let resumedJudgeOutputs = 0;

  try {
    for (const answer of sliceAnswers) {
      const saved = checkpoint?.state.completed[answer.questionId];
      let localCategory = saved?.localCategory;
      if (localCategory !== undefined) {
        resumedJudgeOutputs += 1;
      } else {
        const localScore = await options.localJudge.score(answer.question, answer.predicted, answer.expected);
        localJudgeCalls += 1;
        localCategory = binScore(localScore);
        if (checkpoint) {
          checkpoint.state.completed[answer.questionId] = { ...saved, localCategory };
          await writeCalibrationCheckpoint(checkpoint.path, checkpoint.state);
        }
      }
      let frontierCategory = checkpoint?.state.completed[answer.questionId]?.frontierCategory;
      if (frontierCategory !== undefined) {
        resumedJudgeOutputs += 1;
      } else {
        const frontierScore = await options.frontierJudge.score(answer.question, answer.predicted, answer.expected);
        frontierJudgeCalls += 1;
        frontierCategory = binScore(frontierScore);
        if (checkpoint) {
          checkpoint.state.completed[answer.questionId] = {
            ...checkpoint.state.completed[answer.questionId],
            frontierCategory,
          };
          await writeCalibrationCheckpoint(checkpoint.path, checkpoint.state);
        }
      }
      localLabels.push(localCategory);
      frontierLabels.push(frontierCategory);
      verdicts.push({
        questionId: answer.questionId,
        localCategory,
        frontierCategory,
      });
    }

    const kappaResult = computeCohensKappa(localLabels, frontierLabels);
    const bootstrap = bootstrapCohensKappaConfidenceInterval(localLabels, frontierLabels, {
      iterations: options.bootstrapSamples ?? DEFAULT_KAPPA_BOOTSTRAP_SAMPLES,
      level: options.confidenceLevel,
    });
    const warning = kappaResult.kappa < threshold;

    return {
      ...kappaResult,
      benchmarkId: options.benchmarkId,
      sliceQuestionIds: sliceIds,
      threshold,
      warning,
      confidenceInterval: bootstrap.confidenceInterval,
      bootstrapSamples: bootstrap.bootstrapSamples,
      answerSetHash,
      verdicts,
      execution: {
        localJudgeCalls,
        frontierJudgeCalls,
        resumedJudgeOutputs,
        ...(checkpoint ? {
          checkpointPath: checkpoint.path,
          checkpointContractHash: checkpoint.state.contractHash,
        } : {}),
      },
    };
  } finally {
    await checkpoint?.release();
  }
}

export function hashOrderedQuestionIds(questionIds: readonly string[]): string {
  if (questionIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("hashOrderedQuestionIds: question ids must be non-empty strings.");
  }
  return createHash("sha256").update(JSON.stringify(questionIds), "utf8").digest("hex");
}

function validatePinnedQuestionIds(
  ids: readonly string[],
  availableIds: ReadonlySet<string>,
): string[] {
  if (
    ids.length === 0 || ids.length > CALIBRATION_SLICE_SIZE ||
    ids.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`runJudgeCalibration: pinned question ids must contain 1 to ${CALIBRATION_SLICE_SIZE} unique non-empty strings.`);
  }
  const missing = ids.filter((id) => !availableIds.has(id));
  if (missing.length > 0) {
    throw new Error(`runJudgeCalibration: pinned answer set is missing ${missing.length} question id(s), including "${missing[0]}".`);
  }
  return [...ids];
}

function hashCalibrationAnswerSet(answers: readonly CalibrationAnswer[]): string {
  return createHash("sha256")
    .update(JSON.stringify(answers.map((answer) => [
      answer.questionId,
      answer.question,
      answer.predicted,
      answer.expected,
    ])))
    .digest("hex");
}

interface CalibrationCheckpointState {
  schemaVersion: 2;
  contractHash: string;
  contract: Record<string, unknown>;
  completed: Record<string, { localCategory?: JudgeCategory; frontierCategory?: JudgeCategory }>;
}

async function loadOrInitializeCheckpoint(
  benchmarkId: string,
  provenance: JudgeCalibrationCheckpointProvenance & { binningIdentity: string },
  sliceQuestionIds: readonly string[],
  answerSetHash: string,
  orderedQuestionIdsHash: string,
): Promise<{ path: string; state: CalibrationCheckpointState; release: () => Promise<void> }> {
  for (const [name, digest] of Object.entries({
    sourceResultSha256: provenance.sourceResultSha256,
    orderedQuestionIdsHash,
    localJudgeConfigHash: provenance.localJudgeConfigHash,
    frontierJudgeConfigHash: provenance.frontierJudgeConfigHash,
  })) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`runJudgeCalibration: ${name} must be a lowercase SHA-256 digest.`);
  }
  if (
    !provenance.sourceResultId || !provenance.localJudgePromptIdentity ||
    !provenance.frontierJudgePromptIdentity || !provenance.binningIdentity
  ) {
    throw new Error("runJudgeCalibration: checkpoint sourceResultId, prompt identities, and binningIdentity are required.");
  }
  if (provenance.orderedQuestionIdsHash !== orderedQuestionIdsHash) {
    throw new Error("runJudgeCalibration: checkpoint ordered-question-id hash does not match the validated source.");
  }
  await ensurePrivateDirectory(provenance.dir);
  const checkpointPath = path.join(provenance.dir, `${sanitizeCalibrationSegment(benchmarkId)}.checkpoint.json`);
  const lockPath = `${checkpointPath}.lock`;
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    await chmod(lockPath, 0o600);
  } catch (error) {
    if (lockHandle) {
      await lockHandle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `runJudgeCalibration: checkpoint is locked at ${lockPath}; refusing concurrent or stale-lock recovery to avoid duplicate paid judge calls.`,
      );
    }
    throw error;
  }
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    if (!lockHandle) throw new Error(`runJudgeCalibration: checkpoint lock handle was not acquired for ${lockPath}.`);
    released = true;
    await lockHandle.close();
    await unlink(lockPath);
  };
  try {
    const contract = {
      protocolVersion: JUDGE_CALIBRATION_PROTOCOL_VERSION,
      benchmarkId,
      sourceResultId: provenance.sourceResultId,
      sourceResultSha256: provenance.sourceResultSha256,
      orderedQuestionIdsHash: provenance.orderedQuestionIdsHash,
      answerSetHash,
      sliceQuestionIds,
      localJudgePromptIdentity: provenance.localJudgePromptIdentity,
      frontierJudgePromptIdentity: provenance.frontierJudgePromptIdentity,
      localJudgeConfigHash: provenance.localJudgeConfigHash,
      frontierJudgeConfigHash: provenance.frontierJudgeConfigHash,
      binningIdentity: provenance.binningIdentity,
    };
    const contractHash = createHash("sha256").update(stableJson(contract)).digest("hex");
    let raw: string;
    try {
      const info = await lstat(checkpointPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("checkpoint path is not a regular file");
      raw = await readFile(checkpointPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state: CalibrationCheckpointState = { schemaVersion: 2, contractHash, contract, completed: {} };
      await writeCalibrationCheckpoint(checkpointPath, state);
      return { path: checkpointPath, state, release };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`runJudgeCalibration: corrupt checkpoint at ${checkpointPath}; refusing to call judges.`); }
    if (!isValidCheckpoint(parsed, new Set(sliceQuestionIds))) {
      throw new Error(`runJudgeCalibration: corrupt checkpoint at ${checkpointPath}; refusing to call judges.`);
    }
    if (parsed.contractHash !== contractHash || stableJson(parsed.contract) !== stableJson(contract)) {
      throw new Error(`runJudgeCalibration: checkpoint contract mismatch at ${checkpointPath}; refusing to call judges.`);
    }
    await chmod(checkpointPath, 0o600);
    return { path: checkpointPath, state: parsed, release };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

function isValidCheckpoint(value: unknown, sliceIds: ReadonlySet<string>): value is CalibrationCheckpointState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2 || typeof record.contractHash !== "string" || !/^[0-9a-f]{64}$/.test(record.contractHash) ||
      !record.contract || typeof record.contract !== "object" || Array.isArray(record.contract) ||
      !record.completed || typeof record.completed !== "object" || Array.isArray(record.completed)) return false;
  return Object.entries(record.completed as Record<string, unknown>).every(([id, output]) => {
    if (!sliceIds.has(id) || !output || typeof output !== "object" || Array.isArray(output)) return false;
    const fields = output as Record<string, unknown>;
    return Object.keys(fields).every((key) => key === "localCategory" || key === "frontierCategory") &&
      [fields.localCategory, fields.frontierCategory].every((category) => category === undefined || (typeof category === "string" && category.length > 0));
  });
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`runJudgeCalibration: checkpoint directory must be a real directory: ${dir}`);
  await chmod(dir, 0o700);
}

async function writeCalibrationCheckpoint(filePath: string, state: CalibrationCheckpointState): Promise<void> {
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await rename(tempPath, filePath); await chmod(filePath, 0o600); }
  catch (error) { await unlink(tempPath).catch(() => undefined); throw error; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function writeJudgeCalibrationState(
  result: JudgeCalibrationResult,
  calibrationDir: string,
  identities?: JudgeCalibrationIdentities,
  provenance?: {
    sourceResultId: string;
    orderedQuestionIdsHash?: string;
    localJudgeConfigHash?: string;
    frontierJudgeConfigHash?: string;
  },
): Promise<string> {
  await ensurePrivateDirectory(calibrationDir);
  const state: BenchmarkArtifactJudgeCalibration & Partial<JudgeCalibrationIdentities> & {
    orderedQuestionIdsHash?: string;
  } = {
    kappa: result.kappa,
    sampleSize: result.sampleSize,
    threshold: result.threshold,
    warning: result.warning,
    confidenceInterval: result.confidenceInterval,
    bootstrapSamples: result.bootstrapSamples,
    answerSetHash: result.answerSetHash,
    sliceQuestionIds: result.sliceQuestionIds,
    ...(provenance ? provenance : {}),
    ...(identities ? identities : {}),
  };
  const filePath = path.join(calibrationDir, `${sanitizeCalibrationSegment(result.benchmarkId)}.json`);
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return filePath;
}

export async function loadJudgeCalibrationState(
  benchmarkId: string,
  calibrationDir: string,
): Promise<LoadedJudgeCalibrationState | undefined> {
  const filePath = path.join(calibrationDir, `${sanitizeCalibrationSegment(benchmarkId)}.json`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const kappa = record.kappa;
  const sampleSize = record.sampleSize;
  const threshold = record.threshold;
  const warning = record.warning;
  if (
    typeof kappa !== "number" || !Number.isFinite(kappa) ||
    typeof sampleSize !== "number" || !Number.isFinite(sampleSize) ||
    typeof threshold !== "number" || !Number.isFinite(threshold) ||
    typeof warning !== "boolean"
  ) {
    return undefined;
  }
  const loaded: LoadedJudgeCalibrationState = { kappa, sampleSize, threshold, warning };
  const confidenceInterval = record.confidenceInterval;
  const bootstrapSamples = record.bootstrapSamples;
  if (
    confidenceInterval && typeof confidenceInterval === "object" && !Array.isArray(confidenceInterval) &&
    typeof (confidenceInterval as Record<string, unknown>).lower === "number" &&
    Number.isFinite((confidenceInterval as Record<string, unknown>).lower) &&
    typeof (confidenceInterval as Record<string, unknown>).upper === "number" &&
    Number.isFinite((confidenceInterval as Record<string, unknown>).upper) &&
    typeof (confidenceInterval as Record<string, unknown>).level === "number" &&
    Number.isFinite((confidenceInterval as Record<string, unknown>).level) &&
    typeof bootstrapSamples === "number" && Number.isInteger(bootstrapSamples) && bootstrapSamples > 0
  ) {
    loaded.confidenceInterval = confidenceInterval as unknown as KappaConfidenceInterval;
    loaded.bootstrapSamples = bootstrapSamples;
  }
  const sourceResultId = record.sourceResultId;
  const answerSetHash = record.answerSetHash;
  const orderedQuestionIdsHash = record.orderedQuestionIdsHash;
  if (
    typeof sourceResultId === "string" && sourceResultId.length > 0 &&
    typeof answerSetHash === "string" && /^[0-9a-f]{64}$/.test(answerSetHash) &&
    Array.isArray(record.sliceQuestionIds) &&
    record.sliceQuestionIds.length > 0 && record.sliceQuestionIds.length <= CALIBRATION_SLICE_SIZE &&
    record.sliceQuestionIds.length === sampleSize &&
    record.sliceQuestionIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(record.sliceQuestionIds).size === record.sliceQuestionIds.length
  ) {
    loaded.sourceResultId = sourceResultId;
    loaded.answerSetHash = answerSetHash;
    loaded.sliceQuestionIds = record.sliceQuestionIds as string[];
  }
  if (
    typeof orderedQuestionIdsHash === "string" && /^[0-9a-f]{64}$/.test(orderedQuestionIdsHash)
  ) {
    loaded.orderedQuestionIdsHash = orderedQuestionIdsHash;
  }
  if (
    typeof record.localJudgeConfigHash === "string" && /^[0-9a-f]{64}$/.test(record.localJudgeConfigHash) &&
    typeof record.frontierJudgeConfigHash === "string" && /^[0-9a-f]{64}$/.test(record.frontierJudgeConfigHash)
  ) {
    loaded.localJudgeConfigHash = record.localJudgeConfigHash;
    loaded.frontierJudgeConfigHash = record.frontierJudgeConfigHash;
  }
  const identityKeys = [
    "localJudgeProvider",
    "localJudgeModel",
    "frontierJudgeProvider",
    "frontierJudgeModel",
  ] as const;
  const identityValues = identityKeys.map((key) => record[key]);
  if (identityValues.some((value) => value !== undefined)) {
    if (identityValues.every((value) => typeof value === "string")) {
      Object.assign(
        loaded,
        Object.fromEntries(identityKeys.map((key, index) => [key, identityValues[index]])),
      );
    }
  }
  return loaded;
}

function sanitizeCalibrationSegment(value: string): string {
  const lowered = value.trim().toLowerCase();
  const chars: string[] = [];
  let prevWasSeparator = false;
  for (const ch of lowered) {
    const code = ch.charCodeAt(0);
    const isAllowed =
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x5f || // _
      code === 0x2d;   // -
    if (isAllowed) {
      const isSeparator = ch === "-";
      if (isSeparator && prevWasSeparator) {
        continue; // Collapse consecutive separators.
      }
      chars.push(ch);
      prevWasSeparator = isSeparator;
    } else if (!prevWasSeparator && chars.length > 0) {
      chars.push("-");
      prevWasSeparator = true;
    }
  }
  while (chars.length > 0 && chars[0] === "-") {
    chars.shift();
  }
  while (chars.length > 0 && chars[chars.length - 1] === "-") {
    chars.pop();
  }
  return chars.length > 0 ? chars.join("") : "unknown";
}

export {
  DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
  DEFAULT_KAPPA_BOOTSTRAP_SAMPLES,
  DEFAULT_KAPPA_CONFIDENCE_LEVEL,
  binarizeJudgeScore,
  computeCohensKappa,
  bootstrapCohensKappaConfidenceInterval,
};
export type {
  BootstrapKappaOptions,
  BootstrapKappaResult,
  CohenKappaResult,
  JudgeCategory,
  KappaConfidenceInterval,
};
