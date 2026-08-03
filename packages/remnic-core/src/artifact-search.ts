/**
 * Verbatim-artifact keyword scan — extracted from `storage.ts` so the scan can
 * be made interruptible without growing that file (issue #2291).
 *
 * The scan re-tokenizes every stored artifact, and `fetchActiveArtifactsForNamespace`
 * repeats it with a growing fetch limit. On a large artifact tier that is long
 * enough to starve the event loop, which would stop a recall section deadline
 * from ever firing — so the loop yields periodically and observes cancellation.
 */

import { throwIfAborted } from "./abort-error.js";
import { yieldToEventLoop } from "./recall-qos.js";
import type { MemoryFile } from "./types.js";

const ARTIFACT_SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

/**
 * Artifacts scored between two yields. Small enough that a deadline observes a
 * sub-millisecond delay on a normal tier, large enough that the yields cost
 * nothing measurable relative to tokenizing that many documents.
 */
const ARTIFACT_SCAN_YIELD_INTERVAL = 256;

export function tokenizeArtifactSearchText(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !ARTIFACT_SEARCH_STOPWORDS.has(t));
}

export interface ArtifactSearchOptions {
  abortSignal?: AbortSignal;
}

/**
 * Rank the artifact tier by how many query tokens each document contains, best
 * first.
 *
 * `loadArtifacts` is a thunk rather than a value so the two cheap early exits —
 * an already-cancelled caller, and a query with no searchable tokens — happen
 * BEFORE the tier is read. Reading it can mean a full recursive filesystem scan
 * on a cold cache, which a stopword-only query must never pay for.
 *
 * Yields to the event loop every `ARTIFACT_SCAN_YIELD_INTERVAL` documents and
 * checks the caller's signal there, so a pending recall section deadline can fire
 * mid-scan and an abandoned recall stops scanning instead of running to the end.
 */
export async function selectArtifactMatches(
  loadArtifacts: () => Promise<MemoryFile[]>,
  query: string,
  maxResults: number,
  options: ArtifactSearchOptions = {},
): Promise<MemoryFile[]> {
  throwIfAborted(options.abortSignal, "artifact search aborted");
  const tokens = tokenizeArtifactSearchText(query);
  if (tokens.length === 0) return [];

  const artifacts = await loadArtifacts();
  // The scan below never awaits real I/O, so this is the last chance to observe a
  // signal that fired while the tier was being read.
  throwIfAborted(options.abortSignal, "artifact search aborted");
  const hits: Array<{ score: number; memory: MemoryFile }> = [];
  let scanned = 0;
  for (const memory of artifacts) {
    scanned += 1;
    if (scanned % ARTIFACT_SCAN_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
      throwIfAborted(options.abortSignal, "artifact search aborted");
    }
    const indexedTokens = new Set(
      tokenizeArtifactSearchText(`${memory.content} ${(memory.frontmatter.tags ?? []).join(" ")}`),
    );
    let score = 0;
    for (const token of tokens) {
      if (indexedTokens.has(token)) score += 1;
    }
    if (score > 0) {
      hits.push({ score, memory });
    }
  }
  // Ties keep corpus order: the comparator returns 0 for equal scores rather
  // than an arbitrary sign, so repeated scans produce the same top-N.
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxResults).map((h) => h.memory);
}
