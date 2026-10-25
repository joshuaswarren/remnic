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

/** Runtime profiles whose adapter runs the core extraction pipeline. */
export const EXTRACTION_CAPABLE_RUNTIME_PROFILES = Object.freeze([
  "real",
  "openclaw-chain",
] as const);

export interface LoCoMoReplayExtractionContext {
  action: BenchAction;
  publishedName: string | undefined;
  benchmarks: readonly string[];
  runtimeProfile: string | undefined;
  matrixProfiles: readonly string[] | undefined;
  adapter: "remnic" | "mcp" | undefined;
}

/**
 * Parse `--replay-extraction-mode <skip|await>`. Only valid when the run
 * targets exactly LoCoMo (`run locomo` or `published --name locomo`).
 * `await` additionally requires an adapter that can extract: the baseline
 * profile, `--quick` lightweight runs, `--matrix`, and `--adapter mcp` would
 * otherwise record `replayExtractionMode: "await"` while making zero
 * extraction calls.
 */
export function parseLoCoMoReplayExtractionArgs(
  args: string[],
  ctx: LoCoMoReplayExtractionContext,
): LoCoMoReplayExtractionArgs {
  const { action, publishedName, benchmarks } = ctx;
  const flag = "--replay-extraction-mode";
  const occurrences = args.filter(
    (arg) => arg === flag || arg.startsWith(`${flag}=`),
  ).length;
  if (occurrences > 1) {
    throw new Error("ERROR: --replay-extraction-mode may be given only once.");
  }
  const raw = readBenchOptionValue(args, flag);
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
  if (raw === "await") {
    const capable =
      ctx.adapter !== "mcp" &&
      ctx.matrixProfiles === undefined &&
      !args.includes("--quick") &&
      (EXTRACTION_CAPABLE_RUNTIME_PROFILES as readonly string[]).includes(
        ctx.runtimeProfile ?? "baseline",
      );
    if (!capable) {
      throw new Error(
        "ERROR: --replay-extraction-mode await requires the remnic adapter with " +
          "--runtime-profile real or openclaw-chain (no --matrix or --quick); other " +
          "setups cannot run extraction.",
      );
    }
  }
  return { locomoReplayExtractionMode: raw };
}
