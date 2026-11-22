
import type { DriftDetectionConfig } from "./drift-config.js";

export type MemoryDriftState = "stale" | "drifted";

export interface MemoryDriftProvenance {
  /**
   * `stale` means the lookback window held no corroborating evidence either
   * way; `drifted` means recent evidence pointed away from the preference and
   * a review item was opened. Absent means "not classified".
   */
  driftState?: MemoryDriftState;
  /** ISO 8601 timestamp of the last run that found corroborating evidence. */
  lastCorroborated?: string;
}

/**
 * Per-recall render hint, mixed into `QmdSearchResult`. Set by the
 * preference-drift recall stage when `driftDetection.annotateAfterDays` is on
 * and absent otherwise. Never persisted — this annotates one injection, it is
 * not memory state.
 */
export interface RecallDriftAnnotation {
  driftNote?: string;
}

/** Mixed into `PluginConfig`. */
export interface DriftDetectionSettings {
  driftDetection: DriftDetectionConfig;
}

export function serializeDriftProvenance(fm: MemoryDriftProvenance): string[] {
  const lines: string[] = [];
  if (fm.driftState !== undefined) {
    if (fm.driftState !== "stale" && fm.driftState !== "drifted") {
      throw new Error(
        `serializeFrontmatter: invalid driftState ${JSON.stringify(fm.driftState)} — expected "stale" | "drifted"`,
      );
    }
    lines.push(`driftState: ${fm.driftState}`);
  }
  if (fm.lastCorroborated) lines.push(`lastCorroborated: ${fm.lastCorroborated}`);
  return lines;
}

export function parseDriftProvenance(
  fm: Record<string, string | undefined>,
): MemoryDriftProvenance {
  return {
    driftState:
      fm.driftState === "stale" || fm.driftState === "drifted" ? fm.driftState : undefined,
    lastCorroborated: fm.lastCorroborated || undefined,
  };
}
