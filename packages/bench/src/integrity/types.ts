/**
 * Integrity-facing additions to `BenchmarkResult.meta`.
 *
 * These fields are required for every published result and checked by the
 * publishing pipeline. See `docs/bench/integrity.md` for the rotation policy.
 */

import { isSha256Hex } from "./hash-verification.js";

export const BENCHMARK_SPLIT_TYPES = ["public", "holdout"] as const;
export type BenchmarkSplitType = (typeof BENCHMARK_SPLIT_TYPES)[number];

export interface BenchmarkIntegrityMeta {
  /**
   * Which dataset split produced this result. Public leaderboard scores
   * only accept `holdout` results; `public` results are for self-reporting
   * and iteration.
   */
  splitType: BenchmarkSplitType;
  /** SHA-256 of the sealed qrels artifact used by the judge. */
  qrelsSealedHash: string;
  /** SHA-256 of the rendered judge prompt (post-template expansion). */
  judgePromptHash: string;
  /** SHA-256 of the dataset payload as served to the runner. */
  datasetHash: string;
  /**
   * Score the canary adapter scored on the same benchmark during the audit
   * run that produced this result. Must stay below the benchmark's floor.
   * Omitted only during the canary's own run.
   */
  canaryScore?: number;
}

export const INTEGRITY_META_FIELDS = [
  "splitType",
  "qrelsSealedHash",
  "judgePromptHash",
  "datasetHash",
] as const satisfies ReadonlyArray<keyof BenchmarkIntegrityMeta>;

export const BENCHMARK_INTEGRITY_META_SCHEMA = {
  type: "object",
  required: [...INTEGRITY_META_FIELDS],
  properties: {
    splitType: {
      type: "string",
      enum: [...BENCHMARK_SPLIT_TYPES],
    },
    qrelsSealedHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    judgePromptHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    datasetHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    canaryScore: { type: "number" },
  },
} as const;

export function integrityMetaIsComplete(
  value: unknown,
): value is BenchmarkIntegrityMeta {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BenchmarkIntegrityMeta>;
  if (
    typeof candidate.splitType !== "string" ||
    !BENCHMARK_SPLIT_TYPES.includes(candidate.splitType as BenchmarkSplitType)
  ) {
    return false;
  }
  if (
    !isSha256Hex(candidate.qrelsSealedHash) ||
    !isSha256Hex(candidate.judgePromptHash) ||
    !isSha256Hex(candidate.datasetHash)
  ) {
    return false;
  }
  if (
    candidate.canaryScore !== undefined &&
    (typeof candidate.canaryScore !== "number" || !Number.isFinite(candidate.canaryScore))
  ) {
    return false;
  }
  return true;
}

/**
 * Throw a descriptive error listing every missing or malformed integrity
 * field. Used by the publishing pipeline.
 */
export function assertIntegrityMetaPresent(value: unknown): asserts value is BenchmarkIntegrityMeta {
  const missing: string[] = [];
  if (!value || typeof value !== "object") {
    throw new Error(
      "Result is missing an integrity-meta object; publishing pipeline rejects it.",
    );
  }
  const candidate = value as Partial<BenchmarkIntegrityMeta>;
  if (
    typeof candidate.splitType !== "string" ||
    !BENCHMARK_SPLIT_TYPES.includes(candidate.splitType as BenchmarkSplitType)
  ) {
    missing.push("splitType");
  }
  if (!isSha256Hex(candidate.qrelsSealedHash)) {
    missing.push("qrelsSealedHash");
  }
  if (!isSha256Hex(candidate.judgePromptHash)) {
    missing.push("judgePromptHash");
  }
  if (!isSha256Hex(candidate.datasetHash)) {
    missing.push("datasetHash");
  }
  if (
    candidate.canaryScore !== undefined &&
    (typeof candidate.canaryScore !== "number" || !Number.isFinite(candidate.canaryScore))
  ) {
    missing.push("canaryScore");
  }
  if (missing.length > 0) {
    throw new Error(
      `Result integrity metadata is incomplete or malformed: ${missing.join(", ")}`,
    );
  }
}
