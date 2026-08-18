/**
 * Shared preference-drift type surfaces (issue #2371).
 *
 * These live in the preferences module rather than in `types.ts` so the
 * cross-cutting fields drift detection introduces are declared next to the
 * subsystem that owns them, and `types.ts` composes them through `extends`
 * instead of growing another inline block.
 */

import type { DriftDetectionConfig } from "./drift-config.js";

/**
 * Drift verdict persisted on `preference` memories. `corroborated` is
 * deliberately NOT a member: a corroborated preference clears `driftState` and
 * stamps `lastCorroborated`, so the stored enum only carries a negative
 * verdict.
 */
export type MemoryDriftState = "stale" | "drifted";

/**
 * Derived drift provenance stamped by the scan AFTER a memory exists — never
 * supplied at compose time, which is why these fields stay outside the sealed
 * write envelope for exactly the reason `mw_success` / `mw_fail` do.
 *
 * Mixed into `MemoryFrontmatter`.
 */
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

/**
 * Frontmatter codec for the drift stamps. Lives here, beside the interface it
 * serializes, so `storage.ts` stays a caller rather than growing another
 * field-specific block.
 */
export function serializeDriftProvenance(fm: MemoryDriftProvenance): string[] {
  const lines: string[] = [];
  if (fm.driftState !== undefined) {
    // An unrecognized verdict on write is a caller bug that must surface, not
    // something to persist silently.
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

/**
 * Read the drift stamps back. A hand-edited or unrecognized stored verdict
 * round-trips to `undefined` rather than poisoning recall damping — the same
 * policy the Memory Worth counters use for corrupt values.
 */
export function parseDriftProvenance(
  fm: Record<string, string | undefined>,
): MemoryDriftProvenance {
  return {
    driftState:
      fm.driftState === "stale" || fm.driftState === "drifted" ? fm.driftState : undefined,
    lastCorroborated: fm.lastCorroborated || undefined,
  };
}
