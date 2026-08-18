/**
 * Isolated merge-on-write judge (issue #2330 first slice).
 *
 * Default off. Persist wiring comes later. Failures create.
 */

export const DEFAULT_MERGE_MIN = 0.8;
export const DEFAULT_SKIP_THRESHOLD = 0.92;

export const REFUSED_MERGE_CATEGORIES = [
  "procedure",
  "reasoning_trace",
  "moment",
  "correction",
] as const;

export type MergeOnWriteDecision = "merge" | "create";
export type MergeJudgeVerdict = MergeOnWriteDecision | "uncertain";

export interface MergeOnWritePair {
  category: string;
  score: number;
  incomingContent?: string;
  existingContent?: string;
  existingId?: string;
}

export type MergeJudge = (
  pair: MergeOnWritePair,
) => Promise<MergeJudgeVerdict> | MergeJudgeVerdict;

export function shouldConsiderMerge(opts: {
  score: number;
  skipThreshold?: number;
  mergeMin?: number;
}): boolean {
  const mergeMin = opts.mergeMin ?? DEFAULT_MERGE_MIN;
  const skipThreshold = opts.skipThreshold ?? DEFAULT_SKIP_THRESHOLD;
  if (!(mergeMin > 0)) return false;
  if (!Number.isFinite(opts.score) || !Number.isFinite(skipThreshold)) return false;
  return mergeMin <= opts.score && opts.score < skipThreshold;
}

export async function judgeMergeDecision(
  pair: MergeOnWritePair,
  judge: MergeJudge,
): Promise<MergeOnWriteDecision> {
  try {
    const verdict = await judge(pair);
    return verdict === "merge" ? "merge" : "create";
  } catch {
    return "create";
  }
}

export async function applyMergeOnWrite(opts: {
  pair: MergeOnWritePair;
  judge: MergeJudge;
  enabled?: boolean;
  mergeMin?: number;
  skipThreshold?: number;
}): Promise<MergeOnWriteDecision> {
  if (opts.enabled !== true) return "create";
  if ((REFUSED_MERGE_CATEGORIES as readonly string[]).includes(opts.pair.category)) return "create";
  if (
    !shouldConsiderMerge({
      score: opts.pair.score,
      mergeMin: opts.mergeMin,
      skipThreshold: opts.skipThreshold,
    })
  ) {
    return "create";
  }
  return judgeMergeDecision(opts.pair, opts.judge);
}
