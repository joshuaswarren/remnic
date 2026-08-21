/**
 * Cross-tier judge calibration — issue #1573 PR3.
 *
 * The two-tier protocol (#1573) trusts local-judge numbers for regression only
 * when the local judge agrees with the frontier judge closely enough. This
 * module owns three things:
 *
 *   1. A deterministic, content-free calibration slice — a reproducible
 *      selection of question ids per benchmark. The slice is "committed" in
 *      the sense that the selection algorithm is fixed and content-free
 *      (rule: no dataset content in repo per docs/benchmarks.md ethics): the
 *      same universe of question ids always yields the same slice, so two
 *      operators running the same dataset compare the same questions.
 *   2. `runJudgeCalibration` — runs both judges over the slice's cached
 *      answers, bins each verdict to a category, and reports Cohen's kappa.
 *   3. The kappa threshold + warning that downstream local artifacts carry
 *      (see the `judgeCalibration` field on `BenchmarkArtifact`).
 *
 * The module is I/O-free except for the judge calls the caller injects; it has
 * no module-level mutable state (rule 11) and never interpolates model/answer
 * text into shell strings (rule 10).
 */

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
/**
 * Judge identities recorded alongside a persisted calibration so a later run
 * can verify the kappa was computed for the SAME judge pair (issue #1573 PR3,
 * codex P2 review). Without this binding, a run that swaps the local-lab
 * manifest or the frontier judge would inherit a stale kappa computed for a
 * different pair.
 */
export interface JudgeCalibrationIdentities {
  localJudgeProvider: string;
  localJudgeModel: string;
  frontierJudgeProvider: string;
  frontierJudgeModel: string;
}

/**
 * The full persisted calibration record as loaded from disk: the artifact
 * subset plus the (optional) judge identities that produced it. Identities
 * are optional because state files written before they existed still load —
 * the attach path treats absent identities as "unbound, attach anyway" to
 * preserve backwards compatibility.
 */
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

/**
 * Fixed slice size per benchmark. Issue #1877 raises the calibration target
 * from 50 to 200 to reduce slice sensitivity; a
 * benchmark with fewer available questions uses all of them.
 */
export const CALIBRATION_SLICE_SIZE = 200;

/**
 * Minimum number of completed tasks a stored result must have to be a valid
 * calibration source (codex P2 review). A `--limit 1` full run produces
 * `mode === "full"` with a single task, yielding a degenerate one-sample κ
 * (often 1.0). Below this floor, Cohen's kappa is statistically meaningless.
 * Benchmarks with fewer total questions are unaffected — the slice uses all
 * available tasks, but a capped run of a larger benchmark is rejected.
 */
export const MIN_CALIBRATION_SOURCE_TASKS = 10;

/**
 * Kappa below this triggers a loud "local judge unreliable for this
 * benchmark" warning in the report and on the artifact. 0.7 is the
 * conventional "substantial agreement" cut-off (Landis & Koch 1977).
 */
export const JUDGE_CALIBRATION_KAPPA_THRESHOLD = 0.7;

/** A cached answer the calibration runs both judges over. */
export interface CalibrationAnswer {
  /** Stable question id (matches `BenchmarkArtifactPerTaskScore.taskId`). */
  questionId: string;
  /** The prompt/question text the responder was asked. */
  question: string;
  /** The responder's produced answer text. */
  predicted: string;
  /** The reference / gold answer text. */
  expected: string;
}

/** Per-question verdict pair produced while running calibration. */
export interface CalibrationVerdictPair {
  questionId: string;
  localCategory: JudgeCategory;
  frontierCategory: JudgeCategory;
}

export const JUDGE_CALIBRATION_PROTOCOL_VERSION = "judge-calibration-v3";

/** Identity of the default score-to-category mapping used by calibration. */
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
  /** Benchmark id the calibration is scoped to (recorded in the result). */
  benchmarkId: string;
  /** The cheap local-lab judge (Tier L). */
  localJudge: BenchJudge;
  /** The expensive frontier judge (Tier F) — the gold standard. */
  frontierJudge: BenchJudge;
  /** Cached answers to judge; the slice is selected from these by question id. */
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
  /** Question ids that made up the calibrated slice. */
  sliceQuestionIds: readonly string[];
  /** Configured warning threshold. */
  threshold: number;
  /** True when `kappa < threshold` — local judge is unreliable for this benchmark. */
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

/**
 * Select the calibration slice from a universe of question ids.
 *
 * The selection is deterministic and content-free: ids are ordered by the
 * hex digest of `sha256(id)` and the first `size` are taken. This commits the
 * slice to a fixed algorithm rather than a hardcoded id list (which we cannot
 * ship without the dataset). Same universe → same slice, every time, across
 * operators and reruns — so the slice is reproducible and comparable.
 */
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

/**
 * Run both judges over the calibration slice and report Cohen's kappa.
 *
 * For each answer in the slice the local and frontier judges each score
 * `(question, predicted, expected)`; each numeric score is binned to a
 * category (default: correct/incorrect) and the two parallel category arrays
 * feed `computeCohensKappa`. The result is exactly the value that lands in
 * subsequent local artifacts' `judgeCalibration.kappa`.
 */
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
  // Dedupe by questionId (cursor review: a stored result with duplicate
  // taskIds would otherwise double-count the same question, inflating
  // sampleSize and skewing kappa). First answer per id wins; slice order
  // is preserved so verdicts line up with sliceQuestionIds.
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

/**
 * Persist a calibration result so subsequent local artifacts can carry the
 * kappa (issue #1573 done-when: "a kappa number that lands in subsequent
 * local artifacts"). The state is a single JSON file per benchmark under
 * `<calibrationDir>/<benchmarkId>.json`, written atomically via temp-write-
 * then-rename (cursor review: a direct writeFile can leave truncated JSON on
 * crash, which loadJudgeCalibrationState would silently drop as a miss).
 *
 * The artifact-relevant subset (`BenchmarkArtifactJudgeCalibration`) plus
 * private source provenance is persisted — never the per-question verdicts
 * or answer text (repo ethics + rule 10: nothing interpolated into shell).
 * Optional `identities` record the judge pair that produced the kappa so a
 * later run can refuse a stale kappa for a different pair (codex P2 review);
 * omitted on pre-binding state files.
 */
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
  // Atomic write: land bytes on a temp file, then rename into place. The
  // rename is atomic on POSIX; best-effort temp cleanup on failure.
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

/**
 * Load a previously persisted calibration result for a benchmark. Returns
 * `undefined` when no calibration has been run yet (the run path treats
 * absence as "no calibration recorded" and omits `judgeCalibration` from
 * the artifact). A corrupt/unparseable file is a miss returning `undefined`,
 * never a crash (rule 34) — the operator re-runs `judge-calibrate`.
 */
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
  // Identities are optional (older state files predate them). If ANY identity
  // field is present, ALL four must be present and string — otherwise the
  // binding is unreliable and identities are dropped (the calibration subset
  // still loads; the attach path treats unbound state as "attach anyway" for
  // backwards compatibility).
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

/**
 * Sanitize a benchmark id for use as a calibration-state filename. Only
 * `[a-z0-9._-]` survives (mirrors the artifact filename sanitizer) so a
 * forged benchmark id cannot escape `calibrationDir`.
 */
function sanitizeCalibrationSegment(value: string): string {
  const lowered = value.trim().toLowerCase();
  // Character-by-character sanitization (CodeQL: avoids polynomial regex on
  // uncontrolled input). Disallowed characters become a single "-" separator
  // so distinct benchmark ids stay distinct (cursor review: the old filter-drop
  // mapped "foo.bar" and "foobar" to the same file). Consecutive separators
  // are collapsed and edges are trimmed.
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
  // Trim leading/trailing separators (array-based, no regex).
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
