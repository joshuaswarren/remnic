/**
 * Trigger-drain helpers (extraction trigger stall fix).
 *
 * A session whose buffered window outgrows the extraction model's context
 * never drains: the trigger fires `extract_batch` on every observe, the
 * oversized request fails, nothing is cleared, and the window only grows.
 * These helpers split such a window into budget-fitting chunks and classify
 * each extraction run so the caller can drain successes, defer on breaker/
 * backoff retention, and drop repeatedly failing chunks.
 */

import type { ExtractionRunResult } from "./orchestration/extraction-run.js";

/**
 * Split `turns` into chunks whose summed content length stays within
 * `maxChars`. Chunks keep turn order and never split a turn; a single turn
 * longer than the budget becomes its own chunk (the extraction prompt still
 * clamps per-turn content). A non-positive or non-finite budget, or an empty
 * window, yields at most one chunk (no chunking).
 */
export function chunkExtractionWindow<T extends { content: string }>(
  turns: readonly T[],
  maxChars: number,
): T[][] {
  if (turns.length === 0) return [];
  const budget =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Number.POSITIVE_INFINITY;
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  for (const turn of turns) {
    const turnChars = turn.content.length;
    if (current.length > 0 && currentChars + turnChars > budget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turnChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type DrainVerdict = "drained" | "deferred" | "failed";

/**
 * Run results that deliberately RETAIN the buffer (provider breaker open,
 * per-fingerprint backoff, a scope policy refusal) are deferrals, not chunk
 * failures — counting them would eventually drop good content that never got
 * its attempt.
 */
const DRAIN_DEFERRAL_REASONS = {
  provider_circuit_open: true,
  extraction_backoff: true,
  scope_profile_no_writable_layer: true,
};

export function classifyDrainResult(result: ExtractionRunResult): DrainVerdict {
  if (result.status !== "skipped") return "drained";
  if (result.reason !== undefined && result.reason in DRAIN_DEFERRAL_REASONS) return "deferred";
  // A run that kept its window for retry did NOT consume the content: it is a
  // chunk failure, never a drain — even when the window was retained.
  if (result.retainedBuffer === true) return "failed";
  return "drained";
}

/**
 * Combine chunk results into the single `ExtractionRunResult` the queue
 * contract settles with: counts sum, any completed chunk completes the drain,
 * and the last non-completed reason wins.
 */
export function mergeDrainResults(
  previous: ExtractionRunResult | null,
  next: ExtractionRunResult,
): ExtractionRunResult {
  if (previous === null) return next;
  const completed = previous.status === "completed" || next.status === "completed";
  const merged: ExtractionRunResult = {
    status: completed ? "completed" : "skipped",
    persistedCount: previous.persistedCount + next.persistedCount,
    durableOutputCount: previous.durableOutputCount + next.durableOutputCount,
  };
  if (!completed) merged.reason = next.reason ?? previous.reason;
  if (previous.postPersistMetadataFailed === true || next.postPersistMetadataFailed === true) {
    merged.postPersistMetadataFailed = true;
  }
  return merged;
}

/** The slice of ModelRegistry the drain budget needs. */
export interface WindowBudgetRegistry {
  calculateContextSizes(modelId: string, maxContextOverride?: number): { maxInputChars: number };
}

/**
 * Character budget for one extraction request. The learned local-model window
 * only describes the extractor when the local LLM does the extracting; with a
 * gateway extractor, a disabled local LLM, or no registry (legacy hosts, test
 * doubles) there is no budget and the window runs in one request as before.
 */
export function extractionWindowBudgetChars(input: {
  registry: WindowBudgetRegistry | undefined;
  localExtractionActive: boolean;
  model: string;
  maxContext: number | undefined;
  /** Configured per-call payload cap (`extractionCallMaxChars`). */
  callMaxChars?: number;
}): number {
  const callMax = input.callMaxChars ?? Number.POSITIVE_INFINITY;
  const cap = Number.isFinite(callMax) && callMax > 0 ? callMax : Number.POSITIVE_INFINITY;
  if (!input.registry || !input.localExtractionActive) return cap;
  return Math.min(cap, input.registry.calculateContextSizes(input.model, input.maxContext).maxInputChars);
}

/**
 * Split `content` into budget-fitting slices at sentence/paragraph
 * boundaries; a segment longer than the budget hard-cuts at the boundary.
 * The slices are contiguous and verbatim — join("") restores the input.
 */
function splitSegments(content: string): string[] {
  const out: string[] = [];
  let start = 0;
  let index = 0;
  while (index < content.length) {
    const ch = content[index];
    if (ch === "\n") {
      let end = index;
      while (end < content.length && content[end] === "\n") end += 1;
      out.push(content.slice(start, end));
      start = end;
      index = end;
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      let end = index + 1;
      while (end < content.length && (content[end] === " " || content[end] === "\t")) end += 1;
      out.push(content.slice(start, end));
      start = end;
      index = end;
      continue;
    }
    index += 1;
  }
  if (start < content.length) out.push(content.slice(start));
  return out;
}

function splitTurnContent(content: string, maxChars: number): string[] {
  const segments = splitSegments(content);
  const parts: string[] = [];
  let current = "";
  for (const segment of segments) {
    let piece = segment;
    while (piece.length > 0) {
      const room = maxChars - current.length;
      if (piece.length <= room) {
        current += piece;
        break;
      }
      if (current.length > 0) {
        parts.push(current);
        current = "";
        continue;
      }
      parts.push(piece.slice(0, maxChars));
      piece = piece.slice(maxChars);
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Replace each turn over `maxChars` with in-memory part copies marked
 * `extractionPartOf {part,of}` (payload-cap drain). Parts keep order and
 * carry verbatim contiguous slices so joining them restores the turn —
 * nothing is dropped by the split itself. A turn needing more than
 * `maxParts` emits `maxParts` parts and reports `clamped` so the caller
 * can log the bounded loss rather than hide it.
 */
export interface OversizedTurnSplit<T extends { content: string }> {
  turns: T[];
  partParents: Map<T, T>;
  clampedParents: Set<T>;
  clamped: boolean;
}

export function splitOversizedTurns<T extends { content: string }>(
  turns: readonly T[],
  maxChars: number,
  maxParts = 8,
): OversizedTurnSplit<T> {
  const partParents = new Map<T, T>();
  const clampedParents = new Set<T>();
  const budget = Math.floor(maxChars);
  if (!(Number.isFinite(budget) && budget > 0)) {
    return { turns: [...turns], partParents, clampedParents, clamped: false };
  }
  const out: T[] = [];
  let clamped = false;
  for (const turn of turns) {
    if (turn.content.length <= budget) {
      out.push(turn);
      continue;
    }
    const slices = splitTurnContent(turn.content, budget);
    const emitted = slices.slice(0, maxParts);
    if (slices.length > maxParts) {
      clamped = true;
      clampedParents.add(turn);
    }
    const of = emitted.length;
    for (const [index, slice] of emitted.entries()) {
      const part = { ...turn, content: slice, extractionPartOf: { part: index + 1, of } };
      partParents.set(part, turn);
      out.push(part);
    }
  }
  return { turns: out, partParents, clampedParents, clamped };
}
