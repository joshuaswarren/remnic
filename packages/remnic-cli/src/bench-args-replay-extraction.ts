/**
 * `--replay-extraction-mode` parsing for LoCoMo bench runs (COS-404),
 * extracted from bench-args.ts under the structural ratchet (issue #1995).
 *
 * LoCoMo replays default to "skip" (LCM/transcript-first ingest, the
 * extractor is never called) so existing published LoCoMo numbers stay
 * comparable. "await" runs the configured extractor on every replayed
 * session, which is required when comparing extractor models.
 */

import type { BenchAction } from "./bench-args.js";
import { readBenchOptionValue } from "./bench-flags.js";

export const LOCOMO_REPLAY_EXTRACTION_MODES = Object.freeze(["skip", "await"] as const);
export type LoCoMoReplayExtractionMode =
  (typeof LOCOMO_REPLAY_EXTRACTION_MODES)[number];

export interface LoCoMoReplayExtractionArgs {
  /**
   * LoCoMo only — replay extraction mode for ingest. Unset means the CLI
   * default of "skip"; see {@link resolveLoCoMoReplayExtractionMode}.
   */
  locomoReplayExtractionMode?: LoCoMoReplayExtractionMode;
}

export function isLoCoMoReplayExtractionMode(
  value: string,
): value is LoCoMoReplayExtractionMode {
  return (LOCOMO_REPLAY_EXTRACTION_MODES as readonly string[]).includes(value);
}

/** Resolve the effective LoCoMo replay mode; the default stays "skip". */
export function resolveLoCoMoReplayExtractionMode(
  args: LoCoMoReplayExtractionArgs,
): LoCoMoReplayExtractionMode {
  return args.locomoReplayExtractionMode ?? "skip";
}

/**
 * Parse `--replay-extraction-mode <skip|await>`. Only valid when the run
 * targets exactly LoCoMo (`run locomo` or `published --name locomo`).
 */
export function parseLoCoMoReplayExtractionArgs(
  args: string[],
  action: BenchAction,
  publishedName: string | undefined,
  benchmarks: readonly string[],
): LoCoMoReplayExtractionArgs {
  const raw = readBenchOptionValue(args, "--replay-extraction-mode");
  if (raw === undefined) return {};
  if (!isLoCoMoReplayExtractionMode(raw)) {
    throw new Error("ERROR: --replay-extraction-mode must be one of: skip, await.");
  }
  const targetsLoCoMo =
    publishedName === "locomo" ||
    (publishedName === undefined &&
      action !== "published" &&
      !args.includes("--all") &&
      benchmarks.length === 1 &&
      benchmarks[0] === "locomo");
  if (!targetsLoCoMo) {
    throw new Error(
      "ERROR: --replay-extraction-mode is currently supported only for a single LoCoMo run.",
    );
  }
  return { locomoReplayExtractionMode: raw };
}
