// Type declarations for the plain-JS AMB BEAM comparator runtime
// (compare-beam-result.mjs). Hand-authored so the test call sites type-check.

export interface BeamResult {
  dataset?: unknown;
  split?: unknown;
  mode?: unknown;
  answer_llm?: unknown;
  judge_llm?: unknown;
  accuracy?: unknown;
  total_queries?: unknown;
  results?: unknown;
  [key: string]: unknown;
}

export interface BeamRow {
  dataset?: unknown;
  split?: unknown;
  mode?: unknown;
  accuracy?: unknown;
  total_queries?: unknown;
  [key: string]: unknown;
}

export interface BeamComparisonReport {
  split: string;
  local: {
    run_name: unknown;
    memory_provider: unknown;
    mode: unknown;
    comparable_mode: string;
    accuracy: number;
    total_queries: unknown;
    answer_llm: unknown;
    judge_llm: unknown;
  };
  current_public_sota: {
    run_name: unknown;
    memory: unknown;
    mode: unknown;
    accuracy: number;
    total_queries: unknown;
    path: unknown;
  };
  delta: number;
  is_sota: boolean;
}

export declare function readResult(file: string): BeamResult;

export declare function normalizeAccuracy(result: BeamResult): number;

export declare function fetchPublicBeamRows(): Promise<BeamRow[]>;

export declare function normalizeBeamMode(mode: unknown): string;

export declare function assertPublicComparableBeamResult(
  result: BeamResult,
): { split: string; mode: string };

export declare function findSplitSota(
  rows: BeamRow[],
  split: string,
  mode?: string,
): BeamRow;

export declare function assertFullComparableRun(
  result: BeamResult,
  publicSota: BeamRow,
): void;

export declare function compareBeamResult(file: string): Promise<BeamComparisonReport>;
