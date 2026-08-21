import type { H6TrapId, StrategyPatch, SyntheticFile } from "./types.js";

export type FirstTrapId = Extract<
  H6TrapId,
  "flaky-looking-test" | "misleading-error-message" | "wrong-layer-fix"
>;
export type SecondTrapId = Exclude<H6TrapId, FirstTrapId>;

export const H6_TASK_REQUIREMENTS: Readonly<Record<H6TrapId, string>> = Object.freeze({
  "flaky-looking-test":
    "Ensure every queue write commits synchronously before its promise resolves, with count, snapshot, and insertion order immediately consistent.",
  "misleading-error-message":
    "Keep each validation failure's machine-readable error code paired with the exact failing field path while valid records load successfully.",
  "wrong-layer-fix":
    "Enforce normalization and validation inside the service boundary: reject invalid raw records without state changes and accept valid records consistently for every caller.",
  "hidden-invariant":
    "Preserve immutable update semantics: no-op updates retain object identity, value changes replace both root and nested branch, and sequential updates keep prior snapshots unchanged.",
  "stale-cache-illusion":
    "Compute the documented formula independently for each input, cache by input, and return the same result on a repeated lookup.",
  "config-shadowing":
    "Revise the canonical default configuration so runtime loads the new values from that source; do not edit an unused shadow copy.",
});

export interface TrapFixtureContext {
  pfx: string;
  taskShape: number;
  targetFile: string;
  commonFiles: SyntheticFile[];
}

export interface TrapFixtureResult {
  files: SyntheticFile[];
  badPatch: StrategyPatch;
  goodPatch: StrategyPatch;
  noTrapFiles: SyntheticFile[];
  symbol: string;
  file: string;
  pattern: string;
  actionType: string;
}
