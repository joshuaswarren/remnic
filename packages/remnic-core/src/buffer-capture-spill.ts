/**
 * Durable spill queue for SmartBuffer's entry-cap refusal (#3303): when the
 * buffer is at its session-entry cap, a refused live capture is appended to
 * `state.spillQueue` (persisted via a whole-state save) instead of being
 * dropped, and is admitted back FIFO once capacity frees. Extracted from
 * buffer.ts to keep the buffer class under its file-size cap.
 */
import type { AddTurnMutationResult, SmartBuffer } from "./buffer.js";
import type { BufferEntryState, BufferState, BufferTurn } from "./types.js";

export interface AddTurnOutcome {
  decision: "extract_now" | "extract_batch" | "keep_buffering";
  extractionTurns?: BufferTurn[];
  /** Set when the turn was spilled to the durable spill queue instead of admitted (#3303). */
  spilled?: boolean;
}

/**
 * Thrown when a durable capture cannot be admitted for a reason that is NOT
 * capacity pressure (capacity itself spills, #3303). Lives here so the
 * ingestion spill path and its consumers share one definition.
 */
export class ReplayAdmissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayAdmissionRefusedError";
  }
}

/** Everything the spill/drain needs from the SmartBuffer instance. */
export interface CaptureSpillPort {
  state: BufferState;
  maxEntryCount: number;
  enqueueMutation<T>(op: () => Promise<T>): Promise<T>;
  loadUnlocked(): Promise<void>;
  makeRoomForEntryUnlocked(): void;
  peekEntry(bufferKey: string): BufferEntryState | null;
  recordTurnUnlocked(bufferKey: string, turn: BufferTurn): Promise<AddTurnMutationResult>;
  markDirty(bufferKey: string): void;
  completeAddTurnOutcome(
    bufferKey: string,
    turn: BufferTurn,
    mutation: AddTurnMutationResult,
  ): Promise<AddTurnOutcome>;
  saveWholeState(): Promise<void>;
}

/**
 * Spill a capture refused at the session-entry cap. Returns the spilled
 * outcome: the buffered observe returns normally instead of throwing
 * `ReplayAdmissionRefusedError`, so live capture is never dropped while the
 * single extraction worker is busy on a backlog doc. The whole-state save is
 * required here: the per-session path cannot persist a state-level queue.
 * Rare event, bounded cost.
 */
export async function spillCapturedTurn(
  port: CaptureSpillPort,
  bufferKey: string,
  turn: BufferTurn,
): Promise<AddTurnOutcome> {
  port.state.spillQueue = [...(port.state.spillQueue ?? []), { bufferKey, turn }];
  await port.saveWholeState();
  return { decision: "keep_buffering", spilled: true };
}

/**
 * Admit spilled turns (FIFO) while capacity allows; returns the outcomes of
 * the admitted turns so the caller can queue their extraction. A turn whose
 * session entry already exists is always admissible (no new slot needed); a
 * new session waits for a free slot. The shrunken queue is written with a
 * whole-state save for the same reason as the spill.
 */
export async function drainCaptureSpill(
  port: CaptureSpillPort,
): Promise<Array<{ bufferKey: string; outcome: AddTurnOutcome }>> {
  const admitted: Array<{ bufferKey: string; turn: BufferTurn; mutation: AddTurnMutationResult }> = [];
  await port.enqueueMutation(async () => {
    await port.loadUnlocked();
    const queue = port.state.spillQueue;
    if (!queue?.length) return;
    port.makeRoomForEntryUnlocked();
    while (queue.length > 0) {
      const item = queue[0];
      if (
        port.peekEntry(item.bufferKey) === null &&
        Object.keys(port.state.entries ?? {}).length >= port.maxEntryCount
      ) {
        break;
      }
      const mutation = await port.recordTurnUnlocked(item.bufferKey, item.turn);
      port.markDirty(item.bufferKey);
      admitted.push({ bufferKey: item.bufferKey, turn: item.turn, mutation });
      queue.shift();
    }
    if (queue.length === 0) delete port.state.spillQueue;
    else port.state.spillQueue = queue;
    await port.saveWholeState();
  });
  return Promise.all(
    admitted.map(async ({ bufferKey, turn, mutation }) => ({
      bufferKey,
      outcome: await port.completeAddTurnOutcome(bufferKey, turn, mutation),
    })),
  );
}

/**
 * Drain the capture spill and queue extraction for the admitted turns (#3303).
 * Fail-open: a failed drain leaves the spill durable for the next ingest.
 */
export async function drainCaptureSpillForIngestion(
  buffer: Pick<SmartBuffer, "drainCaptureSpill">,
  queueExtraction: (extractionTurns: BufferTurn[], bufferKey: string) => void,
  context: string,
): Promise<void> {
  try {
    const drained = await buffer.drainCaptureSpill();
    for (const item of drained) {
      if (item.outcome.extractionTurns?.length) {
        queueExtraction(item.outcome.extractionTurns, item.bufferKey);
      }
    }
  } catch {
    // Kept for retry: the spill stays durable.
  }
}
