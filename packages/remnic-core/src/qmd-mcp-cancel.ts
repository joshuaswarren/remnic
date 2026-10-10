import { abortError } from "./abort-error.js";

/**
 * One in-flight daemon search shared by identical callers.
 * The shared signal aborts only when every waiter has aborted, which is
 * what tells the QMD process to stop. One caller giving up must not cancel
 * a sibling that still wants the result.
 */
export type InflightJoiner<T> = {
  join(key: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

type InflightSlot<T> = {
  controller: AbortController;
  refs: number;
  promise: Promise<T>;
};

export function createInflightJoiner<T>(): InflightJoiner<T> {
  const slots = new Map<string, InflightSlot<T>>();

  return {
    join(key, signal, run) {
      if (signal?.aborted) {
        return Promise.reject(abortError("QMD inflight search aborted"));
      }
      let slot = slots.get(key);
      if (!slot) {
        const controller = new AbortController();
        const created: InflightSlot<T> = {
          controller,
          refs: 0,
          promise: Promise.resolve() as Promise<T>,
        };
        slots.set(key, created);
        created.promise = new Promise<T>((resolve, reject) => {
          try {
            resolve(run(controller.signal));
          } catch (err) {
            reject(err);
          }
        }).finally(() => {
          if (slots.get(key) === created) slots.delete(key);
        });
        // A cancel with no remaining waiter rejects this promise after the
        // waiter has already settled. Swallow that so it is not unhandled.
        created.promise.catch(() => {});
        slot = created;
      }
      return attachWaiter(slot, signal);
    },
  };
}

function attachWaiter<T>(slot: InflightSlot<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(abortError("QMD inflight search aborted"));
  }
  slot.refs += 1;
  let settled = false;

  return new Promise<T>((resolve, reject) => {
    const finish = (abortShared: boolean, settle: () => void) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      slot.refs -= 1;
      if (slot.refs < 0) slot.refs = 0;
      if (abortShared && slot.refs === 0) {
        slot.controller.abort();
      }
      settle();
    };
    const onAbort = () => {
      finish(true, () => reject(abortError("QMD inflight search aborted")));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
    slot.promise.then(
      (value) => finish(false, () => resolve(value)),
      (err) => finish(false, () => reject(err))
    );
  });
}

/**
 * Score documents on a shared cursor and stop between documents when
 * `signal` aborts. In-flight `rankIndex` calls finish; later indexes
 * are not started. A cancelled batch throws and does not return scores.
 *
 * `docs/patches/qmd-2.5.3-mcp-cancel.patch` uses the same loop inside
 * QMD's reranker. `rank()` and `rankAll()` share one evaluate path, so
 * a document that finishes has the same score either way.
 */
export async function rankDocumentsUntilAbortParallel<T>(
  count: number,
  parallelism: number,
  signal: AbortSignal | undefined,
  rankIndex: (index: number) => Promise<T>
): Promise<T[]> {
  if (signal?.aborted) {
    throw abortError("qmd rerank aborted");
  }
  if (count <= 0) return [];
  const scores = new Array<T>(count);
  let cursor = 0;
  const workers = Math.max(1, Math.min(Math.floor(parallelism) || 1, count));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        if (signal?.aborted) return;
        const index = cursor++;
        if (index >= count) return;
        scores[index] = await rankIndex(index);
      }
    })
  );
  if (signal?.aborted) {
    throw abortError("qmd rerank aborted");
  }
  return scores;
}
