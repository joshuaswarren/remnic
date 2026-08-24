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

const CHANGE_WORDS = ["switch", "switches", "switched", "switching", "change", "changes", "changed", "changing"];

// Phrase matches are token-bounded: "when Didi" must not fire the
// "when did" phrase, and "confused to" must not fire "used to".
const CHANGE_PHRASE_RE = /\bwhen\s+did\b|\bused\s+to\b/;
const CHANGE_WORD_RE = new RegExp(`\\b(?:${CHANGE_WORDS.join("|")})\\b`);
// Bare "before"/"after" are ordinary sequencing ("before lunch",
// "after install"). They carry change intent only when they point at a
// specific event through a determiner ("before the move", "after the
// cutover").
const EVENT_POINTER_RE = /\b(?:before|after)\s+(?:the|a|an|this|that|these|those)\b/;

export function parseRecallStateViews(raw: unknown): boolean {
  return coerceBooleanLike(raw, "recallStateViews") === true;
}

export function isChangeOrientedQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return CHANGE_PHRASE_RE.test(lower) || CHANGE_WORD_RE.test(lower) || EVENT_POINTER_RE.test(lower);
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
  asOfMs: number | null,
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
  if (result.status === "superseded") {
    // #1952 asOf mode: the successor is legitimately absent under the
    // historical pin. The row was the live fact at the snapshot when the
    // recorded supersession postdates the pin ("current" relative to
    // the snapshot); already replaced at the pin is "historical".
    return asOfMs === null ? "historical" : snapshotStateLabel(result, asOfMs);
  }
  return "current";
}

function snapshotStateLabel(result: StateViewResult, asOfMs: number): StateLabel {
  const supersededAtMs = Date.parse(result.supersededAt ?? "");
  return Number.isFinite(supersededAtMs) && supersededAtMs <= asOfMs
    ? "historical"
    : "current";
}

export function annotateStateView<T extends StateViewResult>(
  results: T[],
  query: string,
  chains: readonly StateViewChain[],
  options: { enabled?: boolean; asOfMs?: number; changeIntent?: boolean } = {},
): T[] {
  const enabled = options.enabled === true;
  // #2893 — changeIntent:true marks intent as already classified from the
  // ORIGINAL prompt; `query` may be cron-normalized (intent signal
  // truncated or stop-worded away) and must not be re-checked then.
  if (!enabled || (options.changeIntent !== true && !isChangeOrientedQuery(query))) return results;
  // #1952 asOf mode: under a historical pin the pipeline's isValidAsOf
  // gate already decided validity at the pinned instant, so a predecessor
  // must not be discarded merely because its successor is absent under
  // the same filter. A valid asOf result is never emptied here.
  const asOfMs =
    typeof options.asOfMs === "number" && Number.isFinite(options.asOfMs)
      ? options.asOfMs
      : null;

  const byPred = buildSuccessorMap(results, chains);
  const candidateIds = new Set<string>();
  for (const result of results) {
    const id = resultStateViewId(result);
    if (id) candidateIds.add(id);
  }

  const isSupersededRow = (result: T): { superseded: boolean; successorId: string | undefined } => {
    const id = resultStateViewId(result);
    return {
      superseded: result.status === "superseded" || Boolean(result.supersededBy) || byPred.has(id),
      successorId: result.supersededBy ?? byPred.get(id),
    };
  };

  let admitted: T[];
  if (asOfMs !== null) {
    admitted = results.slice();
  } else {
    admitted = [];
    for (const result of results) {
      const { superseded, successorId } = isSupersededRow(result);
      if (!superseded || shouldWidenSuperseded(successorId, candidateIds)) {
        admitted.push(result);
      }
    }

    // #1952 contract: superseded never appears without its successor. A
    // successor can itself be dropped (filtered elsewhere, or transitively
    // orphaned), so reconcile to a fixpoint instead of trusting the first pass.
    let admittedIds = new Set(admitted.map(resultStateViewId).filter(Boolean));
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = admitted.length - 1; i >= 0; i -= 1) {
        const row = admitted[i]!;
        const { superseded, successorId } = isSupersededRow(row);
        if (superseded && !shouldWidenSuperseded(successorId, admittedIds)) {
          admitted.splice(i, 1);
          changed = true;
        }
      }
      if (changed) admittedIds = new Set(admitted.map(resultStateViewId).filter(Boolean));
    }
  }

  const admittedIds = new Set(admitted.map(resultStateViewId).filter(Boolean));
  return admitted.map((result) => {
    const id = resultStateViewId(result);
    return { ...result, stateLabel: labelFor(id, result, byPred, admittedIds, asOfMs) };
  });
}
