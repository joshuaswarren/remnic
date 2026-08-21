/**
 * Stale-preference recall stage (issue #2371).
 *
 * Pure ranking + annotation helpers, deliberately free of storage, LLM, and
 * config-loading imports so the recall hot path can import them without
 * pulling in the drift scan's dependency graph.
 *
 * Two independent, independently-gated effects:
 *
 *   1. `driftDetection.recallDamping` multiplies the rank score of a
 *      `category: preference` memory carrying `driftState: stale` by
 *      `stalePenalty`, so a stale preference sinks below an otherwise-equal
 *      fresh memory. Applied in the same boost stage as the Memory Worth
 *      multiplier, so the pipeline-order contract (retrieve → filter →
 *      rerank/boost → cap → format) is untouched.
 *   2. `driftDetection.annotateAfterDays` emits a compact age note for a
 *      preference whose last corroboration is older than the configured
 *      window. Formatting-stage only — it never mutates the stored memory.
 *
 * Both are off by default, and with both off this module returns the input
 * order and no notes, so recall output is byte-identical to pre-#2371.
 */

import type { DriftDetectionConfig } from "./drift-config.js";
import type { MemoryDriftState } from "./drift-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The only frontmatter fields this stage reads. */
export interface DriftRecallFrontmatter {
  category?: string;
  driftState?: MemoryDriftState;
  lastCorroborated?: string;
  created?: string;
}

export interface DriftRankInput {
  /** Opaque candidate identity — the caller's composite (namespace, path) key. */
  key: string;
  /** Monotone-decreasing rank score preserving upstream order. */
  rank: number;
  frontmatter?: DriftRecallFrontmatter;
}

export interface DriftRankOutput {
  key: string;
  /** `1` when untouched, `stalePenalty` when damped. */
  multiplier: number;
  /** Injection annotation, when the age gate fired. */
  note?: string;
}

/**
 * True when this stage would change nothing. Callers use it to skip the
 * frontmatter lookups entirely on the default (all-off) configuration.
 *
 * `stalePenalty === 1` is the documented no-op (§33): damping stays "enabled"
 * but multiplies by one, so it must not by itself activate the stage.
 */
export function isPreferenceDriftStageActive(config: DriftDetectionConfig | undefined): boolean {
  if (!config) return false;
  // `recallDamping` is a real boolean here: parseDriftDetectionConfig already
  // coerced the string forms and threw on anything unrecognized, so no further
  // coercion is needed at this boundary.
  const damping = config.recallDamping && config.stalePenalty < 1;
  return damping || config.annotateAfterDays > 0;
}

/**
 * Render the age note for an uncorroborated preference, or `undefined` when
 * the gate is off or the preference is inside the window.
 *
 * `lastCorroborated` absent falls back to `created`: a preference the scan has
 * never corroborated is measured from when it was stated, which is exactly the
 * "stated 2026-01; not corroborated since" case the survey describes.
 */
export function driftAgeNote(
  frontmatter: DriftRecallFrontmatter | undefined,
  config: DriftDetectionConfig,
  now: Date,
): string | undefined {
  if (config.annotateAfterDays <= 0) return undefined;
  if (!frontmatter || frontmatter.category !== "preference") return undefined;
  const anchor = frontmatter.lastCorroborated ?? frontmatter.created;
  if (typeof anchor !== "string") return undefined;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return undefined;
  const ageDays = Math.floor((now.getTime() - anchorMs) / DAY_MS);
  if (ageDays < config.annotateAfterDays) return undefined;
  const stated = new Date(anchorMs).toISOString().slice(0, 7);
  return frontmatter.lastCorroborated
    ? `(corroborated ${stated}; not since)`
    : `(stated ${stated}; not corroborated since)`;
}

/**
 * Rank and annotate one recall branch's candidates.
 *
 * Returns one output per input, ordered by damped rank descending with a
 * stable key tiebreak so the comparator is total and the ordering is identical
 * across runs (§12).
 */
export function applyPreferenceDriftRanking(
  inputs: readonly DriftRankInput[],
  options: { config: DriftDetectionConfig; now: Date },
): DriftRankOutput[] {
  const { config, now } = options;
  const damping = config.recallDamping && config.stalePenalty < 1;

  const scored = inputs.map((input, index) => {
    const fm = input.frontmatter;
    const isStalePreference = fm?.category === "preference" && fm.driftState === "stale";
    const multiplier = damping && isStalePreference ? config.stalePenalty : 1;
    return {
      key: input.key,
      index,
      multiplier,
      damped: input.rank * multiplier,
      note: driftAgeNote(fm, config, now),
    };
  });

  scored.sort((a, b) => {
    if (a.damped !== b.damped) return a.damped > b.damped ? -1 : 1;
    // Equal damped score → preserve upstream order, then key, so the
    // comparator returns 0 only for genuinely identical entries.
    if (a.index !== b.index) return a.index < b.index ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });

  return scored.map((s) => (s.note ? { key: s.key, multiplier: s.multiplier, note: s.note } : { key: s.key, multiplier: s.multiplier }));
}
