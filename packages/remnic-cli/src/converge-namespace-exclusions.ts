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

const TRANSPORT_MARKERS = [
  "aborted due to timeout",
  "operation was aborted",
  "fetch failed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
  "eai_again",
  "socket hang up",
  "und_err_",
];

function hasHttpStatus(message: string): boolean {
  let from = 0;
  while (from < message.length) {
    const at = message.indexOf("HTTP ", from);
    if (at < 0) return false;
    const start = at + 5;
    if (
      start + 2 < message.length &&
      message.charCodeAt(start) >= 48 &&
      message.charCodeAt(start) <= 57 &&
      message.charCodeAt(start + 1) >= 48 &&
      message.charCodeAt(start + 1) <= 57 &&
      message.charCodeAt(start + 2) >= 48 &&
      message.charCodeAt(start + 2) <= 57
    ) {
      return true;
    }
    from = start;
  }
  return false;
}

function hasTransportMarker(message: string): boolean {
  const lower = message.toLowerCase();
  for (const marker of TRANSPORT_MARKERS) {
    if (lower.includes(marker)) return true;
  }
  return false;
}

/**
 * These messages append a peer-controlled path. A file named "fetch failed"
 * must not abort the cycle; a real timeout is on `cause` or is the error itself.
 */
const PEER_PATH_ERROR_PREFIXES = [
  "failed to read peer reconciliation manifest file:",
  "failed to read peer tombstone evidence:",
  "offline file content response changed during transfer:",
];

function errorEmbedsPeerPath(message: string): boolean {
  for (const prefix of PEER_PATH_ERROR_PREFIXES) {
    if (message.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * A peer request that never produced an HTTP status. One timeout or
 * connection failure used to reject the cycle; treating it as a per-namespace
 * exclusion would wait out that timeout once per namespace.
 * An HTTP status, including a namespace refusal, is not a transport failure.
 * Marker text inside a peer path is not a transport failure either.
 */
export function isPeerTransportCensusFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) return false;
    if (hasHttpStatus(current.message)) return false;
    if (current.name === "TimeoutError") return true;
    if (!errorEmbedsPeerPath(current.message) && hasTransportMarker(current.message)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Record one namespace census failure.
 *
 * An aborted planning signal is not a census failure: the operator asked the
 * whole cycle to stop, and a partial plan must not be returned in its place.
 * A peer transport failure (timeout, connection loss) also rejects the cycle.
 * The peer did not answer for this namespace, and repeating the wait for
 * every remaining namespace stalls the watch. An HTTP refusal stays isolated.
 */
export function recordNamespaceCensusFailure(
  excluded: Map<string, ConvergeNamespaceFailure>,
  namespace: string,
  side: "local" | "peer",
  error: unknown,
  signal: AbortSignal | undefined
): void {
  if (signal?.aborted) throw error;
  if (side === "peer" && isPeerTransportCensusFailure(error)) throw error;
  const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  excluded.set(namespace, { namespace, side, error: message, cause: error });
}

/**
 * A shared physical root is one census. Dropping only the representative
 * leaves the other names to be planned with an empty local side.
 */
export function excludeNamespaceGroup(
  excluded: Map<string, ConvergeNamespaceFailure>,
  namespaces: readonly string[],
  side: "local" | "peer",
  error: unknown,
  signal: AbortSignal | undefined,
  drop: (namespace: string) => void
): void {
  for (const namespace of namespaces) {
    recordNamespaceCensusFailure(excluded, namespace, side, error, signal);
    drop(namespace);
  }
}

/** Drop C0/C1 controls and DEL so a peer error cannot write terminal sequences. */
export function singleLine(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const code = char.charCodeAt(0);
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    if (isSpace) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) continue;
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
  }
  return out;
}

function loggedCensusFailure(failure: ConvergeNamespaceFailure): string {
  const message = failure.error.length > 0 ? failure.error : String(failure.cause);
  const cleaned = singleLine(message);
  return `${singleLine(failure.namespace)} (${failure.side}): ${cleaned.length > 0 ? cleaned : "namespace census failed"}`;
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
 * its original message, with terminal controls removed, and the original
 * rejection as cause. Several rejections are joined so the log names every
 * namespace.
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
  if (failures.length === 1 && only) {
    const message = only.error.length > 0 ? only.error : String(only.cause);
    const cleaned = singleLine(message);
    // Keep the original rejection as cause so transport classification still
    // sees it. The message is what stderr prints.
    throw new Error(cleaned.length > 0 ? cleaned : "namespace census failed", { cause: only.cause });
  }
  throw new Error(`converge: every namespace census failed: ${failures.map(loggedCensusFailure).join("; ")}`);
}
