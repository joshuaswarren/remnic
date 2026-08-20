/**
 * Pure vault-publish outcome aggregator (issue #1985).
 *
 * `summarizeVaultPublish` folds per-file publish results into the status
 * shape the publish report and the dry-run print: sorted per-file outcomes
 * plus zero-filled counts. It performs no I/O and never mutates its input.
 *
 * Fail-closed contract: an unrecognized outcome is refused, never coerced
 * into `skipped` or `error`, and `skipped`/`error` must carry a non-blank
 * reason so every un-actionable row says why.
 */

export const VAULT_PUBLISH_OUTCOMES = ["updated", "unchanged", "skipped", "error"] as const;
export type VaultPublishOutcome = (typeof VAULT_PUBLISH_OUTCOMES)[number];

export interface VaultPublishResult {
  /** Vault-relative note path. */
  path: string;
  outcome: string;
  /** Required for skipped and error, e.g. "no_marker". */
  reason?: string;
}

export interface VaultPublishStatus {
  results: Array<{ path: string; outcome: VaultPublishOutcome; reason?: string }>;
  counts: Record<VaultPublishOutcome, number>;
  /** True when at least one entry is an error. */
  hasError: boolean;
}

interface ValidatedEntry {
  path: string;
  outcome: VaultPublishOutcome;
  reason?: string;
}

/** Total order: path asc, then outcome in allow-list order, then reason. */
function compareEntries(a: ValidatedEntry, b: ValidatedEntry): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  const rankA = VAULT_PUBLISH_OUTCOMES.indexOf(a.outcome);
  const rankB = VAULT_PUBLISH_OUTCOMES.indexOf(b.outcome);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  const reasonA = a.reason ?? "";
  const reasonB = b.reason ?? "";
  if (reasonA !== reasonB) return reasonA < reasonB ? -1 : 1;
  return 0;
}

export function summarizeVaultPublish(results: readonly VaultPublishResult[]): VaultPublishStatus {
  if (!Array.isArray(results)) {
    throw new TypeError(`summarizeVaultPublish expects an array of results (got ${typeof results})`);
  }

  const entries: ValidatedEntry[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(`vault publish result entries must be objects (got ${typeof entry})`);
    }
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      throw new RangeError(`vault publish result requires a non-blank path (got ${JSON.stringify(entry.path)})`);
    }
    const outcome = VAULT_PUBLISH_OUTCOMES.find((candidate) => candidate === entry.outcome);
    if (outcome === undefined) {
      throw new TypeError(
        `unknown vault publish outcome ${JSON.stringify(entry.outcome)}; expected one of: ${VAULT_PUBLISH_OUTCOMES.join(", ")}`,
      );
    }
    if (outcome === "skipped" || outcome === "error") {
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        throw new TypeError(
          `vault publish outcome "${outcome}" requires a non-blank reason, e.g. "no_marker" (got ${JSON.stringify(entry.reason)})`,
        );
      }
      entries.push({ path: entry.path, outcome, reason: entry.reason });
    } else {
      if (entry.reason !== undefined) {
        throw new TypeError(
          `vault publish outcome "${outcome}" must not carry a reason (got ${JSON.stringify(entry.reason)})`,
        );
      }
      entries.push({ path: entry.path, outcome });
    }
  }

  const sorted = [...entries].sort(compareEntries);

  const counts = {} as Record<VaultPublishOutcome, number>;
  for (const outcome of VAULT_PUBLISH_OUTCOMES) counts[outcome] = 0;
  for (const entry of sorted) counts[entry.outcome] += 1;

  return {
    results: sorted,
    counts,
    hasError: counts.error > 0,
  };
}
