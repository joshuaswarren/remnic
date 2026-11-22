/**
 * Graph edge confidence + reinforcement primitives (issue #681, PR 1/3).
 *
 * Pure functions only — no I/O, no global state. The maintenance job (PR 2/3)
 * and PageRank weighting (PR 3/3) compose these helpers.
 *
 * Schema:
 *   - `confidence`   ∈ [0, 1]; missing on legacy edges, treated as 1.0.
 *   - `lastReinforcedAt` — ISO timestamp of most recent reinforcement; missing
 *     on legacy edges, treated as the original edge `ts`.
 *
 * Defaults documented here are the agreed-on starting points and may be
 * tuned later via config. They live as named constants so call sites and
 * tests share the same values.
 */

import type { GraphEdge } from "./graph.js";

/** Default confidence bump per reinforcement event. */
export const DEFAULT_REINFORCE_DELTA = 0.05;

/** Maximum edge confidence — confidence is capped at this on reinforcement. */
export const CONFIDENCE_CEILING = 1.0;

/** Default decay window in milliseconds (90 days). */
export const DEFAULT_DECAY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Default decay floor — confidence will not drop below this purely from age. */
export const DEFAULT_DECAY_FLOOR = 0.1;

/** Default per-window decay amount (linear). */
export const DEFAULT_DECAY_PER_WINDOW = 0.1;

/**
 * Treat a missing `confidence` on a legacy edge as 1.0.
 * Clamps to `[0, CONFIDENCE_CEILING]` so downstream math is well-behaved.
 */
export function readEdgeConfidence(edge: Pick<GraphEdge, "confidence">): number {
  const raw = edge.confidence;
  if (raw === undefined || raw === null || !Number.isFinite(raw)) {
    return CONFIDENCE_CEILING;
  }
  if (raw < 0) return 0;
  if (raw > CONFIDENCE_CEILING) return CONFIDENCE_CEILING;
  return raw;
}

/**
 * Resolve the reference timestamp for decay calculations.
 * Falls back to the edge's creation `ts` when `lastReinforcedAt` is absent
 * (legacy edges have never been reinforced).
 */
export function readLastReinforcedAt(
  edge: Pick<GraphEdge, "lastReinforcedAt" | "ts">,
): string {
  return edge.lastReinforcedAt ?? edge.ts;
}

/**
 * Reinforce an edge: bump confidence by `delta` (capped at 1.0) and stamp
 * `lastReinforcedAt = now`. Pure — returns a new edge, never mutates input.
 *
 * Idempotency note: calling reinforceEdge twice with the same `now` and a
 * delta of 0 returns an edge equal to the input (modulo timestamp).
 *
 * @param edge  the edge to reinforce
 * @param now   ISO timestamp of the reinforcement event
 * @param delta confidence bump; defaults to DEFAULT_REINFORCE_DELTA
 */
export function reinforceEdge(
  edge: GraphEdge,
  now: string,
  delta: number = DEFAULT_REINFORCE_DELTA,
): GraphEdge {
  const current = readEdgeConfidence(edge);
  const safeDelta =
    Number.isFinite(delta) && delta >= 0 ? delta : 0;
  const next = Math.min(CONFIDENCE_CEILING, Math.max(0, current + safeDelta));
  return {
    ...edge,
    confidence: next,
    lastReinforcedAt: now,
  };
}

/** Options for {@link decayEdgeConfidence}. */
export interface DecayOptions {
  /** Decay window in milliseconds. Defaults to 90 days. */
  windowMs?: number;
  /** Per-window decay amount. Defaults to 0.1. */
  perWindow?: number;
  /** Floor confidence will not decay below. Defaults to 0.1. */
  floor?: number;
}

/**
 * Apply linear decay to an edge's confidence based on time since last
 * reinforcement (or creation, for legacy edges). Pure — returns a new edge.
 *
 * Decay model:
 *   age = now - lastReinforcedAt
 *   if age <= windowMs:           confidence unchanged
 *   else:                          confidence -= perWindow * floor((age - windowMs) / windowMs + 1)
 *   confidence is clamped to [floor, 1.0]
 *
 * Boundary semantics: `age === windowMs` is INSIDE the no-decay grace period
 * (`<=`). Decay only kicks in once age strictly exceeds the window. This
 * keeps the boundary deterministic and easy to test.
 *
 * @param edge edge to decay (confidence and lastReinforcedAt may be absent)
 * @param now  ISO timestamp representing "now"
 * @param opts override window / per-window / floor; otherwise defaults are used
 */
export function decayEdgeConfidence(
  edge: GraphEdge,
  now: string,
  opts: DecayOptions = {},
): GraphEdge {
  const windowMs = opts.windowMs ?? DEFAULT_DECAY_WINDOW_MS;
  const perWindow = opts.perWindow ?? DEFAULT_DECAY_PER_WINDOW;
  const floor = opts.floor ?? DEFAULT_DECAY_FLOOR;

  if (
    !(windowMs > 0) ||
    !Number.isFinite(perWindow) ||
    perWindow < 0 ||
    !Number.isFinite(floor)
  ) {
    return { ...edge, confidence: readEdgeConfidence(edge) };
  }
  const safeFloor = Math.min(CONFIDENCE_CEILING, Math.max(0, floor));

  const nowMs = Date.parse(now);
  const refMs = Date.parse(readLastReinforcedAt(edge));
  if (!Number.isFinite(nowMs) || !Number.isFinite(refMs)) {
    return { ...edge, confidence: readEdgeConfidence(edge) };
  }

  const age = nowMs - refMs;
  const current = readEdgeConfidence(edge);

  if (age <= windowMs) {
    return { ...edge, confidence: current };
  }

  const windowsPast = Math.ceil((age - windowMs) / windowMs);
  const decayed = current - perWindow * windowsPast;
  const lowerBound = Math.min(safeFloor, current);
  const next = Math.max(lowerBound, Math.min(current, decayed));

  const newRefMs = refMs + windowsPast * windowMs;
  const newRef = new Date(newRefMs).toISOString();
  return { ...edge, confidence: next, lastReinforcedAt: newRef };
}
