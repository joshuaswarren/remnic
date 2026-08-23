import { isChangeOrientedQuery, stateViewKey } from "./recall-state-view.js";
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

/**
 * #1952/#2859 — config flag OR per-call override, gated on change intent.
 * Packet semantics are off under a historical asOf pin (see stateViewPacketActive).
 */
export function resolveRecallStateViewFlags(
  optionFlag: boolean | undefined,
  configFlag: boolean | undefined,
  retrievalQuery: string,
  asOfMs: number | undefined,
): { stateViewActive: boolean; stateViewPacketActive: boolean } {
  const stateViewActive =
    (optionFlag === true || configFlag === true) && isChangeOrientedQuery(retrievalQuery);
  return { stateViewActive, stateViewPacketActive: stateViewPacketActive(stateViewActive, asOfMs) };
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

export interface RecentScanMemoryFilterDeps extends StateViewRecentAdmissionDeps {
  stateViewActive: boolean;
  asOfMs: number | undefined;
}

/**
 * Recent-scan admission for the fallback path.
 *
 * Superseded-status filtering delegates to
 * shouldFilterSupersededFromRecall so recent-scan and the QMD
 * safety filter share semantics (kill switch, audit mode, PR #402).
 * #1952: an active state view admits a superseded memory whose
 * successor ALSO survives this admission filter (fixpoint below).
 * PR #713: when `as_of` is active, pass superseded candidates
 * through here — boostSearchResults's `[valid_at, invalid_at)`
 * evaluation is the authoritative historical gate. Other
 * non-active statuses stay excluded.
 * #2859: namespace-qualified anchors with the supersedes
 * back-pointer — mirrors the safety-filter fixpoint.
 */
export function filterRecentScanMemories(
  memories: readonly MemoryFile[],
  deps: RecentScanMemoryFilterDeps,
): MemoryFile[] {
  const asOfActive = typeof deps.asOfMs === "number" && Number.isFinite(deps.asOfMs);
  const stateViewAnchors =
    deps.stateViewActive && !asOfActive ? admitStateViewRecentMemories(memories, deps) : null;
  return memories.filter((m) => {
    if (deps.isExcluded(m.path)) return false;
    const status = m.frontmatter.status;
    if (!status || status === "active") return true;
    if (status === "superseded") {
      if (asOfActive) return true;
      if (stateViewAnchors?.has(deps.namespaceOf(m.path), m.frontmatter)) {
        return true;
      }
      // Include superseded memory only if the canonical gate says
      // NOT to filter it (kill switch off or audit mode on).
      return !shouldFilterSupersededFromRecall(m.frontmatter, deps.supersessionOptions);
    }
    // Other non-active statuses (archived, retired, etc.) are
    // excluded from the recent-scan path by default.
    return false;
  });
}
