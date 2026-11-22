
import type { PublishedBenchmarkId } from "../published-artifact.js";

/** Identifier for one ablation cell. Stable across runs; used in artifact notes + filenames. */
export type SingleFlagAblationId = "memory-worth-off" | "contradiction-scan-on" | "graph-recall-on";

/** The config-override payload merged into `adapterOptions.configOverrides`. */
export type AblationConfigOverrides = Record<string, unknown>;

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

export const DEFAULT_ABLATION_BENCHMARK: PublishedBenchmarkId = "locomo";

export function getAblationCell(id: SingleFlagAblationId): SingleFlagAblationCell {
  const cell = SINGLE_FLAG_ABLATION_MATRIX.find((c) => c.id === id);
  if (!cell) {
    throw new Error(
      `Unknown ablation cell id "${id}". Known ids: ${SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.id).join(", ")}.`
    );
  }
  return cell;
}
