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

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchJudge } from "../adapters/types.js";
import type { BenchmarkArtifactJudgeCalibration } from "../published-artifact.js";
import {
  DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
  binarizeJudgeScore,
  computeCohensKappa,
  type CohenKappaResult,
  type JudgeCategory,
} from "./cohen-kappa.js";

/**
 * Fixed slice size per benchmark. The issue specifies a 50-question slice; a
 * benchmark with fewer available questions uses all of them.
 */
export const CALIBRATION_SLICE_SIZE = 50;

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
  /** Override the slice size (default 50; mainly for tests). */
  sliceSize?: number;
  /** Override the warning threshold (default 0.7). */
  threshold?: number;
}

export interface JudgeCalibrationResult extends CohenKappaResult {
  benchmarkId: string;
  /** Question ids that made up the calibrated slice. */
  sliceQuestionIds: readonly string[];
  /** Configured warning threshold. */
  threshold: number;
  /** True when `kappa < threshold` — local judge is unreliable for this benchmark. */
  warning: boolean;
  /** Per-question verdict pairs, in slice order. */
  verdicts: readonly CalibrationVerdictPair[];
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

  const sliceIds = selectCalibrationSlice(
    options.answers.map((answer) => answer.questionId),
    sliceSize,
  );
  const sliceIdSet = new Set(sliceIds);
  const sliceAnswers = options.answers.filter((answer) => sliceIdSet.has(answer.questionId));

  const localLabels: JudgeCategory[] = [];
  const frontierLabels: JudgeCategory[] = [];
  const verdicts: CalibrationVerdictPair[] = [];

  for (const answer of sliceAnswers) {
    const localScore = await options.localJudge.score(
      answer.question,
      answer.predicted,
      answer.expected,
    );
    const frontierScore = await options.frontierJudge.score(
      answer.question,
      answer.predicted,
      answer.expected,
    );
    const localCategory = binScore(localScore);
    const frontierCategory = binScore(frontierScore);
    localLabels.push(localCategory);
    frontierLabels.push(frontierCategory);
    verdicts.push({
      questionId: answer.questionId,
      localCategory,
      frontierCategory,
    });
  }

  const kappaResult = computeCohensKappa(localLabels, frontierLabels);
  const warning = kappaResult.kappa < threshold;

  return {
    ...kappaResult,
    benchmarkId: options.benchmarkId,
    sliceQuestionIds: sliceIds,
    threshold,
    warning,
    verdicts,
  };
}

/**
 * Persist a calibration result so subsequent local artifacts can carry the
 * kappa (issue #1573 done-when: "a kappa number that lands in subsequent
 * local artifacts"). The state is a single JSON file per benchmark under
 * `<calibrationDir>/<benchmarkId>.json`, written atomically via temp-write
 * (the shared canonical serializer keeps the SHA stable across reruns).
 *
 * Only the artifact-relevant subset (`BenchmarkArtifactJudgeCalibration`) is
 * persisted — never the per-question verdicts or answer text (repo ethics +
 * rule 10: nothing interpolated into shell).
 */
export async function writeJudgeCalibrationState(
  result: JudgeCalibrationResult,
  calibrationDir: string,
): Promise<string> {
  await mkdir(calibrationDir, { recursive: true });
  const state: BenchmarkArtifactJudgeCalibration = {
    kappa: result.kappa,
    sampleSize: result.sampleSize,
    threshold: result.threshold,
    warning: result.warning,
  };
  const filePath = path.join(calibrationDir, `${sanitizeCalibrationSegment(result.benchmarkId)}.json`);
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
): Promise<BenchmarkArtifactJudgeCalibration | undefined> {
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
  return { kappa, sampleSize, threshold, warning };
}

/**
 * Sanitize a benchmark id for use as a calibration-state filename. Only
 * `[a-z0-9._-]` survives (mirrors the artifact filename sanitizer) so a
 * forged benchmark id cannot escape `calibrationDir`.
 */
function sanitizeCalibrationSegment(value: string): string {
  const lowered = value.trim().toLowerCase();
  const cleaned = lowered
    .split("")
    .filter((ch) => /[a-z0-9_-]/.test(ch))
    .join("");
  return cleaned.length > 0 ? cleaned : "unknown";
}

export {
  DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
  binarizeJudgeScore,
  computeCohensKappa,
};
export type { CohenKappaResult, JudgeCategory };
