/**
 * Canary adapter for exploit-detection runs.
 *
 * A canary adapter never actually solves a benchmark task. It returns a
 * deterministic, deliberately-wrong response to every query so that the
 * exploit-audit workflow can measure how much score a benchmark assigns to
 * a do-nothing system. If the canary scores above the configured floor
 * (default `0.1`) on any benchmark, the benchmark is flagged as exploitable
 * and demoted until fixed.
 *
 * This adapter must never be used in production bench runs; it exists only
 * for the `bench-exploit-audit` CI workflow.
 */

import process from "node:process";
import type {
  BenchMemoryAdapter,
  MemoryStats,
  Message,
  SearchResult,
} from "../adapters/types.js";

/** The fixed reply the canary returns for every `recall`. */
export const CANARY_FIXED_RECALL = "__remnic_canary_response__";

/** The score floor the canary must NOT exceed for any benchmark. */
export const CANARY_SCORE_FLOOR = 0.1;

/**
 * Accept a finite canary floor >= 0. Reject NaN, infinities, negatives,
 * and non-numbers. Callers treat absence separately so a malformed
 * present value is never rewritten to the default.
 */
export function parseCanaryFloor(value: unknown, label = "canary floor"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

/**
 * Effective canary floor for this process: a validated
 * `REMNIC_BENCH_CANARY_FLOOR` override, else the canonical default.
 * An explicitly empty override is invalid, not absent.
 */
export function resolveCanaryFloorFromEnv(
  raw: string | undefined = process.env.REMNIC_BENCH_CANARY_FLOOR,
): number {
  if (raw === undefined) {
    return CANARY_SCORE_FLOOR;
  }
  if (raw === "") {
    throw new Error(`Invalid REMNIC_BENCH_CANARY_FLOOR: ${raw}`);
  }
  try {
    return parseCanaryFloor(Number(raw), "REMNIC_BENCH_CANARY_FLOOR");
  } catch {
    throw new Error(`Invalid REMNIC_BENCH_CANARY_FLOOR: ${raw}`);
  }
}

/**
 * Producer/audit precedence: a present preset must be a valid floor;
 * otherwise fall through to the env parser (absent env → 0.1).
 */
export function resolveEffectiveCanaryFloor(
  preset: unknown = undefined,
  envRaw: string | undefined = process.env.REMNIC_BENCH_CANARY_FLOOR,
): number {
  if (preset !== undefined) {
    return parseCanaryFloor(preset);
  }
  return resolveCanaryFloorFromEnv(envRaw);
}

export interface CanaryAdapterOptions {
  /**
   * Override the response string used by `recall`. Useful for running two
   * canary variants side-by-side (e.g. empty string vs fixed string).
   */
  response?: string;
  /**
   * If true, `search` returns an empty array instead of a single fake hit.
   * Some benchmarks rely on the retrieval surface; keeping the default
   * "one fake hit" covers retrieval-style scorers too.
   */
  emptySearch?: boolean;
}

export function createCanaryAdapter(
  options: CanaryAdapterOptions = {},
): BenchMemoryAdapter {
  const response = options.response ?? CANARY_FIXED_RECALL;
  const emptySearch = options.emptySearch ?? false;

  return {
    async store(_sessionId: string, _messages: Message[]): Promise<void> {
      // Intentionally a no-op. A canary never persists anything.
    },

    async recall(
      _sessionId: string,
      _query: string,
      _budgetChars?: number,
    ): Promise<string> {
      return response;
    },

    async search(
      _query: string,
      _limit: number,
      _sessionId?: string,
    ): Promise<SearchResult[]> {
      if (emptySearch) {
        return [];
      }
      // Single decoy hit so benchmarks that expect at least one result
      // still exercise their scoring pipeline without leaking anything
      // useful.
      return [
        {
          turnIndex: 0,
          role: "assistant",
          snippet: response,
          sessionId: "__canary__",
          score: 0,
        },
      ];
    },

    async reset(_sessionId?: string): Promise<void> {
      // No state to clear.
    },

    async getStats(_sessionId?: string): Promise<MemoryStats> {
      return {
        totalMessages: 0,
        totalSummaryNodes: 0,
        maxDepth: 0,
      };
    },

    async destroy(): Promise<void> {
      // No resources to release.
    },
  };
}

export interface CanaryFloorCheck {
  benchmark: string;
  score: number;
  floor: number;
  passed: boolean;
}

/**
 * Compare a canary score against the configured floor. Returns a structured
 * result rather than throwing so callers can aggregate failures across an
 * entire benchmark suite before reporting.
 */
export function assertCanaryUnderFloor(
  benchmark: string,
  score: number,
  floor: number = CANARY_SCORE_FLOOR,
): CanaryFloorCheck {
  const validatedFloor = parseCanaryFloor(floor);
  if (!Number.isFinite(score)) {
    return { benchmark, score, floor: validatedFloor, passed: false };
  }
  return {
    benchmark,
    score,
    floor: validatedFloor,
    passed: score <= validatedFloor,
  };
}
