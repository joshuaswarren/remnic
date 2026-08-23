import { stateViewKey } from "./recall-state-view.js";
/**
 * State-view anchor admission (#2859).
 *
 * Shared namespace-qualified admission tracker for the recall safety
 * filter (QMD/embedding/cold paths) and the recent-scan path. A deferred
 * superseded row is admitted only when an in-set successor anchors it —
 * through the row's own `supersededBy` or through an admitted successor's
 * `supersedes` back-pointer. Identities are `namespace\0id`, so identical
 * ids across namespace fanout never cross-anchor.
 */
import { shouldFilterSupersededFromRecall } from "./temporal-supersession.js";
import type { MemoryFile } from "./types.js";

export interface StateViewAnchorFrontmatter {
  id?: string;
  supersedes?: string;
  supersededBy?: string;
}

/**
 * #2859 — pair reconciliation and packet-counting caps apply only WITHOUT
 * a historical pin: under asOf the validity filter legitimately orphans
 * predecessors (see annotateStateView's asOf mode).
 */
export function stateViewPacketActive(stateViewActive: boolean | undefined, asOfMs: number | undefined): boolean {
  return stateViewActive === true && !(typeof asOfMs === "number" && Number.isFinite(asOfMs));
}

export class StateViewAnchorTracker {
  private readonly admitted = new Set<string>();
  private readonly supersedesAnchors = new Set<string>();

  has(namespace: string | undefined, frontmatter: StateViewAnchorFrontmatter): boolean {
    const id = frontmatter.id;
    return typeof id === "string" && id.length > 0 ? this.admitted.has(stateViewKey(namespace, id)) : false;
  }

  /**
   * Register a row as admitted (a survivor of every gate, or a deferred
   * row whose successor anchored it). The row's `supersedes` back-pointer
   * then anchors its own predecessor.
   */
  admit(namespace: string | undefined, frontmatter: StateViewAnchorFrontmatter): void {
    const id = frontmatter.id;
    if (typeof id !== "string" || id.length === 0) return;
    this.admitted.add(stateViewKey(namespace, id));
    if (frontmatter.supersedes) {
      this.supersedesAnchors.add(stateViewKey(namespace, frontmatter.supersedes));
    }
  }

  /** True when an admitted successor anchors this superseded row. */
  anchored(namespace: string | undefined, frontmatter: StateViewAnchorFrontmatter): boolean {
    const id = frontmatter.id;
    if (typeof id !== "string" || id.length === 0) return false;
    const successorId = frontmatter.supersededBy;
    return (
      (typeof successorId === "string" && this.admitted.has(stateViewKey(namespace, successorId))) ||
      this.supersedesAnchors.has(stateViewKey(namespace, id))
    );
  }
}

export interface StateViewRecentAdmissionDeps {
  namespaceOf: (path: string) => string;
  isExcluded: (path: string) => boolean;
  supersessionOptions: { enabled: boolean; includeInRecall: boolean };
}

/**
 * #2859 — recent-scan admission: seed the tracker with every memory that
 * survives the supersession gate, then admit superseded rows anchored by
 * an in-set successor (fixpoint — an admitted link anchors the next).
 */
export function admitStateViewRecentMemories(
  memories: readonly MemoryFile[],
  deps: StateViewRecentAdmissionDeps
): StateViewAnchorTracker {
  const tracker = new StateViewAnchorTracker();
  for (const m of memories) {
    if (deps.isExcluded(m.path)) continue;
    if (m.frontmatter.status === "superseded") continue;
    if (shouldFilterSupersededFromRecall(m.frontmatter, deps.supersessionOptions)) continue;
    tracker.admit(deps.namespaceOf(m.path), m.frontmatter);
  }
  for (let progress = true; progress; ) {
    progress = false;
    for (const m of memories) {
      const namespace = deps.namespaceOf(m.path);
      if (tracker.has(namespace, m.frontmatter)) continue;
      if (deps.isExcluded(m.path)) continue;
      if (m.frontmatter.status !== "superseded") continue;
      if (!shouldFilterSupersededFromRecall(m.frontmatter, deps.supersessionOptions)) continue;
      if (tracker.anchored(namespace, m.frontmatter)) {
        tracker.admit(namespace, m.frontmatter);
        progress = true;
      }
    }
  }
  return tracker;
}
