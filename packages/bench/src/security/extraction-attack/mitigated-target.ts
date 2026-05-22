/**
 * Mitigation-aware target wrapper for the ADAM extraction attack harness.
 *
 * Wraps a raw `ExtractionAttackTarget` and enforces:
 * 1. Cross-namespace query budget (mirrors `CrossNamespaceBudget` from core)
 * 2. Namespace ACL (carries forward from `createSyntheticTarget`)
 *
 * When the budget is exceeded, the wrapper returns empty hits instead of
 * forwarding the query — simulating the real recall-path denial. This lets
 * the harness re-measure ASR with mitigations active and compare against
 * the unmitigated baseline.
 */

import type { AttackRecallOptions, AttackRetrievalHit, ExtractionAttackTarget } from "./types.js";

export interface MitigatedTargetConfig {
  /** Inner (unmitigated) target to wrap. */
  target: ExtractionAttackTarget;
  /**
   * Maximum cross-namespace queries per `budgetWindowMs` window.
   * Queries beyond this limit return empty hits.
   */
  budgetHardLimit: number;
  /**
   * Rolling window in ms for the budget counter. Defaults to 60_000.
   */
  budgetWindowMs?: number;
  /**
   * The principal's "home" namespace. Queries targeting a different
   * namespace count against the budget; same-namespace queries are free.
   */
  principalNamespace: string;
}

interface TimestampEntry {
  ts: number;
}

/**
 * Creates a mitigation-aware wrapper around a raw target.
 *
 * The wrapper tracks cross-namespace queries in a sliding window and
 * returns empty hits when the budget is exceeded. Same-namespace queries
 * pass through without counting.
 */
export function createMitigatedTarget(
  config: MitigatedTargetConfig,
): ExtractionAttackTarget {
  const {
    target,
    budgetHardLimit,
    budgetWindowMs = 60_000,
    principalNamespace,
  } = config;

  // Validate budget parameters to prevent silent enforcement skew from
  // NaN, negative, or non-integer inputs (Codex P2 review feedback).
  if (!Number.isFinite(budgetHardLimit) || budgetHardLimit < 1 || !Number.isInteger(budgetHardLimit)) {
    throw new Error(
      `createMitigatedTarget: budgetHardLimit must be a positive integer, got ${budgetHardLimit}`,
    );
  }
  if (!Number.isFinite(budgetWindowMs) || budgetWindowMs <= 0) {
    throw new Error(
      `createMitigatedTarget: budgetWindowMs must be a positive finite number, got ${budgetWindowMs}`,
    );
  }
  if (typeof principalNamespace !== "string" || principalNamespace.length === 0) {
    throw new Error(
      "createMitigatedTarget: principalNamespace must be a non-empty string",
    );
  }

  const timestamps: TimestampEntry[] = [];

  function recordAndCheck(now: number): boolean {
    const cutoff = now - budgetWindowMs;
    while (timestamps.length > 0 && timestamps[0].ts <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= budgetHardLimit) {
      return false;
    }
    timestamps.push({ ts: now });
    return true;
  }

  return {
    async recall(
      query: string,
      options?: AttackRecallOptions,
    ): Promise<AttackRetrievalHit[]> {
      const queryNs = options?.namespace;
      // Fail-closed: queries without an explicit namespace are treated as
      // cross-namespace (count against the budget), matching the core
      // CrossNamespaceBudget behavior for missing namespaces.
      const isSameNamespace =
        typeof queryNs === "string" &&
        queryNs.length > 0 &&
        queryNs === principalNamespace;

      if (!isSameNamespace) {
        const allowed = recordAndCheck(Date.now());
        if (!allowed) {
          return [];
        }
      }

      return target.recall(query, options);
    },

    listEntities: target.listEntities
      ? async () => target.listEntities!()
      : undefined,

  };
}
