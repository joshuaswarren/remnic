
import { throwIfAborted } from "./abort-error.js";

export interface CorpusReadOptions {
  /**
   * Stops the read at its next directory, batch, or attempt boundary. A single
   * in-flight file read is not interrupted; the boundaries are what bound the
   * work, and on a tree large enough to matter there are thousands of them.
   */
  abortSignal?: AbortSignal;
  /**
   * When `false`, parsed memories are returned without the raw file text kept
   * beside them (`rememberRawFrontmatter`). Default (unset) retains that copy.
   * A `false` read bypasses the shared corpus caches so it cannot replace a
   * raw-retaining snapshot other callers still need.
   */
  retainRaw?: boolean;
}

export function checkCorpusReadAbort(options?: CorpusReadOptions): void {
  throwIfAborted(options?.abortSignal, "corpus read aborted");
}
