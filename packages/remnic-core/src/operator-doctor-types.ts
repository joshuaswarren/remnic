/**
 * Shared operator-doctor result type.
 *
 * Extracted from `operator-toolkit.ts` (issue #2151 review, PR 2155) so that a
 * lightweight doctor summarizer such as `extraction-liveness.ts` can type its
 * return value WITHOUT importing the whole `operator-toolkit` module. That
 * back-edge (`extraction-liveness` -> `operator-toolkit` -> `extraction-liveness`)
 * was a circular type reference that made the standalone DTS entry for
 * `extraction-liveness.ts` resolve the entire operator-toolkit + config + types
 * graph, pushing the tsup DTS worker past its heap limit
 * (ERR_WORKER_OUT_OF_MEMORY). This interface has no dependencies, so importing it
 * costs nothing.
 */
export interface OperatorDoctorCheck {
  key: string;
  status: "ok" | "warn" | "error";
  summary: string;
  remediation?: string;
  details?: unknown;
}
