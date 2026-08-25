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
 *
 * #2859 — chain identities are namespace-qualified (`namespace\0id`): the
 * same id in two namespaces never cross-anchors. The reverse chain derives
 * from the successor's `supersedes` back-pointer when a predecessor lacks
 * `supersededBy`, and asOf snapshot labels use the temporal validity
 * boundary (predecessor `invalidAt` / successor `validAt`), not the
 * `supersededAt` write time.
 */
import { coerceBooleanLike } from "./connectors/coerce.js";

export type StateLabel = "current" | "historical" | "transition";

export interface StateViewChain {
  predecessorId: string;
  successorId: string;
  supersededAt?: string;
  /** #2859 — namespace scope; a chain link never crosses namespaces. */
  namespace?: string;
}

export interface StateViewResult {
  id?: string;
  docid?: string;
  status?: string;
  /** #2859 — namespace that owns this row; qualifies every chain identity. */
  namespace?: string;
  /** #2859 — back-pointer: id of the row this one replaced. */
  supersedes?: string;
  supersededBy?: string;
  supersededAt?: string;
  /** #2859 — fact validity start (frontmatter `valid_at`). */
  validAt?: string;
  /** #2859 — fact validity end (frontmatter `invalid_at`). */
  invalidAt?: string;
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

/**
 * #2859 — namespace-qualified chain identity. Namespace fanout can surface
 * the same id from two namespaces; every successor/admission match runs on
 * `namespace\0id` keys so a row in one namespace can never anchor (or be
 * anchored by) an identically-named row in another.
 */
export function stateViewKey(namespace: string | undefined, id: string): string {
  return `${typeof namespace === "string" ? namespace : ""}\u0000${id}`;
}

export function resultStateViewKey(result: StateViewResult): string {
  const id = resultStateViewId(result);
  return id ? stateViewKey(result.namespace, id) : "";
}

/** Inverse of {@link stateViewKey}: the id after the namespace separator. */
function stateViewIdFromKey(key: string): string {
  const sep = key.indexOf("\u0000");
  return sep === -1 ? key : key.slice(sep + 1);
}

/**
 * predecessorKey → successorKey, namespace-qualified. Precedence: explicit
 * chains, then successor rows' `supersedes` back-pointers (#2859 — derives
 * the reverse chain when the predecessor lacks `supersededBy`), then the
 * predecessor's own `supersededBy` (authoritative when present).
 */
function buildSuccessorMap(
  results: readonly StateViewResult[],
  chains: readonly StateViewChain[],
): Map<string, string> {
  const byPred = new Map<string, string>();
  const link = (predKey: string, succKey: string, overwrite: boolean): void => {
    if (!predKey || !succKey) return;
    if (overwrite || !byPred.has(predKey)) byPred.set(predKey, succKey);
  };
  for (const chain of chains) {
    if (chain.predecessorId && chain.successorId) {
      link(
        stateViewKey(chain.namespace, chain.predecessorId),
        stateViewKey(chain.namespace, chain.successorId),
        false,
      );
    }
  }
  for (const result of results) {
    const key = resultStateViewKey(result);
    if (key && result.supersedes) {
      link(stateViewKey(result.namespace, result.supersedes), key, false);
    }
  }
  for (const result of results) {
    const key = resultStateViewKey(result);
    if (key && result.supersededBy) {
      link(key, stateViewKey(result.namespace, result.supersededBy), true);
    }
  }
  return byPred;
}

function successorLinkOf(
  result: StateViewResult,
  byPred: ReadonlyMap<string, string>,
): { superseded: boolean; successorKey: string | undefined } {
  const key = resultStateViewKey(result);
  return {
    superseded:
      result.status === "superseded" ||
      Boolean(result.supersededBy) ||
      byPred.has(key),
    successorKey: result.supersededBy
      ? stateViewKey(result.namespace, result.supersededBy)
      : byPred.get(key),
  };
}

function labelFor(
  key: string,
  result: StateViewResult,
  byPred: Map<string, string>,
  admittedIds: ReadonlySet<string>,
  asOfMs: number | null,
): StateLabel {
  const { successorKey } = successorLinkOf(result, byPred);
  const isPred = shouldWidenSuperseded(successorKey, admittedIds);
  let isSucc = false;
  for (const [predId, succId] of byPred) {
    if (succId === key && admittedIds.has(predId)) {
      isSucc = true;
      break;
    }
  }
  if (isPred && isSucc) return "transition";
  if (isPred) return "historical";
  if (isSucc) return "current";
  if (result.status === "superseded") {
    // #1952 asOf mode: the successor is legitimately absent under the
    // historical pin (a linked successor takes the pair branches above).
    // The row was the live fact at the snapshot when the temporal
    // validity boundary postdates the pin ("current" relative to the
    // snapshot); already replaced at the pin is "historical". #2859: the
    // boundary is the fact's validity flip — `invalidAt` (the supersession
    // pipeline sets it to the successor's valid_at) — not the
    // `supersededAt` write time; legacy rows without a window fall back
    // to supersededAt.
    return asOfMs === null ? "historical" : snapshotStateLabel(result, asOfMs);
  }
  return "current";
}

function snapshotStateLabel(result: StateViewResult, asOfMs: number): StateLabel {
  const invalidAtMs = Date.parse(result.invalidAt ?? "");
  const boundaryMs = Number.isFinite(invalidAtMs)
    ? invalidAtMs
    : Date.parse(result.supersededAt ?? "");
  return Number.isFinite(boundaryMs) && boundaryMs <= asOfMs ? "historical" : "current";
}

export function annotateStateView<T extends StateViewResult>(
  results: T[],
  query: string,
  chains: readonly StateViewChain[],
  options: { enabled?: boolean; asOfMs?: number } = {},
): T[] {
  const enabled = options.enabled === true;
  if (!enabled || !isChangeOrientedQuery(query)) return results;
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
    const key = resultStateViewKey(result);
    if (key) candidateIds.add(key);
  }
  let admitted: T[];
  if (asOfMs !== null) {
    admitted = results.slice();
  } else {
    admitted = [];
    for (const result of results) {
      const { superseded, successorKey } = successorLinkOf(result, byPred);
      if (!superseded || shouldWidenSuperseded(successorKey, candidateIds)) {
        admitted.push(result);
      }
    }

    // #1952 contract: superseded never appears without its successor. A
    // successor can itself be dropped (filtered elsewhere, or transitively
    // orphaned), so reconcile to a fixpoint instead of trusting the first pass.
    let admittedIds = new Set(admitted.map(resultStateViewKey).filter(Boolean));
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = admitted.length - 1; i >= 0; i -= 1) {
        const row = admitted[i]!;
        const { superseded, successorKey } = successorLinkOf(row, byPred);
        if (superseded && !shouldWidenSuperseded(successorKey, admittedIds)) {
          admitted.splice(i, 1);
          changed = true;
        }
      }
      if (changed) admittedIds = new Set(admitted.map(resultStateViewKey).filter(Boolean));
    }
  }

  const admittedIds = new Set(admitted.map(resultStateViewKey).filter(Boolean));
  return admitted.map((result) => {
    const key = resultStateViewKey(result);
    const { successorKey } = successorLinkOf(result, byPred);
    const stateLabel = labelFor(key, result, byPred, admittedIds, asOfMs);
    if (result.supersededBy || !successorKey) return { ...result, stateLabel };
    return { ...result, stateLabel, supersededBy: stateViewIdFromKey(successorKey) };
  });
}

/**
 * #2859 — drop superseded rows whose successor is not in the pool BEFORE
 * the user cap/MMR runs, so post-cap orphan removal can never underfill
 * the result set. Reconciles to a fixpoint (a dropped successor orphans
 * its own predecessors). Rows with no successor links pass through in
 * order. ponytail: repeated full-pool passes are O(n²) on one long chain;
 * recall pools stay small, memoize per-key if pools ever grow.
 */
export function reconcileStateViewPairs<T extends StateViewResult>(results: readonly T[]): T[] {
  const byPred = buildSuccessorMap(results, []);
  let kept = results.slice();
  for (let changed = true; changed; ) {
    changed = false;
    const keptKeys = new Set(kept.map(resultStateViewKey).filter(Boolean));
    const next: T[] = [];
    for (const row of kept) {
      const { superseded, successorKey } = successorLinkOf(row, byPred);
      if (superseded && !shouldWidenSuperseded(successorKey, keptKeys)) {
        changed = true;
        continue;
      }
      next.push(row);
    }
    if (changed) kept = next;
  }
  return kept;
}

/**
 * #2859 — packet-counting cap. A predecessor/successor chain admitted
 * together is ONE complete evidence packet: it consumes a single slot of
 * the user cap, and the slice never splits a packet at the boundary (no
 * underfill from post-cap orphan removal). Rows keep their incoming
 * (MMR) order; packets are ordered by first appearance. Call
 * reconcileStateViewPairs first so orphans never consume a slot.
 */
export function capStateViewPackets<T extends StateViewResult>(
  ordered: readonly T[],
  limit: number,
): T[] {
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit === 0) return [];
  if (ordered.length === 0) return [];

  const byPred = buildSuccessorMap(ordered, []);
  // Union-find over row keys; blank-key rows become per-index singletons.
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let current = key;
    for (;;) {
      const up = parent.get(current);
      if (up === undefined || up === current) {
        parent.set(current, current);
        return current;
      }
      current = up;
    }
  };
  const union = (a: string, b: string): void => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const keys: string[] = [];
  const keyToIndex = new Map<string, number>();
  for (let i = 0; i < ordered.length; i += 1) {
    // ponytail: blank-key rows must stay distinct singletons; index-keyed.
    const key = resultStateViewKey(ordered[i]!) || `#idx${i}`;
    keys.push(key);
    if (!parent.has(key)) parent.set(key, key);
    const first = keyToIndex.get(key);
    if (first !== undefined) union(keys[first]!, key);
    else keyToIndex.set(key, i);
  }
  for (const [predKey, succKey] of byPred) {
    const predIdx = keyToIndex.get(predKey);
    const succIdx = keyToIndex.get(succKey);
    if (predIdx !== undefined && succIdx !== undefined) union(keys[predIdx]!, keys[succIdx]!);
  }
  // Packets ordered by first appearance; admit whole packets until the cap.
  const selectedRoots = new Set<string>();
  for (let i = 0; i < ordered.length && selectedRoots.size < safeLimit; i += 1) {
    selectedRoots.add(root(keys[i]!));
  }
  const selected: T[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (selectedRoots.has(root(keys[i]!))) selected.push(ordered[i]!);
  }
  return selected;
}
