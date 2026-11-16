/** Chunked trigger-drain for the extraction pipeline. */

import { createHash } from "node:crypto";
import { isAbortError, preemptedExtractionError } from "../abort-error.js";
import { describeError } from "../buffer-turn-helpers.js";
import { chunkExtractionWindow, classifyDrainResult, mergeDrainResults } from "../extraction-window-drain.js";
import { log } from "../logger.js";
import type { BufferTurn } from "../types.js";
import { type CollapsedDuplicates, collapseExactDuplicateTurns, markDuplicateTurns } from "./extraction-dedupe.js";
import type { ExtractionPreemptHandle } from "./extraction-queue-coordinator.js";
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
  config: {
    extractionMinUserTurns: number;
    extractionMinChars: number;
    extractionMaxTurnChars: number;
    extractionChunkDropAfterFailures: number;
  };
  extractionWindowBudgetChars?(): number;
  /** Rendered-size oracle: the exact character count the extraction renderer */
  measureRenderedTurns?(turns: readonly BufferTurn[]): number;
  runExtraction(turns: BufferTurn[], options: RunOptions): Promise<ExtractionRunResult>;
  getStorage(): Promise<{
    saveDroppedExtractionChunk(bufferKey: string, reason: string, turns: readonly BufferTurn[]): Promise<string>;
  }>;
  buffer: {
    dropExtractionChunk(
      bufferKey: string,
      turns: readonly BufferTurn[],
      options?: { allowNonPrefix?: boolean }
    ): Promise<number>;
  };
}

/** Identity of a chunk: its failure count must not follow a buffer key to different content. */
function chunkFingerprint(chunk: readonly BufferTurn[]): string {
  const hash = createHash("sha256");
  for (const turn of chunk) hash.update(`${turn.role}\u0000${turn.timestamp}\u0000${turn.content}\u0001`);
  return hash.digest("hex");
}

/** The chunking decision for one trigger-drain window. */
interface ChunkPlan {
  singleRun: boolean;
  chunks: BufferTurn[][];
  resumed: boolean;
}

/** The drain-loop action for one chunk result. */
interface ChunkVerdict {
  action: "continue" | "return" | "failed";
  result: ExtractionRunResult;
  aggregate: ExtractionRunResult | null;
}

/** Per-chunk run options plus the chunk-local preemption controller. */
interface ChunkExecutionOptions {
  options: DrainRunOptions;
  preempt?: AbortController;
}

export class ExtractionDrain {
  /** Consecutive failed attempts on the head chunk, per buffer key. In memory on */
  private readonly failures = new Map<string, { fingerprint: string; count: number }>();

  /**
   * Buffer key to the first turn of the chunk a qualified window stopped on.
   * The rest of such a window stays eligible on the next attempt even when it
   * is assistant-only or short: the window passed the thresholds as a whole,
   * and re-judging its tail would clear it unextracted. Cleared when the
   * window drains; one entry per key.
   */
  private readonly qualified = new Map<string, string>();

  /** The claim drain runs with `dropFailedChunks: false`: a chunk that keeps */
  private readonly dropFailedChunks: boolean;

  private readonly deps: ExtractionDrainDeps;

  constructor(deps: ExtractionDrainDeps, options?: { dropFailedChunks?: boolean }) {
    this.deps = deps;
    this.dropFailedChunks = options?.dropFailedChunks !== false;
  }

  /** Characters the coordinator would count for this window: user/assistant text, trimmed and capped per turn, context-only turns left out. */
  private windowChars(turns: readonly BufferTurn[]): number {
    let total = 0;
    for (const turn of turns) {
      if ((turn.role !== "user" && turn.role !== "assistant") || turn.extractionContextOnly === true) continue;
      total += turn.content.trim().slice(0, this.deps.config.extractionMaxTurnChars).length;
    }
    return total;
  }

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
   * `preemptHandle`: the queue task's own preemption slot (per task, so two
   * concurrent automatic extractions cannot clobber each other's registration).
   */
  async run(
    turns: BufferTurn[],
    runOptions: DrainRunOptions,
    preemptable = false,
    preemptHandle?: ExtractionPreemptHandle
  ): Promise<ExtractionRunResult> {
    const budgetChars = this.deps.extractionWindowBudgetChars?.() ?? Number.POSITIVE_INFINITY;
    // Exact duplicates (same role AND content, one scope) collapse to their first
    // occurrence before chunk planning (#3443): chunks pack unique turns and the model
    // sees each text once. Every original stays a distinct identity the chunk must
    // account for, so chunks carry the duplicates as marked copies — clearing and
    // drops remove representative and duplicates together.
    const collapsed = collapseExactDuplicateTurns(turns);
    const window = collapsed.duplicateCount > 0 ? markDuplicateTurns(turns, collapsed) : turns;
    const plan = this.chunkPlan(turns, runOptions, budgetChars, collapsed);
    // The tail of a window that already qualified goes through the chunk loop even when it now fits in one
    // chunk, so its failures still count toward the drop threshold.
    if (plan.singleRun) {
      // Without duplicates this is today's single-run path: the run judges its own
      // thresholds on the raw window.
      if (collapsed.duplicateCount === 0) return await this.deps.runExtraction(turns, runOptions);
      // With duplicates, eligibility belongs to the RAW window — duplicate inflation
      // must not change whether a window qualifies (#3443). Below the threshold,
      // today's skip path runs on the raw window (unmarked, so skip/capture/clear
      // judge every identity exactly as before); above it, the representative subset
      // is never re-judged — the same rule the chunk loop applies to chunks.
      if (this.windowBelowThreshold(turns, runOptions)) return await this.deps.runExtraction(turns, runOptions);
      return await this.deps.runExtraction(window, {
        ...runOptions,
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
      });
    }
    // Eligibility (minimum user turns and characters) belongs to the whole
    // window: a window that never qualified keeps the single-run path, which
    // judges it exactly as before.
    if (!plan.resumed && this.windowBelowThreshold(turns, runOptions)) {
      return await this.deps.runExtraction(turns, runOptions);
    }
    // A deduped window is never re-judged on its representative subset inside the
    // run: eligibility above (or the caller's skip flags) already decided it.
    const options =
      collapsed.duplicateCount > 0
        ? { ...runOptions, skipCharThreshold: true, skipUserTurnThreshold: true }
        : runOptions;
    return await this.runChunked(plan.chunks, options, preemptable, preemptHandle);
  }

  /** Chunking plan for one trigger-drain window. Accepted-capture groups
   *  keep their pinned head; a window with duplicates is planned on its
   *  representatives and each chunk is then expanded back to its contiguous
   *  original span with the duplicates marked. */
  private chunkPlan(
    turns: readonly BufferTurn[],
    runOptions: DrainRunOptions,
    budgetChars: number,
    collapsed?: CollapsedDuplicates
  ): ChunkPlan {
    const deduped = collapsed !== undefined && collapsed.duplicateCount > 0;
    const planning = deduped ? collapsed.representatives : turns;
    const repChunks = this.chunkable(runOptions, turns, budgetChars)
      ? this.deps.measureRenderedTurns !== undefined
        ? this.chunkByRenderedSize(planning, budgetChars)
        : chunkExtractionWindow(planning, budgetChars)
      : [];
    const resumed =
      repChunks.length > 0 && this.qualified.get(runOptions.bufferKey) === chunkFingerprint(repChunks[0].slice(0, 1));
    const chunks = deduped ? this.expandedChunks(turns, collapsed, repChunks) : repChunks;
    return { singleRun: chunks.length <= 1 && !resumed, chunks, resumed };
  }

  /** Each representative chunk covers a contiguous span of the original window
   *  (every duplicate sits after its representative): expand it back to that
   *  span with the duplicates marked, so the chunk accounts for every identity. */
  private expandedChunks(
    turns: readonly BufferTurn[],
    collapsed: CollapsedDuplicates,
    repChunks: readonly BufferTurn[][]
  ): BufferTurn[][] {
    const chunks: BufferTurn[][] = [];
    let repIndex = 0;
    for (const repChunk of repChunks) {
      const start = collapsed.representativePositions[repIndex]!;
      repIndex += repChunk.length;
      const end = collapsed.representativePositions[repIndex - 1]! + 1;
      chunks.push(markDuplicateTurns(turns, collapsed, start, end));
    }
    return chunks;
  }

  /** Automatic chunking needs a clearable window, no fail-closed/forced
   *  caller, and a real budget to chunk against. */
  private chunkable(runOptions: DrainRunOptions, turns: readonly BufferTurn[], budgetChars: number): boolean {
    return (
      runOptions.clearBufferAfterExtraction &&
      !runOptions.forceExtractionAttempt &&
      !runOptions.failOnExtractionFailure &&
      this.identityCleared(runOptions, turns) &&
      Number.isFinite(budgetChars) &&
      budgetChars > 0
    );
  }

  /** A native group clears its turns by identity (a pinned capture can sit
   *  in front); a drop must find them the same way. */
  private identityCleared(runOptions: DrainRunOptions, turns: readonly BufferTurn[]): boolean {
    return runOptions.clearMatchingTurns === true || !turns.some((turn) => turn.acceptedCapture === true);
  }

  /** Eligibility (minimum user turns and characters) belongs to the whole
   *  window: a window that never qualified keeps the single-run path, which
   *  judges it exactly as before. */
  private windowBelowThreshold(turns: readonly BufferTurn[], runOptions: DrainRunOptions): boolean {
    const windowUserTurns = turns.filter((turn) => turn.role === "user").length;
    const belowChars = !runOptions.skipCharThreshold && this.windowChars(turns) < this.deps.config.extractionMinChars;
    return (
      (!runOptions.skipUserTurnThreshold && windowUserTurns < this.deps.config.extractionMinUserTurns) || belowChars
    );
  }

  /** The window qualified as a whole; its chunks must not be re-judged one by
   *  one (an assistant-only or short chunk would be cleared unextracted). */
  private async runChunked(
    chunks: readonly BufferTurn[][],
    runOptions: DrainRunOptions,
    preemptable: boolean,
    preemptHandle?: ExtractionPreemptHandle
  ): Promise<ExtractionRunResult> {
    const baseOptions = { ...runOptions, skipCharThreshold: true, skipUserTurnThreshold: true };
    const bufferKey = runOptions.bufferKey;
    // A native group clears its turns by identity (a pinned capture can sit in front); a drop must find them the same way.
    const byIdentity = runOptions.clearMatchingTurns === true;
    const dropAfter = this.deps.config.extractionChunkDropAfterFailures;
    let aggregate: ExtractionRunResult | null = null;
    for (const [position, chunk] of chunks.entries()) {
      this.qualified.set(bufferKey, chunkFingerprint(chunk.slice(0, 1)));
      const { options: chunkOptions, preempt } = this.chunkOptionsFor(
        chunks,
        position,
        baseOptions,
        runOptions,
        preemptable,
        preemptHandle
      );
      const failures = this.failureCount(bufferKey, chunk);
      let result: ExtractionRunResult;
      try {
        result = await this.deps.runExtraction(chunk, chunkOptions);
      } catch (err) {
        this.rethrowChunkAbort(err, preempt, runOptions.abortSignal?.aborted === true);
        // A successfully dropped thrown chunk does not end the drain: later
        // chunks still run this pass (live drop policy).
        aggregate = await this.settleThrownChunk(bufferKey, chunk, failures, dropAfter, err, byIdentity, aggregate);
        continue;
      }
      const settled = this.settleVerdict(bufferKey, chunk, result, aggregate);
      if (settled.action === "continue") {
        aggregate = settled.result;
        continue;
      }
      if (settled.action === "return") return settled.result;
      const failed = await this.settleFailedChunk({
        bufferKey,
        chunk,
        failures,
        dropAfter,
        result: settled.result,
        byIdentity,
        aggregate: settled.aggregate,
      });
      if (failed.action === "continue") {
        aggregate = failed.result;
        continue;
      }
      return failed.result;
    }
    this.qualified.delete(bufferKey);
    return aggregate ?? { status: "skipped", persistedCount: 0, durableOutputCount: 0 };
  }

  /** retention replaces theirs (retained turns do not pile up across chunks) */
  private chunkOptionsFor(
    chunks: readonly BufferTurn[][],
    position: number,
    baseOptions: DrainRunOptions,
    runOptions: DrainRunOptions,
    preemptable: boolean,
    preemptHandle?: ExtractionPreemptHandle
  ): ChunkExecutionOptions {
    let options: DrainRunOptions = { ...baseOptions, retentionWindow: chunks.slice(0, position + 1).flat() };
    let preempt: AbortController | undefined;
    if (preemptable && position > 0) {
      preempt = this.armChunkPreempt(preemptHandle);
      options = {
        ...options,
        abortSignal: runOptions.abortSignal
          ? AbortSignal.any([runOptions.abortSignal, preempt.signal])
          : preempt.signal,
      };
    }
    return { options, preempt };
  }

  /** A chunk-local abort controller so a fail-closed flush can abort the
   *  next chunk instead of waiting behind the whole window. */
  private armChunkPreempt(preemptHandle?: ExtractionPreemptHandle): AbortController {
    const local = new AbortController();
    preemptHandle?.arm(() => local.abort(preemptedExtractionError()));
    return local;
  }

  /** An abort error is rethrown (the chunk-local abort leaves the outer
   *  signal untouched, so the host gets the preemption reason it looks for,
   *  as it does for the first chunk). */
  private rethrowChunkAbort(cause: unknown, preempt: AbortController | undefined, outerAborted: boolean): void {
    if (!isAbortError(cause)) return;
    throw preempt && preempt.signal.aborted && !outerAborted ? preempt.signal.reason : cause;
  }

  /** A chunk whose extraction THREW: count the failure; below the drop
   *  threshold (or on a no-drop drain) rethrow so the window is retained;
   *  at the threshold a chunk that keeps throwing is dropped like one that
   *  keeps failing, so later chunks are not stuck behind it. */
  private async settleThrownChunk(
    bufferKey: string,
    chunk: readonly BufferTurn[],
    failures: number,
    dropAfter: number,
    cause: unknown,
    byIdentity: boolean,
    aggregate: ExtractionRunResult | null
  ): Promise<ExtractionRunResult> {
    failures += 1;
    if (failures < dropAfter || !this.dropFailedChunks) {
      this.setFailureCount(bufferKey, chunk, failures);
      throw cause;
    }
    const thrown: ExtractionRunResult = {
      status: "skipped",
      reason: `thrown: ${describeError(cause)}`,
      persistedCount: 0,
      durableOutputCount: 0,
    };
    if (!(await this.dropFailedChunk(bufferKey, chunk, dropAfter, thrown, byIdentity))) {
      this.setFailureCount(bufferKey, chunk, failures);
      throw cause;
    }
    this.setFailureCount(bufferKey, chunk, 0);
    return mergeDrainResults(aggregate, thrown);
  }

  /** Map one chunk result to the drain-loop action: drained chunks continue
   *  to the next chunk; breaker/backoff retention and provider faults keep
   *  everything for retry without counting a chunk failure. */
  private settleVerdict(
    bufferKey: string,
    chunk: readonly BufferTurn[],
    result: ExtractionRunResult,
    aggregate: ExtractionRunResult | null
  ): ChunkVerdict {
    const verdict = classifyDrainResult(result);
    if (verdict === "drained") {
      this.setFailureCount(bufferKey, chunk, 0);
      return { action: "continue", result: mergeDrainResults(aggregate, result), aggregate };
    }
    // Provider breaker/backoff retention: keep everything for retry.
    if (verdict === "deferred") return { action: "return", result: mergeDrainResults(aggregate, result), aggregate };
    // An outage or a bad key is not the chunk's fault: keep the chunk and do not count toward dropping it.
    if (result.failureClass === "provider_retryable" || result.failureClass === "auth_config") {
      return { action: "return", result: mergeDrainResults(aggregate, result), aggregate };
    }
    return { action: "failed", result, aggregate };
  }

  /** (live drains, recovery copy first) or keep it as durable retryable */
  private async settleFailedChunk(args: {
    bufferKey: string;
    chunk: readonly BufferTurn[];
    failures: number;
    dropAfter: number;
    result: ExtractionRunResult;
    byIdentity: boolean;
    aggregate: ExtractionRunResult | null;
  }): Promise<{ action: "continue" | "return"; result: ExtractionRunResult }> {
    const failures = args.failures + 1;
    if (failures >= args.dropAfter && this.dropFailedChunks) {
      if (!(await this.dropFailedChunk(args.bufferKey, args.chunk, args.dropAfter, args.result, args.byIdentity))) {
        // No recovery copy: keep the only buffered copy and retry later.
        this.setFailureCount(args.bufferKey, args.chunk, failures);
        return { action: "return", result: mergeDrainResults(args.aggregate, args.result) };
      }
      this.setFailureCount(args.bufferKey, args.chunk, 0);
      return { action: "continue", result: mergeDrainResults(args.aggregate, args.result) };
    }
    this.setFailureCount(args.bufferKey, args.chunk, failures);
    return { action: "return", result: mergeDrainResults(args.aggregate, args.result) };
  }

  /** Greedy chunking sized by the RENDERED conversation (the oracle the model */
  private chunkByRenderedSize(turns: readonly BufferTurn[], budgetChars: number): BufferTurn[][] {
    const measure = this.deps.measureRenderedTurns!;
    const chunks: BufferTurn[][] = [];
    let current: BufferTurn[] = [];
    for (const turn of turns) {
      if (current.length > 0 && measure([...current, turn]) > budgetChars) {
        chunks.push(current);
        current = [];
      }
      current.push(turn);
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  /** Side-file copy first (content survives a failed drop), then remove the failing chunk from the buffer. Never throws:
   *  the drop must not fail the extraction task that already settled its result. */
  private async dropFailedChunk(
    bufferKey: string,
    chunk: readonly BufferTurn[],
    dropAfter: number,
    result: ExtractionRunResult,
    byIdentity: boolean
  ): Promise<boolean> {
    const reason =
      `dropped after ${dropAfter} repeated extraction failures ` +
      `(last result: status=${result.status} reason=${result.reason ?? "n/a"})`;
    const copyPath = await this.saveRecoveryCopy(bufferKey, reason, chunk);
    if (copyPath === null) return false;
    log.warn(`buffer[${bufferKey}]: dropping ${chunk.length} turns — ${reason}; copy saved to ${copyPath}`);
    try {
      const dropped = await this.deps.buffer.dropExtractionChunk(bufferKey, chunk, { allowNonPrefix: byIdentity });
      if (dropped > 0) {
        log.warn(`buffer[${bufferKey}]: removed ${dropped} buffered turns — ${reason}`);
        return true;
      }
      // Nothing removed (the live turns changed): the chunk is still buffered, so this is not a drop.
      log.warn(`buffer[${bufferKey}]: dropped chunk no longer matches the buffer; keeping it and its failure count`);
    } catch (err) {
      log.warn(
        `buffer[${bufferKey}]: failed to remove dropped chunk from buffer (will retry next trigger): ${describeError(err)}`
      );
    }
    return false;
  }

  /** The recovery side-file copy for a dropped chunk. null = the copy could
   *  not be written — the caller must keep the only buffered copy. */
  private async saveRecoveryCopy(
    bufferKey: string,
    reason: string,
    chunk: readonly BufferTurn[]
  ): Promise<string | null> {
    try {
      const storage = await this.deps.getStorage();
      return await storage.saveDroppedExtractionChunk(bufferKey, reason, chunk);
    } catch (err) {
      // Never destroy the only buffered copy without a recovery file.
      log.warn(
        `buffer[${bufferKey}]: could not save the dropped-chunk recovery copy; keeping the chunk in the buffer: ${describeError(err)}`
      );
      return null;
    }
  }
}
