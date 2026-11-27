
/** Minimal candidate shape used by MMR. Callers may wrap their own records. */
export interface MmrCandidate {
  /** Stable identifier for the candidate. Only used for tie-breaking. */
  id: string;
  /** Text content used for the Jaccard similarity fallback. */
  content: string;
  /**
   * Relevance score from the upstream ranker (e.g. rerank score or RRF).
   * Used as the `sim(d, query)` term when no query embedding is available.
   */
  score: number;
  /** Optional pre-computed embedding vector for cosine similarity. */
  embedding?: readonly number[] | null;
}

export interface ApplyMmrOptions<C extends MmrCandidate> {
  /** Ordered candidate list (most relevant first). */
  candidates: readonly C[];
  /** Optional query embedding. If provided and candidates carry embeddings,
   *  relevance is measured by cosine similarity to the query. Otherwise
   *  candidate `score` is normalized and used. */
  queryEmbedding?: readonly number[] | null;
  /** λ ∈ [0, 1]. 1 = pure relevance, 0 = pure diversity. Default 0.7. */
  lambda?: number;
  /** Apply MMR only over the top N candidates. Default 40. */
  topN?: number;
  /** Maximum number of candidates to select. Default = candidates length. */
  budget?: number;
}

export interface MmrDiversityReport {
  /**
   * Total number of candidates MMR considered (the full input pool, pre-MMR).
   * Previously this mirrored `kept` and was therefore uninformative; it now
   * reflects the true pool size so `kept/considered` logs carry signal even
   * though MMR is reorder-only.
   */
  considered: number;
  /**
   * Number of candidates present in the MMR output. With the current
   * orchestrator pipeline MMR is reorder-only (no drops), so this is the
   * same as `considered`. It's still reported separately so a future
   * drop-mode MMR can distinguish them without another schema change.
   */
  kept: number;
  /**
   * Head-of-list positions whose candidate identity changed between the
   * pre-MMR and post-MMR slices. This is the *actionable* diversity signal:
   * it tells the caller how many of the top `sampleSize` results MMR
   * promoted or demoted. Zero means MMR had no head-of-list effect; a value
   * greater than zero means at least one diverse candidate was swapped in.
   */
  headReorderCount: number;
  /** Average pairwise similarity of the head-of-list input slice (pre-MMR). */
  avgPairwiseSimBefore: number;
  /** Average pairwise similarity of the head-of-list MMR output slice. */
  avgPairwiseSimAfter: number;
}

export const DEFAULT_LAMBDA = 0.7;
export const DEFAULT_TOP_N = 40;
const DEFAULT_DIVERSITY_SAMPLE_SIZE = 10;

/**
 * Pure MMR re-selection over an ordered candidate list.
 *
 * Returns a new array — the input is never mutated. When `candidates.length`
 * is `<= 1` or `budget <= 0`, a defensive copy is returned as a no-op.
 */
export function applyMmrToCandidates<C extends MmrCandidate>(
  opts: ApplyMmrOptions<C>,
): C[] {
  const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
  if (candidates.length === 0) return [];

  const lambda = clampLambda(opts.lambda);
  const topN = clampPositiveInt(opts.topN, DEFAULT_TOP_N);
  const budget = clampPositiveInt(opts.budget, candidates.length);

  if (budget <= 0) return [];
  if (candidates.length === 1) return [candidates[0]!];

  const pool = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  const relevance = computeRelevanceScores(pool, opts.queryEmbedding);

  const pairSim = new Map<string, number>();
  const pairKey = (i: number, j: number): string =>
    i < j ? `${i}:${j}` : `${j}:${i}`;
  const sim = (i: number, j: number): number => {
    if (i === j) return 1;
    const key = pairKey(i, j);
    const cached = pairSim.get(key);
    if (cached !== undefined) return cached;
    const a = pool[i]!;
    const b = pool[j]!;
    const s = similarity(a, b);
    pairSim.set(key, s);
    return s;
  };

  const selectedIdx: number[] = [];
  const remaining = new Set<number>();
  for (let i = 0; i < pool.length; i += 1) remaining.add(i);

  while (selectedIdx.length < budget && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (const idx of remaining) {
      const rel = relevance[idx] ?? 0;
      let maxSimToSelected = 0;
      if (selectedIdx.length > 0) {
        for (const s of selectedIdx) {
          const pairwise = sim(idx, s);
          if (pairwise > maxSimToSelected) maxSimToSelected = pairwise;
        }
      }
      const mmr = lambda * rel - (1 - lambda) * maxSimToSelected;
      if (
        mmr > bestMmr ||
        (mmr === bestMmr && (bestIdx < 0 || idx < bestIdx))
      ) {
        bestMmr = mmr;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) break;
    selectedIdx.push(bestIdx);
    remaining.delete(bestIdx);
  }

  const selected: C[] = selectedIdx.map((i) => pool[i]!);

  if (selected.length < budget && tail.length > 0) {
    for (const c of tail) {
      if (selected.length >= budget) break;
      selected.push(c);
    }
  }

  return selected;
}

/**
 * Summarize how much MMR reshuffled the head of the candidate list, for
 * logging. Optional — callers can skip this if they don't care about metrics.
 *
 * IMPORTANT: `before` should be the score-ordered input (the same ordering the
 * upstream reranker emitted, *not* the MMR output), and `after` should be the
 * MMR-reordered list. Both are truncated to `sampleSize` before their pairwise
 * similarity is averaged.
 *
 * The sample size intentionally defaults to a small number
 * ({@link DEFAULT_DIVERSITY_SAMPLE_SIZE}) so that when the caller uses
 * `budget >= candidates.length` (i.e. MMR only reorders without dropping), the
 * head-of-list comparison still reflects whether MMR promoted diverse
 * candidates. Passing a sample size `>= candidates.length` in that situation
 * makes `avgPairwiseSimBefore` and `avgPairwiseSimAfter` trivially equal
 * because pairwise similarity is order-independent.
 */
export function summarizeMmrDiversity<C extends MmrCandidate>(
  before: readonly C[],
  after: readonly C[],
  sampleSize: number = DEFAULT_DIVERSITY_SAMPLE_SIZE,
): MmrDiversityReport {
  const n = clampPositiveInt(sampleSize, DEFAULT_DIVERSITY_SAMPLE_SIZE);
  const beforeSlice = before.slice(0, n);
  const afterSlice = after.slice(0, n);
  let headReorderCount = 0;
  const compareLength = Math.min(beforeSlice.length, afterSlice.length);
  for (let i = 0; i < compareLength; i += 1) {
    if (beforeSlice[i]!.id !== afterSlice[i]!.id) headReorderCount += 1;
  }
  return {
    considered: before.length,
    kept: after.length,
    headReorderCount,
    avgPairwiseSimBefore: averagePairwiseSimilarity(beforeSlice),
    avgPairwiseSimAfter: averagePairwiseSimilarity(afterSlice),
  };
}


function clampLambda(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LAMBDA;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampPositiveInt(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function computeRelevanceScores<C extends MmrCandidate>(
  pool: readonly C[],
  queryEmbedding: readonly number[] | null | undefined,
): number[] {
  const canUseQueryEmbedding =
    Array.isArray(queryEmbedding) && queryEmbedding.length > 0;

  if (canUseQueryEmbedding) {
    const scores: number[] = [];
    for (const c of pool) {
      if (Array.isArray(c.embedding) && c.embedding.length > 0) {
        scores.push(cosineSimilarity(queryEmbedding!, c.embedding));
      } else {
        scores.push(normalizeFinite(c.score));
      }
    }
    return normalizeVector(scores);
  }

  const raw = pool.map((c) => normalizeFinite(c.score));
  return normalizeVector(raw);
}

function similarity<C extends MmrCandidate>(a: C, b: C): number {
  if (
    Array.isArray(a.embedding) &&
    a.embedding.length > 0 &&
    Array.isArray(b.embedding) &&
    b.embedding.length > 0 &&
    a.embedding.length === b.embedding.length
  ) {
    return cosineSimilarity(a.embedding, b.embedding);
  }
  return jaccardSimilarity(a.content ?? "", b.content ?? "");
}

function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  if (cos < 0) return 0;
  if (cos > 1) return 1;
  return cos;
}

export function normalizeTokens(text: string): Set<string> {
  if (!text) return new Set();
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (cleaned.length === 0) {
    const chars = new Set<string>();
    for (const ch of text.toLowerCase()) {
      if (/\s/.test(ch)) continue;
      chars.add(ch);
    }
    return chars;
  }
  const tokens = new Set<string>();
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if (token.length >= 2 && hasUnsegmentableScript(token)) {
      for (const ch of token) tokens.add(ch);
    } else {
      tokens.add(token);
    }
  }
  return tokens;
}

function hasUnsegmentableScript(token: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    token,
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function normalizeFinite(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function normalizeVector(values: number[]): number[] {
  if (values.length === 0) return values;
  //
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const a = Math.abs(v);
    if (a > max) max = a;
    if (v < min) min = v;
  }
  if (!Number.isFinite(min)) {
    return values.map(() => 0);
  }
  if (max === 0) {
    return values.map(() => 1);
  }
  if (min >= 0 && max <= 1) {
    return values.map((v) =>
      Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0,
    );
  }
  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    const scaled = v / max;
    if (scaled < 0) return 0;
    if (scaled > 1) return 1;
    return scaled;
  });
}

function averagePairwiseSimilarity<C extends MmrCandidate>(
  candidates: readonly C[],
): number {
  if (candidates.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      sum += similarity(candidates[i]!, candidates[j]!);
      count += 1;
    }
  }
  if (count === 0) return 0;
  return sum / count;
}

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------

/**
 * Minimum shape the recall-MMR orchestration helper expects from a result.
 * Any richer result type (e.g. {@link QmdSearchResult}) satisfies this.
 */
export interface MmrRecallResult {
  readonly docid?: string;
  readonly path?: string;
  readonly snippet?: string;
  readonly score?: number;
  /**
   * Effective relevance carried forward by the rerank stage that last
   * adjusted the result. Preferred over `score` for MMR's relevance term.
   */
  readonly effectiveScore?: number;
}

export interface ReorderRecallResultsOptions {
  readonly lambda?: number;
  readonly topN?: number;
  /**
   * Head-of-list sample size used by the diversity metric. Defaults to
   * {@link DEFAULT_DIVERSITY_SAMPLE_SIZE}. Intentionally small so the metric
   * reflects head-of-list changes even when `budget >= results.length`.
   */
  readonly diversitySampleSize?: number;
}

export interface ReorderRecallResultsOutcome<R extends MmrRecallResult> {
  readonly reordered: R[];
  readonly diversity: MmrDiversityReport;
  readonly lambda: number;
}

/**
 * Apply MMR to an ordered list of recall results and return the reordered
 * list plus a head-of-list diversity report.
 *
 * This helper is the single source of truth for the orchestrator's
 * per-section MMR pass. It is pure and deterministic so it can be unit
 * tested without constructing an Orchestrator.
 *
 * Key invariants:
 * 1. **No silent drops.** Candidates are keyed by a stable unique key derived
 *    from `path` first, falling back to `docid`, and always suffixed with the
 *    candidate's original index. Two results that share a basename-style
 *    docid but differ in path are treated as distinct candidates and both
 *    survive the reorder.
 * 2. **No mutation.** The input array is never mutated; a new array is
 *    returned.
 * 3. **Diversity metric is meaningful.** The report compares the *head of
 *    list* before and after MMR using a small sample size, so it reflects
 *    whether MMR promoted diverse candidates even when
 *    `budget >= results.length`.
 */
export function reorderRecallResultsWithMmr<R extends MmrRecallResult>(
  results: readonly R[],
  options: ReorderRecallResultsOptions = {},
): ReorderRecallResultsOutcome<R> {
  const emptyReport: MmrDiversityReport = {
    considered: 0,
    kept: 0,
    headReorderCount: 0,
    avgPairwiseSimBefore: 0,
    avgPairwiseSimAfter: 0,
  };
  const lambda = clampLambda(options.lambda);

  if (!Array.isArray(results) || results.length === 0) {
    return { reordered: [], diversity: emptyReport, lambda };
  }
  if (results.length < 2) {
    return {
      reordered: [results[0]!],
      diversity: {
        considered: 1,
        kept: 1,
        headReorderCount: 0,
        avgPairwiseSimBefore: 0,
        avgPairwiseSimAfter: 0,
      },
      lambda,
    };
  }

  const topN = clampPositiveInt(options.topN, DEFAULT_TOP_N);

  const candidates: MmrCandidate[] = results.map((r, index) => ({
    id: makeRecallKey(r, index),
    content: r.snippet ?? "",
    score: effectiveRelevance(r),
    embedding: null,
  }));
  const indexById = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += 1) {
    indexById.set(candidates[i]!.id, i);
  }

  const selectedMmr = applyMmrToCandidates({
    candidates,
    lambda,
    topN,
    budget: results.length,
  });

  const reordered: R[] = [];
  const reorderedCandidates: MmrCandidate[] = [];
  const seen = new Set<string>();
  for (const c of selectedMmr) {
    if (seen.has(c.id)) continue;
    const origIndex = indexById.get(c.id);
    if (origIndex === undefined) continue;
    seen.add(c.id);
    reordered.push(results[origIndex]!);
    reorderedCandidates.push(candidates[origIndex]!);
  }
  if (reordered.length < results.length) {
    for (let i = 0; i < results.length; i += 1) {
      const origCandidate = candidates[i]!;
      if (seen.has(origCandidate.id)) continue;
      seen.add(origCandidate.id);
      reordered.push(results[i]!);
      reorderedCandidates.push(origCandidate);
    }
  }

  const diversity = summarizeMmrDiversity(
    candidates,
    reorderedCandidates,
    options.diversitySampleSize,
  );

  return { reordered, diversity, lambda };
}

/**
 * Relevance for MMR's `sim(d, query)` term: the effective relevance an
 * upstream rerank stage carried forward, else the raw retrieval score.
 */
function effectiveRelevance(r: MmrRecallResult): number {
  if (typeof r.effectiveScore === "number" && Number.isFinite(r.effectiveScore)) {
    return r.effectiveScore;
  }
  return typeof r.score === "number" ? r.score : 0;
}

function makeRecallKey(r: MmrRecallResult, index: number): string {
  const baseKey = r.path || r.docid || "";
  return `${baseKey}::${index}`;
}
