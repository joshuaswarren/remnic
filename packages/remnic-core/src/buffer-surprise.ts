/**
 * Surprise helper — D-MEM-style novelty score for a turn against recent memories.
 *
 * Used (eventually, in a follow-up PR) by the smart buffer as an additive flush
 * trigger: a turn that is semantically far from everything already in memory is
 * "surprising" and worth extracting immediately, even if turn-count and signal
 * heuristics would otherwise keep buffering.
 *
 * This module intentionally contains ONLY the pure scoring function. Wiring
 * into the buffer, configuration flags, telemetry, and benchmark work live in
 * later PRs (see issue #563). Keeping the helper in a sibling file instead of
 * inside `buffer.ts` keeps the buffer module focused and makes the eventual
 * integration a small, reviewable change.
 *
 * # Formula
 *
 * Given an input `turn` and a list of `recentMemories`:
 *
 * 1. Embed the turn and every candidate memory via the caller-provided
 *    `embedFn`.
 * 2. For each candidate, compute cosine similarity `cos(turn, candidate)` in
 *    `[0, 1]` (negative cosines are clamped to 0 — "opposite directions"
 *    is treated as maximally diverse, consistent with `recall-mmr.ts`).
 * 3. Keep the top-`k` *highest* similarities (the turn's nearest neighbors).
 * 4. Average those top-`k` similarities → `nearestSim ∈ [0, 1]`.
 * 5. Return `1 − nearestSim` as the surprise score.
 *
 * Intuition: a turn that is close to at least one recent memory has a high
 * `nearestSim` and therefore a *low* surprise (near 0 = redundant). A turn
 * that is far from all of its k nearest neighbors has a low `nearestSim` and
 * therefore a *high* surprise (near 1 = novel).
 *
 * Using the top-k average instead of a single nearest neighbor makes the
 * score less sensitive to one outlier duplicate (e.g. an exact restatement of
 * a stale fact). `k=1` reduces to pure nearest-neighbor distance.
 *
 * # Edge cases
 *
 * - `recentMemories` empty → returns `1.0` (maximally surprising). There is
 *   nothing to compare against, so the turn cannot be redundant.
 * - `k` default is `5`. It is clamped to `[1, recentMemories.length]` so that
 *   small corpora still produce a meaningful score (e.g. 3 memories with
 *   `k=5` behaves the same as `k=3`).
 * - Zero-norm embeddings (all zeros) contribute similarity `0` (they cannot
 *   be "close" to anything), which is treated as maximally surprising for
 *   that pair. The rest of the corpus is scored normally.
 * - Embedding-length mismatches between the turn and a candidate are treated
 *   as similarity `0` for that pair. We do not silently truncate to the
 *   shorter vector because that would hide a real configuration bug.
 * - `embedFn` rejection is allowed to propagate. The caller decides whether
 *   to catch, fall back, or fail the flush decision — this helper has no
 *   opinion beyond the pure score.
 *
 * # Purity
 *
 * No I/O, no hidden globals. Given the same inputs and the same `embedFn`,
 * the output is deterministic.
 */

import { cosineSimilarity } from "./semantic-chunking.js";

/** Minimal shape of a recent memory passed to `computeSurprise`. */
export interface RecentMemoryLike {
  /** Stable identifier. Only used for debug/logging; not part of the score. */
  readonly id: string;
  /** Text to embed and compare against the incoming turn. */
  readonly content: string;
}

/** Options accepted by `computeSurprise`. */
export interface ComputeSurpriseOptions {
  /**
   * Embedding function. Called once for the turn and once per candidate
   * memory. Callers may wrap a provider client, a local model, or a
   * deterministic hash for tests.
   */
  readonly embedFn: (text: string) => Promise<readonly number[]>;
  /**
   * Number of nearest neighbors to average over. Defaults to 5. Clamped to
   * `[1, recentMemories.length]`.
   */
  readonly k?: number;
}

/** Default k (top nearest neighbors to average). */
export const DEFAULT_SURPRISE_K = 5;

/**
 * Compute a surprise score in `[0, 1]` for `turn` against `recentMemories`.
 *
 * See the module-level docstring for the exact formula, edge cases, and
 * purity guarantees.
 *
 * @param turn           The incoming turn text (caller is responsible for
 *                       stringifying structured turn content — this helper
 *                       only needs the text to embed).
 * @param recentMemories Candidate memories to compare against.
 * @param options        `embedFn` (required) and optional `k` (defaults to 5).
 * @returns A scalar in `[0, 1]`. `1.0` = maximally surprising / novel;
 *          `0.0` = redundant with at least one recent memory.
 */
export async function computeSurprise(
  turn: string,
  recentMemories: readonly RecentMemoryLike[],
  options: ComputeSurpriseOptions,
): Promise<number> {
  if (typeof turn !== "string") {
    throw new TypeError("computeSurprise: `turn` must be a string");
  }
  if (!options || typeof options.embedFn !== "function") {
    throw new TypeError(
      "computeSurprise: `options.embedFn` is required and must be a function",
    );
  }
  const candidates = Array.isArray(recentMemories) ? recentMemories : [];

  // Empty corpus → maximally surprising. Document decision: we prefer
  // "novelty by default" over "silence" because the surprise score is meant
  // to *promote* flushing, and an empty buffer of recent memories is the
  // clearest case of "we have no basis to call this redundant".
  if (candidates.length === 0) return 1;

  const kRaw = typeof options.k === "number" ? options.k : DEFAULT_SURPRISE_K;
  // Clamp k to [1, candidates.length]. Non-integer / non-finite values fall
  // back to the default, then get re-clamped below.
  const kClamped = clampK(kRaw, candidates.length);

  // Embed the turn and every candidate. Rejections propagate — that's the
  // caller's decision to handle. Run candidate embeddings in parallel so a
  // slow embedder does not serialize the whole pass.
  const turnEmbedding = await options.embedFn(turn);
  const candidateEmbeddings = await Promise.all(
    candidates.map((c) => options.embedFn(c.content)),
  );

  const sims: number[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candEmbedding = candidateEmbeddings[i] ?? [];
    sims.push(safeCosine(turnEmbedding, candEmbedding));
  }

  // Sort similarities descending and take the top-k (the nearest neighbors).
  sims.sort((a, b) => b - a);
  const top = sims.slice(0, kClamped);

  if (top.length === 0) {
    // Defensive — with `candidates.length >= 1` and `kClamped >= 1`, we
    // should always have at least one similarity. If we somehow do not,
    // treat as maximally surprising rather than returning NaN.
    return 1;
  }

  let sum = 0;
  for (const s of top) sum += s;
  const nearestSim = sum / top.length;

  const surprise = 1 - nearestSim;
  // Numerical safety: clamp the final value. Cosine is clamped to [0, 1]
  // per-pair already, so the mean cannot escape that range under normal
  // arithmetic, but floating-point drift is cheap to guard against.
  if (!Number.isFinite(surprise)) return 1;
  if (surprise < 0) return 0;
  if (surprise > 1) return 1;
  return surprise;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function clampK(k: number, ceiling: number): number {
  if (!Number.isFinite(k)) {
    return Math.min(DEFAULT_SURPRISE_K, Math.max(1, ceiling));
  }
  const floored = Math.floor(k);
  if (floored < 1) return 1;
  if (floored > ceiling) return ceiling;
  return floored;
}

/**
 * Safe wrapper around `cosineSimilarity` that returns a similarity value in
 * `[0, 1]` (negative cosines are clamped to 0, matching the convention used
 * by `recall-mmr.ts`) and tolerates mismatched or empty vectors without
 * throwing. See `semantic-chunking.ts` for the shared cosine implementation.
 *
 * Returns `0` for:
 * - empty vectors,
 * - length mismatches (callers likely have a config bug, but surprise
 *   scoring is a soft signal — do not crash the buffer flush decision),
 * - non-finite cosine results (zero-norm inputs, arithmetic drift).
 */
function safeCosine(a: readonly number[], b: readonly number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  const raw = cosineSimilarity(a as number[], b as number[]);
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

