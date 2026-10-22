/**
 * Per-namespace census isolation for `converge plan` / `apply` / `watch`.
 *
 * A snapshot or manifest failure for one namespace used to reject the whole
 * cycle. Callers that treated the failure as an empty census then planned
 * pushes of every local file and deletes of every peer file. A failed
 * namespace is omitted from both sides instead: nothing is pushed, nothing
 * is deleted, and the other namespaces still converge.
 */

export interface ConvergeNamespaceExclusion {
  namespace: string;
  side: "local" | "peer";
  /** Operator-facing reason. Bounded by the census error; safe to log. */
  error: string;
}

export interface ConvergeNamespaceFailure extends ConvergeNamespaceExclusion {
  /** Original rejection, rethrown when every namespace failed. */
  cause: unknown;
}

/**
 * Record one namespace census failure.
 *
 * An aborted planning signal is not a census failure: the operator asked the
 * whole cycle to stop, and a partial plan must not be returned in its place.
 * A timeout abort on the request's own signal leaves the planning signal
 * un-aborted and is a per-namespace failure.
 */
export function recordNamespaceCensusFailure(
  excluded: Map<string, ConvergeNamespaceFailure>,
  namespace: string,
  side: "local" | "peer",
  error: unknown,
  signal: AbortSignal | undefined
): void {
  if (signal?.aborted) throw error;
  const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  excluded.set(namespace, { namespace, side, error: message, cause: error });
}

function compareNamespaceSide(left: ConvergeNamespaceExclusion, right: ConvergeNamespaceExclusion): number {
  if (left.namespace < right.namespace) return -1;
  if (left.namespace > right.namespace) return 1;
  if (left.side < right.side) return -1;
  if (left.side > right.side) return 1;
  return 0;
}

export function listNamespaceExclusions(
  excluded: ReadonlyMap<string, ConvergeNamespaceFailure>
): ConvergeNamespaceExclusion[] {
  return [...excluded.values()]
    .map(({ namespace, side, error }) => ({ namespace, side, error }))
    .sort(compareNamespaceSide);
}

/**
 * Fail the cycle only when no namespace remains to plan. One rejection keeps
 * its original error so a fully unreadable peer still fails closed. Several
 * rejections are joined so the log names every namespace.
 */
export interface ConvergeApplyExclusionInput {
  converged: boolean;
  status: "converged" | "applied" | "partial" | "stopped_unresolved_conflicts" | "dry_run";
  transfers: { failed: number };
}

/**
 * A cycle that excluded a namespace is not fully converged. Transfer failures,
 * unresolved conflicts, and dry runs keep their own status; everything else
 * is `partial` so the log does not claim the pair agreed.
 */
export function finishConvergeApplyResult<T extends ConvergeApplyExclusionInput>(
  result: T,
  excludedNamespaces: readonly ConvergeNamespaceExclusion[]
): T {
  if (excludedNamespaces.length === 0) return result;
  const failedTransfers = result.status === "applied" && result.transfers.failed > 0;
  const keepStatus = result.status === "stopped_unresolved_conflicts" || result.status === "dry_run" || failedTransfers;
  return {
    ...result,
    excludedNamespaces,
    converged: false,
    status: keepStatus ? result.status : "partial",
  };
}

export function throwIfEveryNamespaceCensusFailed(
  plannedNamespaces: number,
  excluded: ReadonlyMap<string, ConvergeNamespaceFailure>
): void {
  if (plannedNamespaces > 0 || excluded.size === 0) return;
  const failures = [...excluded.values()].sort(compareNamespaceSide);
  const only = failures[0];
  if (failures.length === 1 && only) throw only.cause;
  throw new Error(
    `converge: every namespace census failed: ${failures
      .map((failure) => `${failure.namespace} (${failure.side}): ${failure.error}`)
      .join("; ")}`
  );
}
