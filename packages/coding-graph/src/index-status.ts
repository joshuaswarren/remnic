/**
 * Index staleness reporting (issue #1553 done-when: "a deliberately stale
 * index with `autoIndex: "manual"` reports its staleness via `index_status`
 * rather than pretending freshness").
 *
 * Reports:
 *   - `lastIndexedHead` — the HEAD at the last successful reindex.
 *   - `currentHead` — the current repo HEAD (null when git unavailable).
 *   - `dirty` — true when `lastIndexedHead !== currentHead` (the index
 *     is behind the repo and needs a reindex).
 *   - `mode` — "fresh" | "stale" | "empty" | "git_unavailable".
 *
 * Never throws — a git failure degrades to `mode: "git_unavailable"`
 * so callers (remnic doctor / xray) can surface it without crashing.
 */
import type { CodingGitInvoker } from "./git-invoker.js";
import type { GraphStore } from "./graph-store.js";
import { META_KEY_LAST_HEAD } from "./reindex.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type IndexStatusMode =
  | "fresh" // lastIndexedHead === currentHead
  | "stale" // lastIndexedHead !== currentHead
  | "empty" // no prior index (lastIndexedHead === null)
  | "git_unavailable"; // git failed

export interface IndexStatus {
  readonly lastIndexedHead: string | null;
  readonly currentHead: string | null;
  readonly dirty: boolean;
  readonly mode: IndexStatusMode;
  readonly fileCount: number;
  readonly nodeCount: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Report the current index status. Pure over the store + git facts — no
 * side effects, never throws.
 */
export function getIndexStatus(
  store: GraphStore,
  git: CodingGitInvoker,
  repoRoot: string,
): IndexStatus {
  const lastIndexedHead = store.readMeta(META_KEY_LAST_HEAD);
  const headResult = git.revParseHead(repoRoot);

  // Gather graph stats for context.
  const stats = store.schemaStats();
  const fileCount = stats.ok ? stats.stats.files : 0;
  const nodeCount = stats.ok ? stats.stats.nodes : 0;

  if (!headResult.ok) {
    return {
      lastIndexedHead,
      currentHead: null,
      dirty: true,
      mode: "git_unavailable",
      fileCount,
      nodeCount,
    };
  }

  const currentHead = headResult.head;

  if (lastIndexedHead === null) {
    return {
      lastIndexedHead: null,
      currentHead,
      dirty: currentHead !== null,
      mode: "empty",
      fileCount,
      nodeCount,
    };
  }

  if (currentHead === null) {
    // Repo currently has no commits (unborn HEAD / reset) but the index
    // still has a last_indexed_head — the index cannot match a repo
    // with no commits, so it is stale, not fresh. Reporting "fresh"
    // here would let callers act on a graph that no longer reflects
    // the repo (cursor Bugbot: 'Index status false fresh').
    return {
      lastIndexedHead,
      currentHead: null,
      dirty: true,
      mode: "stale",
      fileCount,
      nodeCount,
    };
  }

  const dirty = lastIndexedHead !== currentHead;
  return {
    lastIndexedHead,
    currentHead,
    dirty,
    mode: dirty ? "stale" : "fresh",
    fileCount,
    nodeCount,
  };
}
