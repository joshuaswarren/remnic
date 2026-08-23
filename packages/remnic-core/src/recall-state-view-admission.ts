/**
 * Recall-internal state-view admission (issue #1952).
 *
 * Flag resolution, recent-scan successor-anchor admission, and the X-ray
 * inject-seam annotation live here so recall-internal.ts stays under its
 * ratchet ceiling. Callers keep one-line sites.
 */

import { isGenericRecallExcludedPath, type GenericRecallPathPolicy } from "./orchestration/generic-recall-paths.js";
import { isChangeOrientedQuery, type StateViewResult } from "./recall-state-view.js";
import { applyRecallStateViews } from "./recall-state-view-wire.js";
import { shouldFilterSupersededFromRecall } from "./temporal-supersession.js";
import type { MemoryFile } from "./types.js";

/** Config flag OR per-call override, gated on change intent; computed once for all branches. */
export function resolveRecallStateViewActive(
  options: { stateView?: boolean },
  config: { recallStateViews?: boolean },
  query: string,
): boolean {
  return (options.stateView === true || config.recallStateViews === true) && isChangeOrientedQuery(query);
}

/**
 * Superseded-status filtering delegates to shouldFilterSupersededFromRecall
 * so recent-scan and the QMD safety filter share semantics (kill switch,
 * audit mode, PR #402).
 *
 * #1952: an active state view admits a superseded memory whose successor
 * ALSO survives this admission filter — a successor excluded by status or
 * path can never anchor (mirrors the filterSearchResultsByRecallSafety
 * fixpoint). Anchors grow through admitted chain links, so iterate to a
 * fixpoint.
 *
 * PR #713: when `as_of` is active, pass superseded candidates through here
 * — boostSearchResults's `[valid_at, invalid_at)` evaluation is the
 * authoritative historical gate. Other non-active statuses stay excluded.
 */
export function filterRecentScanMemoriesForStateView(
  memories: readonly MemoryFile[],
  config: GenericRecallPathPolicy,
  supersessionOptions: { enabled: boolean; includeInRecall: boolean },
  stateViewActive: boolean,
  asOfMs: number | undefined,
): MemoryFile[] {
  const asOfActive = typeof asOfMs === "number" && Number.isFinite(asOfMs);
  let stateViewAdmittedIds: Set<string> | null = null;
  if (stateViewActive && !asOfActive) {
    stateViewAdmittedIds = new Set(
      memories
        .filter(
          (m) =>
            !isGenericRecallExcludedPath(m.path, config) &&
            m.frontmatter.status !== "superseded" &&
            !shouldFilterSupersededFromRecall(m.frontmatter, supersessionOptions),
        )
        .map((m) => m.frontmatter.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    for (let progress = true; progress; ) {
      progress = false;
      for (const m of memories) {
        const id = m.frontmatter.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (stateViewAdmittedIds.has(id)) continue;
        if (isGenericRecallExcludedPath(m.path, config)) continue;
        if (m.frontmatter.status !== "superseded") continue;
        if (!shouldFilterSupersededFromRecall(m.frontmatter, supersessionOptions)) continue;
        if (stateViewAdmittedIds.has(m.frontmatter.supersededBy ?? "")) {
          stateViewAdmittedIds.add(id);
          progress = true;
        }
      }
    }
  }
  return memories.filter((m) => {
    if (isGenericRecallExcludedPath(m.path, config)) return false;
    const status = m.frontmatter.status;
    if (!status || status === "active") return true;
    if (status === "superseded") {
      if (asOfActive) return true;
      const id = m.frontmatter.id;
      if (
        stateViewAdmittedIds !== null &&
        typeof id === "string" &&
        stateViewAdmittedIds.has(id)
      ) {
        return true;
      }
      // Include superseded memory only if the canonical gate says
      // NOT to filter it (kill switch off or audit mode on).
      return !shouldFilterSupersededFromRecall(m.frontmatter, supersessionOptions);
    }
    // Other non-active statuses (archived, retired, etc.) are
    // excluded from the recent-scan path by default.
    return false;
  });
}

/** Label the captured X-ray branch through the same inject-seam annotator. */
export function indexStateViewAnnotatedResults<T extends StateViewResult & { path: string; namespace?: string }>(
  results: T[],
  query: string,
  config: unknown,
  stateViewActive?: boolean,
  asOfMs?: number,
): Map<string, T> {
  return new Map(
    applyRecallStateViews(results, query, config, stateViewActive, asOfMs).map((xr) => [
      `${xr.namespace ?? ""}\0${xr.path}`,
      xr,
    ]),
  );
}
