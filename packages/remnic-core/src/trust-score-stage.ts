/**
 * trust-score-stage.ts — signal adapters + recall pipeline stage (issue #1577 PR 2).
 *
 * This module sits between the pure {@link computeTrustScore} scorer and the
 * recall pipeline. It owns TWO jobs:
 *
 *   1. **Signal adapters** — read each trust signal via existing readers only
 *      (`buildMemoryWorthCounterMap`-style frontmatter scan, faithfulness /
 *      provenance / sources frontmatter from #1575/#1576). No new disk format,
 *      no new write path. Expensive / optional signals (belief-ledger domain
 *      calibration, contradiction review queue) are extension points that
 *      return `undefined` when unwired — the scorer degrades to neutral for
 *      any absent signal (rule 34).
 *
 *   2. **The recall stage** — apply `trustMultiplier(trust.score)` to each
 *      candidate, exclude `quarantine`-band items from injection, and surface
 *      the per-result `{ score, band, components }` so X-ray and the epistemic
 *      renderer can explain the basis.
 *
 * Mutual exclusion with the Memory Worth filter (rule 39 — one multiplier, one
 * application point): when this stage runs, the standalone memory-worth filter
 * MUST NOT also run. The orchestrator enforces that at the wiring site
 * (`if (caps.recallTrustScore) … else if (caps.recallMemoryWorthFilter) …`);
 * the `double-multiplier` test below pins it structurally.
 */

import { computeMemoryWorth } from "./memory-worth.js";
import {
  computeTrustScore,
  trustMultiplier,
  type TrustBand,
  type TrustScoreComponent,
  type TrustScoreResult,
  type TrustSignals,
  type TrustWeights,
} from "./trust-score.js";
import type { FaithfulnessFrontmatter, ProvenanceSource } from "./types.js";

/**
 * Frontmatter projection the adapter reads. Kept narrow + structural so it can
 * be fed from a `MemoryFrontmatter`, a bench fixture, or a test stub without
 * pulling the full frontmatter type graph into the stage module.
 */
export interface TrustFrontmatterProjection {
  mw_success?: number;
  mw_fail?: number;
  lastAccessed?: string | null;
  provenance?: "verified" | "unverified" | "none";
  faithfulness?: FaithfulnessFrontmatter;
  sources?: ProvenanceSource[];
  /** Optional ISO creation/observation timestamp used for recency. */
  observedAt?: string;
}

/**
 * Build a `path → TrustSignals` map from an in-memory frontmatter scan. The
 * caller passes the memories already read for the memory-worth counter map so
 * we do not re-read the namespace. Pure: no I/O, takes `now` explicitly.
 */
export function buildTrustSignalMap(
  memories: ReadonlyArray<{ path: string; frontmatter: TrustFrontmatterProjection }>,
  now: Date,
  options: { recencyHalfLifeDays?: number } = {},
): Map<string, TrustSignals> {
  const map = new Map<string, TrustSignals>();
  const nowMs = now.getTime();
  const nowUsable = Number.isFinite(nowMs);
  for (const m of memories) {
    const fm = m.frontmatter;
    const signals: TrustSignals = {};

    // Memory worth — reuse the exact Laplace computation the standalone filter
    // uses so the two never disagree on the same counters.
    if (fm.mw_success !== undefined || fm.mw_fail !== undefined) {
      const worth = computeMemoryWorth({
        mw_success: fm.mw_success,
        mw_fail: fm.mw_fail,
        lastAccessed: fm.lastAccessed,
        now,
      });
      signals.memoryWorth = { score: worth.score, confidence: worth.confidence };
    }

    if (fm.provenance !== undefined) signals.provenance = fm.provenance;
    if (fm.faithfulness !== undefined) signals.faithfulness = fm.faithfulness.verdict;

    // Corroboration = distinct source sessions/turns backing the fact.
    if (Array.isArray(fm.sources) && fm.sources.length > 0) {
      const distinct = new Set(
        fm.sources.map((s) => `${s.sessionKey ?? ""}|${s.turnId ?? ""}`),
      );
      signals.corroborationCount = distinct.size;
    }

    // Recency: prefer an explicit observation timestamp; fall back to
    // lastAccessed. Days-old vs the per-category half-life the caller supplies.
    const ts = fm.observedAt ?? fm.lastAccessed;
    if (nowUsable && typeof ts === "string" && ts.length > 0) {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) {
        const ageDays = Math.max(0, (nowMs - parsed) / (24 * 60 * 60 * 1000));
        signals.ageDays = ageDays;
        if (options.recencyHalfLifeDays !== undefined) {
          signals.recencyHalfLifeDays = options.recencyHalfLifeDays;
        }
      }
    }

    // Only record an entry when at least one signal is present — a fully-empty
    // entry would score neutral anyway, and skipping keeps the map small.
    if (Object.keys(signals).length > 0) {
      map.set(m.path, signals);
    }
  }
  return map;
}

/** A scored recall candidate (mirrors `MemoryWorthFilterCandidate`). */
export interface TrustStageCandidate {
  path: string;
  score: number;
}

/** One candidate after the TrustScore stage. */
export interface TrustStageResultItem {
  path: string;
  /** Final score after the trust multiplier is applied. */
  score: number;
  /** The untouched input score — for telemetry / X-ray. */
  originalScore: number;
  /** The multiplier applied (exactly `1.0` for neutral / quarantined-kept). */
  multiplier: number;
  /** The full TrustScore result for X-ray + epistemic rendering. */
  trust: TrustScoreResult;
  /** `true` when the item was excluded from injection by quarantine. */
  quarantined: boolean;
}

export interface TrustStageOptions {
  /** `path → TrustSignals`. Candidates absent from the map score neutral. */
  signals: ReadonlyMap<string, TrustSignals>;
  weights?: TrustWeights;
  /** Multiplier bounds; see {@link trustMultiplier}. */
  minMultiplier?: number;
  maxMultiplier?: number;
  /**
   * When `true` (default), `quarantine`-band items are excluded from the
   * returned (injected) list but still appear in {@link TrustStageOutput.all}
   * with `quarantined: true` so X-ray can surface them with a reason.
   * Only effective when the stage is active at all.
   */
  quarantine?: boolean;
  /**
   * Re-sort admitted candidates by descending multiplied score. Default `true`.
   * When `false`, admitted items keep input order; quarantined items are still
   * separated out.
   */
  reorder?: boolean;
}

/** Output of {@link applyTrustScoreStage}. */
export interface TrustStageOutput {
  /** Admitted (injectable) candidates, score-multiplied and optionally sorted. */
  admitted: TrustStageResultItem[];
  /**
   * Quarantined candidates — excluded from injection but visible to X-ray with
   * the reason (rule 34 — exclusion must never look like "no result"). Callers
   * that only need the injected list read `admitted`; X-ray reads `all`.
   */
  quarantined: TrustStageResultItem[];
  /** Every candidate (admitted + quarantined) in input order, for X-ray. */
  all: TrustStageResultItem[];
}

/**
 * Apply the unified TrustScore stage: score each candidate, multiply its base
 * score by `trustMultiplier(trust.score)`, and separate hard-negative
 * (quarantine) items from the injectable set.
 *
 * Neutral candidates (no signals → multiplier `1.0`) are mathematically
 * untouched, preserving byte-identical ranking for uninstrumented memories
 * when the feature is ON (and the whole stage is skipped when OFF — rule 39).
 */
export function applyTrustScoreStage(
  candidates: readonly TrustStageCandidate[],
  options: TrustStageOptions,
): TrustStageOutput {
  const reorder = options.reorder !== false;
  const quarantine = options.quarantine !== false;
  const minMul = options.minMultiplier;
  const maxMul = options.maxMultiplier;

  const all: TrustStageResultItem[] = [];
  const admitted: TrustStageResultItem[] = [];
  const quarantined: TrustStageResultItem[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const signals = options.signals.get(c.path);
    const trust = computeTrustScore(signals, options.weights);
    const isQuarantined = quarantine && trust.band === "quarantine";
    // Quarantined items are excluded from injection. Keep their score unchanged
    // so X-ray shows what the pipeline WOULD have injected — never inflate or
    // zero the score of a hidden item (rule 34).
    const multiplier = isQuarantined ? 1 : trustMultiplier(trust.score, minMul, maxMul);
    // Clamp the base score at zero before multiplying, mirroring the
    // memory-worth filter: a negative base would invert the multiplier's
    // intended direction (see memory-worth-filter.ts:145-153).
    const safeBase = c.score < 0 ? 0 : c.score;
    const scored = safeBase * multiplier;
    const item: TrustStageResultItem = {
      path: c.path,
      score: scored,
      originalScore: c.score,
      multiplier,
      trust,
      quarantined: isQuarantined,
    };
    all.push(item);
    if (isQuarantined) quarantined.push(item);
    else admitted.push(item);
  }

  if (reorder) {
    // Stable sort by descending multiplied score, with original input position
    // as the deterministic tiebreaker (CLAUDE.md rule 19 / checklist §12).
    admitted.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreaker: original insertion order. We don't have the index handy on
      // the item, so derive it from `all` ordering (input order is preserved
      // there). Equal-score items keep first-seen-first order.
      return 0;
    });
    // Node's sort is stable (ES2019+); the explicit `return 0` documents the
    // contract for reviewers.
  }

  return { admitted, quarantined, all };
}

/**
 * Compact X-ray projection of one stage item. Kept separate from the full
 * `TrustScoreResult` so the X-ray snapshot type stays narrow and serializable,
 * and so the renderer never depends on the scorer's internal component map
 * shape beyond `{ value, weight }`.
 */
export interface TrustXrayProjection {
  score: number;
  band: TrustBand;
  components: Record<string, TrustScoreComponent>;
  multiplier: number;
  quarantined: boolean;
  /** Human-readable exclusion reason, present only when quarantined. */
  quarantineReason?: string;
}

/** Build the X-ray projection for one stage result item. */
export function projectTrustForXray(item: TrustStageResultItem): TrustXrayProjection {
  const proj: TrustXrayProjection = {
    score: item.trust.score,
    band: item.trust.band,
    components: item.trust.components,
    multiplier: item.multiplier,
    quarantined: item.quarantined,
  };
  if (item.quarantined) {
    proj.quarantineReason = explainQuarantine(item.trust);
  }
  return proj;
}

/** Deterministic, component-derived reason a memory was quarantined. */
export function explainQuarantine(trust: TrustScoreResult): string {
  const c = trust.components;
  if (c.faithfulness && c.faithfulness.value === 0) return "faithfulness: contradicted";
  if (c.contradiction && c.contradiction.value <= 0.2) return "contradiction: pending review";
  return "hard-negative trust signal";
}

