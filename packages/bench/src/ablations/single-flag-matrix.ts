/**
 * Single-flag ablation matrix for the published-benchmark ablation suite
 * (issues #1574 §"Ablations" and #1730).
 *
 * Each ablation is a reproducible run config: a named cell that flips exactly
 * one Remnic config flag relative to the {@link buildBenchBaselineRemnicConfig}
 * baseline, so the delta against the matching baseline artifact isolates that
 * flag's effect. The matrix is pure data — no I/O — so it is trivially
 * testable and the runner script (`scripts/bench/run-ablation-matrix.ts`) is
 * just a thin shell over the public bench API.
 *
 * The three axes come straight from #1574's "Ablations" section:
 *   1. Memory Worth recall multiplier (`recallMemoryWorthFilterEnabled`)
 *   2. Contradiction scan — implemented via the INLINE write-path gate
 *      `contradictionDetectionEnabled` (NOT the `contradictionScan` cron,
 *      which only registers a scheduled job that never fires during a bench
 *      replay, so it would measure nothing).
 *   3. Graph / temporal recall (`graphRecallEnabled` + `multiGraphMemoryEnabled`
 *      — orchestrator.ts §1379 requires BOTH for graph_mode — + the full-mode
 *      graph assist gate).
 *
 * Baseline state of each flag (the raw `config.ts` parse default, since the
 * bench baseline config does NOT override these):
 *   - `recallMemoryWorthFilterEnabled`: **true** (default; #1574 baseline ran
 *     with it ON, so the ablation cell turns it OFF to measure the cost of
 *     removing it).
 *   - `contradictionDetectionEnabled`: **false** (config.ts §2078; ablation
 *     cell turns it ON so write-path supersessions land before answering).
 *   - `graphRecallEnabled` / `multiGraphMemoryEnabled`: **false** (default;
 *     ablation cell turns BOTH on + the full-mode graph assist).
 *
 * `trustScoreEnabled` is deliberately NOT an axis here: it is the unified
 * stage from #1577 and subsumes the Memory Worth multiplier when on (rule 39).
 * Its ablation belongs to the #1577 / #1585 model-lab track, not the
 * single-flag publishable-artifact track this matrix serves.
 *
 * Every cell carries a `baselineState` note so a reader of a committed
 * artifact can tell which direction the flag was flipped without cross-
 * referencing config.ts. The runner stamps this into the artifact `note`.
 */

import type { PublishedBenchmarkId } from "../published-artifact.js";

/** Identifier for one ablation cell. Stable across runs; used in artifact notes + filenames. */
export type SingleFlagAblationId = "memory-worth-off" | "contradiction-scan-on" | "graph-recall-on";

/** The config-override payload merged into `adapterOptions.configOverrides`. */
export type AblationConfigOverrides = Record<string, unknown>;

/** One reproducible ablation cell. */
export interface SingleFlagAblationCell {
  /** Stable cell id; appears in artifact notes and STATUS logs. */
  id: SingleFlagAblationId;
  /** Human-readable label for tables / STATUS files. */
  label: string;
  /** Which #1574 ablation axis this cell exercises. */
  axis: "memory-worth" | "contradiction-scan" | "graph-recall";
  /** One-line description of what the cell flips + why, for the artifact `note`. */
  description: string;
  /** State of the flag in the baseline run (so the delta direction is unambiguous). */
  baselineState: string;
  /** The Remnic config overrides that define this cell (merged over the baseline). */
  configOverrides: AblationConfigOverrides;
  /** The single top-level flag key this cell toggles (for grep / ratchet checks). */
  primaryFlag: "recallMemoryWorthFilterEnabled" | "contradictionDetectionEnabled" | "graphRecallEnabled";
}

/**
 * The canonical 3-cell single-flag ablation matrix (issue #1574 §"Ablations",
 * verified/produced for the paper under issue #1730).
 *
 * Order is stable: memory-worth → contradiction-scan → graph-recall. The
 * runner executes them in this order; tests assert the exact order so a
 * reordered matrix is a visible review signal, not a silent change.
 */
export const SINGLE_FLAG_ABLATION_MATRIX: readonly SingleFlagAblationCell[] = [
  {
    id: "memory-worth-off",
    label: "Memory Worth multiplier OFF",
    axis: "memory-worth",
    description:
      "Disables the Memory Worth recall multiplier (recallMemoryWorthFilterEnabled=false). " +
      "Baseline (#1574) ran with it ON via the config.ts default; this cell measures the cost of removing it.",
    baselineState: "recallMemoryWorthFilterEnabled defaults true in config.ts; baseline ran ON.",
    configOverrides: {
      recallMemoryWorthFilterEnabled: false,
    },
    primaryFlag: "recallMemoryWorthFilterEnabled",
  },
  {
    id: "contradiction-scan-on",
    label: "Contradiction scan ON",
    axis: "contradiction-scan",
    description:
      "Enables inline contradiction detection on the write path (contradictionDetectionEnabled=true) so supersessions " +
      "land at ingest time, before answering. The batch contradictionScan cron is a no-op during a bench replay (it " +
      "only registers a scheduled job), so the measurable axis is the inline write-path gate (orchestrator §15667); " +
      "contradictionAutoResolve defaults true so detected contradictions are applied. Baseline (#1574) ran with it OFF.",
    baselineState: "contradictionDetectionEnabled defaults false (config.ts §2078); baseline ran OFF.",
    configOverrides: {
      contradictionDetectionEnabled: true,
    },
    primaryFlag: "contradictionDetectionEnabled",
  },
  {
    id: "graph-recall-on",
    label: "Graph / temporal recall ON",
    axis: "graph-recall",
    description:
      "Enables graph recall + full-mode graph assist (graphRecallEnabled=true, graphAssistInFullModeEnabled=true, " +
      "multiGraphMemoryEnabled=true). orchestrator.ts §1379 skips graph_mode unless BOTH graphRecallEnabled AND " +
      "multiGraphMemoryEnabled are set, so the cell carries both gates (plus the full-mode assist) or it measures " +
      "nothing. Baseline (#1574) ran with graph recall OFF; this cell measures the benefit of causal/timeline expansion.",
    baselineState:
      "graphRecallEnabled, graphAssistInFullModeEnabled, multiGraphMemoryEnabled all default false; baseline ran OFF.",
    configOverrides: {
      graphRecallEnabled: true,
      graphAssistInFullModeEnabled: true,
      multiGraphMemoryEnabled: true,
    },
    primaryFlag: "graphRecallEnabled",
  },
] as const;

/**
 * The default benchmark the ablation matrix targets. LoCoMo is the headline
 * long-conversation benchmark and the one the #1574 baseline artifacts cover
 * at full scale (1986 QA across 10 conversations); the ablation cells compare
 * against that baseline. LongMemEval ablations are a documented follow-up
 * (issue #1730 scope: coordinate with, not duplicate, the rest of the paper).
 */
export const DEFAULT_ABLATION_BENCHMARK: PublishedBenchmarkId = "locomo";

/** Look up a cell by id. Throws on unknown id (fail fast at the runner boundary). */
export function getAblationCell(id: SingleFlagAblationId): SingleFlagAblationCell {
  const cell = SINGLE_FLAG_ABLATION_MATRIX.find((c) => c.id === id);
  if (!cell) {
    throw new Error(
      `Unknown ablation cell id "${id}". Known ids: ${SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.id).join(", ")}.`
    );
  }
  return cell;
}
