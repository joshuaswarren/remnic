/**
 * Chunked trigger-drain for the extraction pipeline.
 *
 * Split out of `turn-ingestion.ts`: that file is at the structural ratchet's
 * line cap (issue #1995), and the drain is a self-contained unit — it only
 * needs the host's `runExtraction`, the buffer drop, the storage side-file
 * copy and the preemption hook.
 */

import { createHash } from "node:crypto";
import { isAbortError, preemptedExtractionError } from "../abort-error.js";
import { describeError } from "../buffer-turn-helpers.js";
import { chunkExtractionWindow, classifyDrainResult, mergeDrainResults } from "../extraction-window-drain.js";
import { log } from "../logger.js";
import type { BufferTurn } from "../types.js";
import type { ExtractionRunCoordinator, ExtractionRunResult } from "./extraction-run.js";

type RunOptions = Parameters<ExtractionRunCoordinator["runExtraction"]>[1];

/** The `runExtraction` options the drain forwards, with the ones it reads made required. */
export type DrainRunOptions = RunOptions & {
  bufferKey: string;
  clearBufferAfterExtraction: boolean;
  skipUserTurnThreshold: boolean;
  failOnExtractionFailure: boolean;
  forceExtractionAttempt: boolean;
};

/** What the drain needs from its host (structurally satisfied by `TurnIngestionDeps`). */
export interface ExtractionDrainDeps {
  config: { extractionMinUserTurns: number; extractionChunkDropAfterFailures: number };
  extractionWindowBudgetChars?(): number;
  runExtraction(turns: BufferTurn[], options: RunOptions): Promise<ExtractionRunResult>;
  getStorage(): Promise<{
    saveDroppedExtractionChunk(bufferKey: string, reason: string, turns: readonly BufferTurn[]): Promise<string>;
  }>;
  buffer: { dropExtractionChunk(bufferKey: string, turns: readonly BufferTurn[]): Promise<number> };
  extractionQueueCoordinator: { beginPreemptable(abort: () => void): void };
}

/** Identity of a chunk: its failure count must not follow a buffer key to different content. */
function chunkFingerprint(chunk: readonly BufferTurn[]): string {
  const hash = createHash("sha256");
  for (const turn of chunk) hash.update(`${turn.role}\u0000${turn.timestamp}\u0000${turn.content}\u0001`);
  return hash.digest("hex");
}

export class ExtractionDrain {
  /**
   * Consecutive failed attempts on the head chunk, per buffer key. In memory on
   * purpose (a restart re-counts from zero). Bound to the chunk's content: a
   * count recorded for one chunk never applies to a different one, so a force
   * flush that clears a failing chunk cannot make unrelated content inherit its
   * failures.
   */
  private readonly failures = new Map<string, { fingerprint: string; count: number }>();

  /**
   * Buffer key to the first turn of the chunk a qualified window stopped on.
   * The rest of such a window stays eligible on the next attempt even when it
   * is assistant-only or short: the window passed the thresholds as a whole,
   * and re-judging its tail would clear it unextracted. Cleared when the
   * window drains; one entry per key.
   */
  private readonly qualified = new Map<string, string>();

  constructor(private readonly deps: ExtractionDrainDeps) {}

  private failureCount(bufferKey: string, chunk: readonly BufferTurn[]): number {
    const entry = this.failures.get(bufferKey);
    return entry && entry.fingerprint === chunkFingerprint(chunk) ? entry.count : 0;
  }

  private setFailureCount(bufferKey: string, chunk: readonly BufferTurn[], count: number): void {
    if (count <= 0) this.failures.delete(bufferKey);
    else this.failures.set(bufferKey, { fingerprint: chunkFingerprint(chunk), count });
  }

  /**
   * Run `runExtraction` over the trigger-drain window. When the window outgrows
   * the extraction model's input budget (the stall that keeps a session's buffer
   * growing forever: every observe re-fires the trigger on a window that can
   * never extract), split it into budget-fitting chunks and drain them in
   * order; each successful run clears its chunk, so the buffer shrinks across
   * observes. A chunk that fails `extractionChunkDropAfterFailures` times in a
   * row is dropped (side-file copy first). Breaker/backoff retention results
   * stop the drain without counting as chunk failures.
   *
   * Explicit drains (replay/import `clearBufferAfterExtraction: false`, force
   * flush, fail-closed callers, accepted captures) and windows that fit the
   * budget (or hosts without the budget accessor) take the single-run path.
   *
   * `preemptable`: the run was queued as preemptable automatic work. Each chunk's
   * persist step ends the host's preemption registration, so the drain registers
   * it again before every later chunk; a fail-closed flush can then abort the
   * next chunk's model request instead of waiting behind the whole window.
   */
  async run(turns: BufferTurn[], runOptions: DrainRunOptions, preemptable = false): Promise<ExtractionRunResult> {
    const budgetChars = this.deps.extractionWindowBudgetChars?.() ?? Number.POSITIVE_INFINITY;
    const chunkable =
      runOptions.clearBufferAfterExtraction &&
      !runOptions.forceExtractionAttempt &&
      !runOptions.failOnExtractionFailure &&
      !turns.some((turn) => turn.acceptedCapture === true) &&
      Number.isFinite(budgetChars) &&
      budgetChars > 0;
    const chunks = chunkable ? chunkExtractionWindow(turns, budgetChars) : [];
    const resumed =
      chunks.length > 0 && this.qualified.get(runOptions.bufferKey) === chunkFingerprint(chunks[0].slice(0, 1));
    const resumedOptions = resumed ? { ...runOptions, skipCharThreshold: true, skipUserTurnThreshold: true } : runOptions;
    if (chunks.length <= 1) {
      const single = await this.deps.runExtraction(turns, resumedOptions);
      if (resumed && classifyDrainResult(single) === "drained") this.qualified.delete(runOptions.bufferKey);
      return single;
    }
    // Eligibility (minimum user turns) belongs to the whole window: a window
    // that never qualified keeps the single-run path and its threshold skip.
    const windowUserTurns = turns.filter((turn) => turn.role === "user").length;
    if (!resumedOptions.skipUserTurnThreshold && windowUserTurns < this.deps.config.extractionMinUserTurns) {
      return await this.deps.runExtraction(turns, runOptions);
    }
    // The window qualified as a whole; its chunks must not be re-judged one by
    // one (an assistant-only or short chunk would be cleared unextracted).
    const baseOptions = { ...runOptions, skipCharThreshold: true, skipUserTurnThreshold: true };

    const bufferKey = runOptions.bufferKey;
    const dropAfter = this.deps.config.extractionChunkDropAfterFailures;
    let aggregate: ExtractionRunResult | null = null;
    for (const [position, chunk] of chunks.entries()) {
      this.qualified.set(bufferKey, chunkFingerprint(chunk.slice(0, 1)));
      let chunkOptions = baseOptions;
      let preempt: AbortController | undefined;
      if (preemptable && position > 0) {
        const local = new AbortController();
        preempt = local;
        this.deps.extractionQueueCoordinator.beginPreemptable(() => local.abort(preemptedExtractionError()));
        chunkOptions = {
          ...baseOptions,
          abortSignal: runOptions.abortSignal ? AbortSignal.any([runOptions.abortSignal, local.signal]) : local.signal,
        };
      }
      let failures = this.failureCount(bufferKey, chunk);
      let result: ExtractionRunResult;
      try {
        result = await this.deps.runExtraction(chunk, chunkOptions);
      } catch (err) {
        // The chunk-local abort leaves the outer signal untouched, so hand back the
        // preemption reason the host looks for (as it does for the first chunk).
        if (isAbortError(err)) throw preempt && preempt.signal.aborted && !runOptions.abortSignal?.aborted ? preempt.signal.reason : err;
        failures += 1;
        if (failures < dropAfter) {
          this.setFailureCount(bufferKey, chunk, failures);
          throw err;
        }
        // A chunk that keeps throwing is dropped like one that keeps failing,
        // so later chunks are not stuck behind it.
        const thrown: ExtractionRunResult = {
          status: "skipped",
          reason: `thrown: ${describeError(err)}`,
          persistedCount: 0,
          durableOutputCount: 0,
        };
        if (!(await this.dropFailedChunk(bufferKey, chunk, dropAfter, thrown))) {
          this.setFailureCount(bufferKey, chunk, failures);
          throw err;
        }
        this.setFailureCount(bufferKey, chunk, 0);
        continue;
      }
      const verdict = classifyDrainResult(result);
      if (verdict === "drained") {
        this.setFailureCount(bufferKey, chunk, 0);
        aggregate = mergeDrainResults(aggregate, result);
        continue;
      }
      // Provider breaker/backoff retention: keep everything for retry.
      if (verdict === "deferred") return mergeDrainResults(aggregate, result);
      failures += 1;
      if (failures >= dropAfter) {
        if (!(await this.dropFailedChunk(bufferKey, chunk, dropAfter, result))) {
          // No recovery copy: keep the only buffered copy and retry later.
          this.setFailureCount(bufferKey, chunk, failures);
          return mergeDrainResults(aggregate, result);
        }
        this.setFailureCount(bufferKey, chunk, 0);
        aggregate = mergeDrainResults(aggregate, result);
        continue;
      }
      this.setFailureCount(bufferKey, chunk, failures);
      // Retain the remaining window for the next trigger (existing behavior).
      return mergeDrainResults(aggregate, result);
    }
    this.qualified.delete(bufferKey);
    return aggregate ?? { status: "skipped", persistedCount: 0, durableOutputCount: 0 };
  }

  /** Side-file copy first (content survives a failed drop), then remove the failing chunk from the buffer. Never throws:
   *  the drop must not fail the extraction task that already settled its result. */
  private async dropFailedChunk(
    bufferKey: string,
    chunk: readonly BufferTurn[],
    dropAfter: number,
    result: ExtractionRunResult,
  ): Promise<boolean> {
    const reason =
      `dropped after ${dropAfter} repeated extraction failures ` +
      `(last result: status=${result.status} reason=${result.reason ?? "n/a"})`;
    try {
      const storage = await this.deps.getStorage();
      const path = await storage.saveDroppedExtractionChunk(bufferKey, reason, chunk);
      log.warn(`buffer[${bufferKey}]: dropping ${chunk.length} turns — ${reason}; copy saved to ${path}`);
    } catch (err) {
      // Never destroy the only buffered copy without a recovery file.
      log.warn(
        `buffer[${bufferKey}]: could not save the dropped-chunk recovery copy; keeping the chunk in the buffer: ${describeError(err)}`,
      );
      return false;
    }
    try {
      const dropped = await this.deps.buffer.dropExtractionChunk(bufferKey, chunk);
      if (dropped > 0) log.warn(`buffer[${bufferKey}]: removed ${dropped} buffered turns — ${reason}`);
    } catch (err) {
      log.warn(
        `buffer[${bufferKey}]: failed to remove dropped chunk from buffer (will retry next trigger): ${describeError(err)}`,
      );
    }
    return true;
  }
}
