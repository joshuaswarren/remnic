import { coerceBooleanLike, coerceNumber } from "../connectors/coerce.js";

/**
 * Embedding-density novelty gate (issue #1953, SAGE).
 *
 * score = 1 - mean(cosine of k nearest). Higher score = more novel.
 *   score >= noveltyAddThreshold  → add (skip semantic/LLM dedup)
 *   score <= noveltyNoopThreshold → noop (drop; do not touch contentHashIndex)
 *   else                          → uncertain (fall through to semantic dedup)
 *
 * Defaults keep a wide UNCERTAIN band. noveltyGateEnabled defaults false.
 * Backend failure is not handled here — callers treat a thrown lookup as uncertain.
 */
export const DEFAULT_NOVELTY_ADD_THRESHOLD = 0.55;
export const DEFAULT_NOVELTY_NOOP_THRESHOLD = 0.15;
export const DEFAULT_NOVELTY_K = 5;

export interface NoveltyNeighbor {
  id: string;
  embedding: number[];
}

export interface NoveltyDecision {
  score: number;
  decision: "add" | "noop" | "uncertain";
  neighborId?: string;
}

export interface NoveltyThresholds {
  addThreshold?: number;
  noopThreshold?: number;
  k?: number;
}

export interface WritePathDedupConfig {
  semanticDedupEnabled: boolean;
  semanticDedupThreshold: number;
  semanticDedupCandidates: number;
  noveltyGateEnabled: boolean;
  noveltyAddThreshold: number;
  noveltyNoopThreshold: number;
}

function clamp01(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  const raw = dot / denom;
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

export function parseWritePathDedupConfig(cfg: Record<string, unknown>): WritePathDedupConfig {
  const rawCandidates = coerceNumber(cfg.semanticDedupCandidates, "semanticDedupCandidates");
  let semanticDedupCandidates = 5;
  if (rawCandidates !== undefined && rawCandidates >= 0) {
    const n = Math.floor(rawCandidates);
    semanticDedupCandidates = rawCandidates > 0 && n === 0 ? 1 : n;
  }
  return {
    semanticDedupEnabled: coerceBooleanLike(cfg.semanticDedupEnabled, "semanticDedupEnabled") !== false,
    semanticDedupThreshold: clamp01(
      coerceNumber(cfg.semanticDedupThreshold, "semanticDedupThreshold"),
      0.92,
    ),
    semanticDedupCandidates,
    noveltyGateEnabled: coerceBooleanLike(cfg.noveltyGateEnabled, "noveltyGateEnabled") === true,
    noveltyAddThreshold: clamp01(
      coerceNumber(cfg.noveltyAddThreshold, "noveltyAddThreshold"),
      DEFAULT_NOVELTY_ADD_THRESHOLD,
    ),
    noveltyNoopThreshold: clamp01(
      coerceNumber(cfg.noveltyNoopThreshold, "noveltyNoopThreshold"),
      DEFAULT_NOVELTY_NOOP_THRESHOLD,
    ),
  };
}

export function embeddingsFromCosineHits(
  hits: ReadonlyArray<{ id: string; score: number }>,
): { embedding: number[]; neighborhood: NoveltyNeighbor[] } {
  return {
    embedding: [1, 0],
    neighborhood: hits.map((hit) => {
      const s = Number.isFinite(hit.score) ? Math.min(1, Math.max(-1, hit.score)) : 0;
      return { id: hit.id, embedding: [s, Math.sqrt(Math.max(0, 1 - s * s))] };
    }),
  };
}

export function scoreNovelty(
  embedding: number[],
  neighborhood: NoveltyNeighbor[],
  thresholds: NoveltyThresholds = {},
): NoveltyDecision {
  const addThreshold = clamp01(thresholds.addThreshold ?? DEFAULT_NOVELTY_ADD_THRESHOLD, DEFAULT_NOVELTY_ADD_THRESHOLD);
  const noopThreshold = clamp01(thresholds.noopThreshold ?? DEFAULT_NOVELTY_NOOP_THRESHOLD, DEFAULT_NOVELTY_NOOP_THRESHOLD);
  const k = thresholds.k !== undefined && Number.isFinite(thresholds.k) && thresholds.k > 0
    ? Math.floor(thresholds.k)
    : DEFAULT_NOVELTY_K;

  if (neighborhood.length === 0) {
    return { score: 1, decision: "add" };
  }

  const ranked = neighborhood
    .map((neighbor) => ({
      id: neighbor.id,
      cosine: cosine(embedding, neighbor.embedding),
    }))
    .sort((a, b) => b.cosine - a.cosine);
  const nearest = ranked.slice(0, Math.max(1, k));
  const density = nearest.reduce((sum, row) => sum + row.cosine, 0) / nearest.length;
  const score = 1 - density;
  const neighborId = ranked[0]?.id;

  if (score >= addThreshold) return { score, decision: "add", neighborId };
  if (score <= noopThreshold) return { score, decision: "noop", neighborId };
  return { score, decision: "uncertain", neighborId };
}

export async function applyNoveltyGate(opts: {
  enabled: boolean;
  addThreshold: number;
  noopThreshold: number;
  lookup: () => Promise<{ embedding: number[]; neighborhood: NoveltyNeighbor[] }>;
}): Promise<NoveltyDecision> {
  if (!opts.enabled) {
    return { score: 0, decision: "uncertain" };
  }
  try {
    const { embedding, neighborhood } = await opts.lookup();
    return scoreNovelty(embedding, neighborhood, {
      addThreshold: opts.addThreshold,
      noopThreshold: opts.noopThreshold,
    });
  } catch {
    return { score: 0, decision: "uncertain" };
  }
}
