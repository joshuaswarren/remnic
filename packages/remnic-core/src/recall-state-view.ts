/**
 * Recall state views (issue #1952).
 *
 * Config key: `recallStateViews` (default false). When false, annotateStateView
 * is identity: same array reference, no `stateLabel`. config.ts is at its
 * fileSizeGrandfather ceiling, so parseConfig wiring waits for a later PR.
 * Call `parseRecallStateViews` at the recall seam when that lands.
 *
 * Change-intent morphology lives here (do not grow intent.ts). A superseded
 * memory is admitted only when its successor is also in the candidate set.
 */
import { coerceBooleanLike } from "./connectors/coerce.js";

export type StateLabel = "current" | "historical" | "transition";

export interface StateViewChain {
  predecessorId: string;
  successorId: string;
  supersededAt?: string;
}

export interface StateViewResult {
  id?: string;
  docid?: string;
  status?: string;
  supersededBy?: string;
  supersededAt?: string;
  stateLabel?: StateLabel;
}

export const DEFAULT_RECALL_STATE_VIEWS = false;

const CHANGE_WORDS = ["before", "after", "switch", "switches", "switched", "switching", "change", "changes", "changed", "changing"];

export function parseRecallStateViews(raw: unknown): boolean {
  return coerceBooleanLike(raw, "recallStateViews") === true;
}

export function isChangeOrientedQuery(query: string): boolean {
  const lower = query.toLowerCase();
  if (lower.includes("when did") || lower.includes("used to")) return true;
  return CHANGE_WORDS.some((word) => {
    const idx = lower.indexOf(word);
    if (idx < 0) return false;
    const before = idx === 0 || !/[a-z0-9]/.test(lower[idx - 1] ?? "");
    const afterIdx = idx + word.length;
    const after = afterIdx >= lower.length || !/[a-z0-9]/.test(lower[afterIdx] ?? "");
    return before && after;
  });
}

export function shouldWidenSuperseded(
  successorId: string | undefined,
  candidateIds: ReadonlySet<string>,
): boolean {
  return typeof successorId === "string" && successorId.length > 0 && candidateIds.has(successorId);
}

export function formatSupersededPrefix(date: string, successorId: string): string {
  return `[superseded ${date} by ${successorId}]`;
}

export function resultStateViewId(result: StateViewResult): string {
  return result.id ?? result.docid ?? "";
}

function buildSuccessorMap(results: readonly StateViewResult[], chains: readonly StateViewChain[]): Map<string, string> {
  const byPred = new Map<string, string>();
  for (const chain of chains) {
    if (chain.predecessorId && chain.successorId) {
      byPred.set(chain.predecessorId, chain.successorId);
    }
  }
  for (const result of results) {
    const id = resultStateViewId(result);
    if (id && result.supersededBy) byPred.set(id, result.supersededBy);
  }
  return byPred;
}

function labelFor(
  id: string,
  result: StateViewResult,
  byPred: Map<string, string>,
  admittedIds: ReadonlySet<string>,
): StateLabel {
  const successorId = result.supersededBy ?? byPred.get(id);
  const isPred = shouldWidenSuperseded(successorId, admittedIds);
  let isSucc = false;
  for (const [predId, succId] of byPred) {
    if (succId === id && admittedIds.has(predId)) {
      isSucc = true;
      break;
    }
  }
  if (isPred && isSucc) return "transition";
  if (isPred) return "historical";
  if (isSucc) return "current";
  return result.status === "superseded" ? "historical" : "current";
}

export function annotateStateView<T extends StateViewResult>(
  results: T[],
  query: string,
  chains: readonly StateViewChain[],
  options: { enabled?: boolean } = {},
): T[] {
  const enabled = options.enabled === true;
  if (!enabled || !isChangeOrientedQuery(query)) return results;

  const byPred = buildSuccessorMap(results, chains);
  const candidateIds = new Set<string>();
  for (const result of results) {
    const id = resultStateViewId(result);
    if (id) candidateIds.add(id);
  }

  const admitted: T[] = [];
  for (const result of results) {
    const id = resultStateViewId(result);
    const successorId = result.supersededBy ?? byPred.get(id);
    const superseded = result.status === "superseded" || Boolean(result.supersededBy) || byPred.has(id);
    if (!superseded || shouldWidenSuperseded(successorId, candidateIds)) {
      admitted.push(result);
    }
  }

  const admittedIds = new Set<string>();
  for (const result of admitted) {
    const id = resultStateViewId(result);
    if (id) admittedIds.add(id);
  }

  return admitted.map((result) => {
    const id = resultStateViewId(result);
    return { ...result, stateLabel: labelFor(id, result, byPred, admittedIds) };
  });
}
