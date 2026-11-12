/**
 * Exit-once bookkeeping for a queued extraction task (`onTaskExit`).
 *
 * A task settled (abort, queue deadline) before its closure ever ran has
 * nothing to exit, so `settled()` reports exit at once; a claim-lease owner
 * waiting on the exit is then not held behind an unrelated running extraction.
 * A closure that did start reports exit when it finishes. Either way the
 * callback fires exactly once.
 */
export function createTaskExit(onExit?: () => void) {
  let started = false;
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    onExit?.();
  };
  return {
    start: () => {
      started = true;
    },
    settled: () => {
      if (!started) report();
    },
    report,
  };
}
