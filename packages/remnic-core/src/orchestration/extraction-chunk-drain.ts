import { createHash } from "node:crypto";
import { isAbortError, preemptedExtractionError } from "../abort-error.js";
import { bufferTurnsEqual, describeError } from "../buffer-turn-helpers.js";
import { chunkExtractionWindow, classifyDrainResult, mergeDrainResults } from "../extraction-window-drain.js";
import { log } from "../logger.js";
import type { BufferTurn } from "../types.js";
import type { ExtractionRunResult } from "./extraction-run.js";
import type { TurnIngestionDeps } from "./turn-ingestion.js";

/** The run options `TurnIngestionCoordinator` hands to `runExtraction` for one window. */
export type ChunkDrainRunOptions = Parameters<TurnIngestionDeps["runExtraction"]>[1] & {
  bufferKey: string;
  clearBufferAfterExtraction: boolean;
  forceExtractionAttempt: boolean;
  failOnExtractionFailure: boolean;
  skipCharThreshold: boolean;
  skipUserTurnThreshold: boolean;
  abortSignal?: AbortSignal;
};

type ChunkDrainDeps = Pick<
  TurnIngestionDeps,
  "buffer" | "config" | "extractionQueueCoordinator" | "extractionWindowBudgetChars" | "getStorage" | "runExtraction"
>;

/** Identity of a chunk: failure counts belong to this content, not to the session key. */
function chunkIdentity(chunk: readonly BufferTurn[]): string {
  const hash = createHash("sha256");
  for (const turn of chunk) hash.update(`${turn.role}\0${turn.timestamp}\0${turn.content}\0`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Drains an extraction window that outgrew the local model's context.
 *
 * A session whose buffered window never fits the extraction model never
 * drains: the trigger fires on every observe, the request fails, nothing is
 * cleared, and the window only grows. This splits such a window into chunks
 * that fit the learned context budget, clears each chunk as it succeeds, and
 * drops a chunk that keeps failing (recovery copy first) so later chunks can
 * drain. Replay, import, force-flush and accepted-capture runs are never
 * chunked.
 */
export class ExtractionChunkDrain {
  /** Consecutive failures of the head chunk per buffer key, bound to that chunk's identity. */
  private readonly failures = new Map<string, { id: string; count: number }>();

  constructor(private readonly deps: ChunkDrainDeps) {}

  private countFor(bufferKey: string, id: string): number {
    const known = this.failures.get(bufferKey);
    return known?.id === id ? known.count : 0;
  }

  private record(bufferKey: string, id: string, count: number): void {
    if (count > 0) this.failures.set(bufferKey, { id, count });
    else this.failures.delete(bufferKey);
  }

  /** Did the run keep this chunk in the buffer for a retry (a failure), as opposed to extracting it? */
  private chunkStillBuffered(bufferKey: string, chunk: readonly BufferTurn[]): boolean {
    const first = chunk[0];
    return first !== undefined && this.deps.buffer.getTurns(bufferKey).some((turn) => bufferTurnsEqual(turn, first));
  }

  async run(turns: BufferTurn[], options: ChunkDrainRunOptions, preemptable: boolean): Promise<ExtractionRunResult> {
    const budgetChars = this.deps.extractionWindowBudgetChars?.() ?? Number.POSITIVE_INFINITY;
    const chunkable =
      options.clearBufferAfterExtraction &&
      !options.forceExtractionAttempt &&
      !options.failOnExtractionFailure &&
      !turns.some((turn) => turn.acceptedCapture === true) &&
      Number.isFinite(budgetChars) &&
      budgetChars > 0;
    const chunks = chunkable ? chunkExtractionWindow(turns, budgetChars) : [];
    if (chunks.length <= 1) return await this.deps.runExtraction(turns, options);
    // Eligibility (minimum user turns) belongs to the whole window: one that
    // never qualified keeps the single-run path and its threshold handling.
    const userTurns = turns.filter((turn) => turn.role === "user").length;
    if (!options.skipUserTurnThreshold && userTurns < this.deps.config.extractionMinUserTurns) {
      return await this.deps.runExtraction(turns, options);
    }
    const bufferKey = options.bufferKey;
    let aggregate: ExtractionRunResult | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const id = chunkIdentity(chunk);
      let result: ExtractionRunResult;
      try {
        result = await this.runChunk(chunk, index, options, preemptable);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const count = this.countFor(bufferKey, id) + 1;
        if (count < this.deps.config.extractionChunkDropAfterFailures) {
          this.record(bufferKey, id, count);
          throw err;
        }
        const failed: ExtractionRunResult = { status: "skipped", reason: `thrown: ${describeError(err)}`, persistedCount: 0, durableOutputCount: 0 };
        if (!(await this.dropChunk(bufferKey, chunk, failed))) {
          this.record(bufferKey, id, count);
          throw err;
        }
        this.record(bufferKey, id, 0);
        continue;
      }
      const verdict = classifyDrainResult(result, () => this.chunkStillBuffered(bufferKey, chunk));
      if (verdict === "drained") {
        this.record(bufferKey, id, 0);
        aggregate = mergeDrainResults(aggregate, result);
        continue;
      }
      if (verdict === "deferred") return mergeDrainResults(aggregate, result);
      const count = this.countFor(bufferKey, id) + 1;
      if (count >= this.deps.config.extractionChunkDropAfterFailures && (await this.dropChunk(bufferKey, chunk, result))) {
        this.record(bufferKey, id, 0);
        aggregate = mergeDrainResults(aggregate, result);
        continue;
      }
      // Retain the remaining window for the next trigger (and a chunk without a saved recovery copy).
      this.record(bufferKey, id, count);
      return mergeDrainResults(aggregate, result);
    }
    return aggregate ?? { status: "skipped", persistedCount: 0, durableOutputCount: 0 };
  }

  /**
   * One chunk's extraction. The first chunk runs under the caller's
   * preemption; once it persists, `onBeforePersist` ends that registration,
   * so later chunks register their own, and an access force-flush can still
   * preempt the drain between chunks.
   */
  private async runChunk(
    chunk: BufferTurn[],
    index: number,
    options: ChunkDrainRunOptions,
    preemptable: boolean,
  ): Promise<ExtractionRunResult> {
    const chunkOptions = { ...options, skipCharThreshold: true, skipUserTurnThreshold: true };
    if (index === 0 || !preemptable) return await this.deps.runExtraction(chunk, chunkOptions);
    const preempt = new AbortController();
    this.deps.extractionQueueCoordinator.beginPreemptable(() => preempt.abort(preemptedExtractionError()));
    try {
      const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, preempt.signal]) : preempt.signal;
      if (signal.aborted) throw preemptedExtractionError();
      return await this.deps.runExtraction(chunk, { ...chunkOptions, abortSignal: signal });
    } finally {
      this.deps.extractionQueueCoordinator.endPreemptable();
    }
  }

  /** Recovery copy first, then remove the chunk. False (nothing removed) when no copy could be saved. */
  private async dropChunk(bufferKey: string, chunk: readonly BufferTurn[], result: ExtractionRunResult): Promise<boolean> {
    const dropAfter = this.deps.config.extractionChunkDropAfterFailures;
    const reason = `dropped after ${dropAfter} repeated extraction failures (last result: status=${result.status} reason=${result.reason ?? "n/a"})`;
    try {
      const storage = await this.deps.getStorage();
      const path = await storage.saveDroppedExtractionChunk(bufferKey, reason, chunk);
      log.warn(`buffer[${bufferKey}]: dropping ${chunk.length} turns — ${reason}; copy saved to ${path}`);
    } catch (err) {
      log.warn(`buffer[${bufferKey}]: could not save the dropped-chunk recovery copy; keeping the chunk in the buffer: ${describeError(err)}`);
      return false;
    }
    try {
      const dropped = await this.deps.buffer.dropExtractionChunk(bufferKey, chunk);
      if (dropped > 0) log.warn(`buffer[${bufferKey}]: removed ${dropped} buffered turns — ${reason}`);
    } catch (err) {
      log.warn(`buffer[${bufferKey}]: failed to remove dropped chunk from buffer (will retry next trigger): ${describeError(err)}`);
    }
    return true;
  }
}
