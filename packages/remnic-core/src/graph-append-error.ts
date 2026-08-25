/**
 * Sibling of {@link "./graph.js"} holding the append-failure error type so
 * graph.ts stays within its file-size ratchet cap (issue #1995). Type-only
 * dependency on GraphEdge — no runtime cycle with graph.ts.
 */
import type { GraphEdge } from "./graph.js";

/**
 * Issue #2330 round N+16 (A): thrown by `GraphIndex.onMemoryWritten` when an
 * append fails, carrying the rows this call had ALREADY appended — tracked
 * incrementally as each row is written, before any return value exists. A
 * rollback that only sees the raw failure used to fall back to a node-wide
 * sweep, which also deleted rows a NEWER writer had rebuilt inside the
 * failing writer's window; with the partial set on the error, the rollback
 * stays surgical even on the throwing path. The original failure is
 * preserved as `cause` (create-path callers only log it).
 */
export class GraphEdgeAppendError extends Error {
  readonly appendedEdges: readonly GraphEdge[];
  constructor(cause: unknown, appendedEdges: readonly GraphEdge[]) {
    super(
      `graph edge append failed after ${appendedEdges.length} row(s): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "GraphEdgeAppendError";
    this.appendedEdges = appendedEdges;
  }
}
