/**
 * Recall composition decision (#2972 layer 2).
 *
 * Extracted from recall-internal so that file stays under its ratchet
 * ceiling. Classifies injected memory context as complete / degraded /
 * missing, builds the compact (first-line) form from section buckets,
 * and turns outer-recall failures into the missing-note instead of "".
 */

import { isAbortError } from "./abort-error.js";
import {
  boundRecallContextComposition,
  composeMissingMemoryContext,
  composeRecallContext,
  RECALL_CONTEXT_SEPARATOR,
  type RecallContextComposition,
} from "./recall-context-composition.js";

export type RecallCompositionChunk = string | { readonly content: string };

export interface DecideRecallContextCompositionInput {
  context: string;
  compactContext?: string;
  footer?: string;
  maxChars: number;
}

export interface DecidedRecallContextComposition {
  composition: RecallContextComposition;
  context: string;
  truncated: boolean;
}

function firstLine(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? trimmed : trimmed.slice(0, newline).trimEnd();
}

function chunkContent(chunk: RecallCompositionChunk): string {
  return typeof chunk === "string" ? chunk : chunk.content;
}

/**
 * Shallow form of every section chunk: the first line of each entry,
 * so a budget miss prefers breadth-complete-but-shallow over a clipped
 * tail. Empty chunks contribute nothing.
 */
export function compactRecallContextFromBuckets(
  buckets: Iterable<readonly [unknown, readonly RecallCompositionChunk[]]>,
): string {
  const sections: string[] = [];
  for (const [, chunks] of buckets) {
    const lines: string[] = [];
    for (const chunk of chunks) {
      const line = firstLine(chunkContent(chunk));
      if (line.length > 0) lines.push(line);
    }
    if (lines.length > 0) sections.push(lines.join("\n"));
  }
  return sections.join(RECALL_CONTEXT_SEPARATOR);
}

export function decideRecallContextComposition(
  input: DecideRecallContextCompositionInput,
): DecidedRecallContextComposition {
  const composition = boundRecallContextComposition({
    context: input.context,
    footer: input.footer,
    maxChars: input.maxChars,
    compactContext: input.compactContext,
  });
  return {
    composition,
    context: composeRecallContext(composition),
    truncated:
      composition.degradation?.reason === "budget-clipped" ||
      composition.degradation?.reason === "budget-compacted",
  };
}

export function notifyContextComposition(
  onContextComposition:
    | ((composition: RecallContextComposition) => void | PromiseLike<void>)
    | undefined,
  composition: RecallContextComposition,
  onError: (err: unknown) => void,
): void {
  if (!onContextComposition) return;
  try {
    const result = onContextComposition(composition);
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch(onError);
    }
  } catch (err) {
    onError(err);
  }
}

/**
 * Outer-recall failure: abort stays silent (empty string). Timeout and
 * other errors become the missing-note so a failed query is never
 * indistinguishable from "no matches".
 */
export function recallFailureComposition(err: unknown): RecallContextComposition | null {
  if (isAbortError(err)) return null;
  const detail =
    err instanceof Error && err.message === "recall timeout"
      ? "timeout"
      : "recall_failed";
  return composeMissingMemoryContext({ detail });
}
