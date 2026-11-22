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

/**
 * Config flag OR per-call override, gated on change intent; computed once
 * for all branches.
 *
 * #2893: `query` MUST be the ORIGINAL prompt, not the cron-normalized
 * retrievalQuery — buildRecallQueryPolicy truncates standard prompts at
 * maxChars and strips stop-words ("when", "before", "after") from
 * instruction-heavy ones, either of which can erase the change-intent
 * signal before retrieval. Only the resulting boolean flows downstream;
 * retrieval itself keeps using the normalized query.
 */
export function resolveRecallStateViewActive(
  options: { stateView?: boolean },
  config: { recallStateViews?: boolean },
  query: string,
): boolean {
  return (options.stateView === true || config.recallStateViews === true) && isChangeOrientedQuery(query);
}

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
      return !shouldFilterSupersededFromRecall(m.frontmatter, supersessionOptions);
    }
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
