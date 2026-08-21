import { abortError, throwIfAborted } from "../abort-error.js";

export interface AtomicCaptureState<TSnapshot> {
  read(): TSnapshot | null;
  clear(): void;
  restore(snapshot: TSnapshot | null): void;
}

export interface AtomicCaptureResult<TResult, TSnapshot> {
  result: TResult;
  snapshot: TSnapshot | null;
  recallStartedAt: number;
}

/** Per-owner abortable FIFO for operations that publish through one mutable slot. */
export class XrayCaptureQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<TResult, TSnapshot>(
    operation: () => Promise<TResult>,
    state: AtomicCaptureState<TSnapshot>,
    signal?: AbortSignal,
  ): Promise<AtomicCaptureResult<TResult, TSnapshot>> {
    throwIfAborted(signal, "x-ray capture aborted before queueing");
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await this.waitForTurn(previous, signal);
    } catch (error) {
      // Keep this abandoned node as a barrier until its predecessor settles,
      // so later callers cannot overtake the still-active operation.
      void previous.then(release, release);
      throw error;
    }

    let previousSnapshot: TSnapshot | null = null;
    let didReadPreviousSnapshot = false;
    try {
      previousSnapshot = state.read();
      didReadPreviousSnapshot = true;
      const recallStartedAt = Date.now();
      state.clear();
      const result = await operation();
      const snapshot = state.read();
      if (!snapshot) state.restore(previousSnapshot);
      return { result, snapshot, recallStartedAt };
    } catch (error) {
      if (didReadPreviousSnapshot) state.restore(previousSnapshot);
      throw error;
    } finally {
      release();
    }
  }

  private async waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "x-ray capture aborted while queued");
    if (!signal) {
      await previous;
      return;
    }

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError("x-ray capture aborted while queued"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([previous, aborted]);
      throwIfAborted(signal, "x-ray capture aborted while queued");
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}
