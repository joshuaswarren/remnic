/**
 * FILE_CHANGES_WITH co-change edge mining (issue #1553).
 *
 * Mines co-change relationships from `git log --name-only` over a bounded
 * window (default 500 commits). An edge between two files is written when:
 *   - support (co-change count) ≥ `minSupport`
 *   - confidence (co-change / total changes of the less-changed file) ≥
 *     `minConfidence`
 *
 * Deterministic given the same history — re-running on unchanged history
 * is idempotent (same edges, same confidence).
 *
 * Co-change edges are stored in a dedicated `co_changes` table (file-level,
 * not symbol-level — the existing `edges` table is between symbol nodes).
 * The table is additive to schema v1 (CREATE TABLE IF NOT EXISTS — same
 * pattern as `node_attributes` in PR2).
 */
import type { CodingGitInvoker, GitFailure, LogFilesEntry } from "./git-invoker.js";
import type { GraphStore } from "./graph-store.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/** A mined co-change edge between two files. */
export interface CoChangeEdge {
  readonly fileA: string;
  readonly fileB: string;
  /** Number of commits where both files changed together. */
  readonly support: number;
  /** Confidence: support / min(totalChangesA, totalChangesB). */
  readonly confidence: number;
}

/** Result of co-change mining. */
export type MineCoChangesResult =
  | { readonly ok: true; readonly edges: readonly CoChangeEdge[] }
  | GitFailure;

/** Configuration for co-change mining. */
export interface CoChangeConfig {
  /** Maximum commits to scan (default 500). */
  readonly maxCommits: number;
  /** Minimum co-change count to write an edge (default 3). */
  readonly minSupport: number;
  /** Minimum confidence to write an edge (default 0.3). */
  readonly minConfidence: number;
}

export const DEFAULT_CO_CHANGE_CONFIG: CoChangeConfig = {
  maxCommits: 500,
  minSupport: 3,
  minConfidence: 0.3,
};

// ──────────────────────────────────────────────────────────────────────────
// Pure mining logic — unit-testable without git or SQLite
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute co-change edges from a list of commit→files entries.
 *
 * Algorithm:
 *   1. Count total changes per file (how many commits touched it).
 *   2. For each unordered file pair, count how many commits changed both.
 *   3. Confidence = coChangeCount / min(totalA, totalB).
 *   4. Keep edges where support ≥ minSupport AND confidence ≥ minConfidence.
 *
 * Deterministic: the same input always produces the same output, sorted
 * by (fileA, fileB) for byte-stability.
 *
 * Half-open time windows (rule 35): each commit is a discrete point; a
 * pair is "co-changed" in a commit iff both files are in that commit's
 * file list. No off-by-one — a file that appears once in a commit counts
 * once (deduped by the git-invoker's parser).
 */
export function mineCoChangeEdges(
  entries: readonly LogFilesEntry[],
  config: CoChangeConfig = DEFAULT_CO_CHANGE_CONFIG,
): CoChangeEdge[] {
  // Step 1: total changes per file.
  const totalChanges = new Map<string, number>();
  for (const entry of entries) {
    for (const file of entry.files) {
      totalChanges.set(file, (totalChanges.get(file) ?? 0) + 1);
    }
  }

  // Step 2: co-change counts per unordered pair.
  // Key: "fileA\x00fileB" where fileA < fileB lexicographically.
  const coChangeCounts = new Map<string, { a: string; b: string; count: number }>();
  for (const entry of entries) {
    const files = entry.files;
    // Only consider pairs within the same commit.
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const [a, b] = files[i]! < files[j]! ? [files[i]!, files[j]!] : [files[j]!, files[i]!];
        const key = `${a}\u0000${b}`;
        const existing = coChangeCounts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          coChangeCounts.set(key, { a, b, count: 1 });
        }
      }
    }
  }

  // Step 3+4: filter by support + confidence thresholds.
  const edges: CoChangeEdge[] = [];
  for (const { a, b, count } of coChangeCounts.values()) {
    if (count < config.minSupport) continue;
    const totalA = totalChanges.get(a) ?? 0;
    const totalB = totalChanges.get(b) ?? 0;
    const minTotal = Math.min(totalA, totalB);
    if (minTotal === 0) continue;
    const confidence = count / minTotal;
    if (confidence < config.minConfidence) continue;
    edges.push({ fileA: a, fileB: b, support: count, confidence });
  }

  // Sort for byte-stability (deterministic output).
  edges.sort((x, y) => {
    const cmp = x.fileA.localeCompare(y.fileA);
    if (cmp !== 0) return cmp;
    return x.fileB.localeCompare(y.fileB);
  });

  return edges;
}

// ──────────────────────────────────────────────────────────────────────────
// Executor — fetch git log, mine, persist to store
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mine co-change edges from git history and persist them to the store's
 * `co_changes` table. Idempotent: re-running on unchanged history produces
 * the same edges (the table is cleared + repopulated each run, so stale
 * edges from history changes are pruned automatically).
 */
export async function mineAndStoreCoChanges(options: {
  readonly store: GraphStore;
  readonly git: CodingGitInvoker;
  readonly repoRoot: string;
  readonly config?: CoChangeConfig;
}): Promise<MineCoChangesResult> {
  const { store, git, repoRoot } = options;
  const config = options.config ?? DEFAULT_CO_CHANGE_CONFIG;

  const logResult = git.logFiles(repoRoot, config.maxCommits);
  if (!logResult.ok) return logResult;

  const edges = mineCoChangeEdges(logResult.entries, config);

  // Persist: clear + repopulate in one transaction.
  await store.upsertCoChanges(edges);

  return { ok: true, edges };
}
