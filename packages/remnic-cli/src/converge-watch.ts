/**
 * Scheduled replication loop for `remnic converge watch` — the cadence half
 * of the #2150 convergence story. Kept in a sibling module so converge.ts
 * stays under the #1995 new-file LOC ratchet.
 */

import type { ConvergeApplyOptions, ConvergeApplyResult } from "./converge.js";

export interface ConvergeWatchOptions extends ConvergeApplyOptions {
  /** Delay between cycles. Clamped to >= 1000ms so a bad flag cannot hot-loop. Default 300000 (mirrors replicaPeers.pollIntervalMs). */
  intervalMs?: number;
  /** Stop after N cycles (tests / one-shot scheduling). Undefined = run until aborted. */
  maxCycles?: number;
  /** Abort signal (SIGINT/SIGTERM) — stops after the current cycle completes. */
  signal?: AbortSignal;
  /**
   * The applier invoked each cycle. Required — the CLI passes
   * `executeConvergeApply`; tests inject a fake. Passing it (rather than
   * importing it here) keeps this module free of an import cycle with
   * converge.ts.
   */
  apply: (options: ConvergeApplyOptions) => Promise<ConvergeApplyResult>;
  /** Per-cycle observer (structured logging / metrics). */
  onCycle?: (cycle: number, outcome: { result?: ConvergeApplyResult; error?: unknown }) => void;
}

export interface ConvergeWatchOutcome {
  cycles: number;
  convergedCycles: number;
  appliedCycles: number;
  failedCycles: number;
  lastStatus: ConvergeApplyResult["status"] | "error" | "aborted";
}

const CONVERGE_WATCH_MIN_INTERVAL_MS = 1000;
const CONVERGE_WATCH_DEFAULT_INTERVAL_MS = 300_000;

function sleepAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run bidirectional convergence on an interval so an active/backup pair
 * converges continuously instead of only when an operator remembers to run
 * `converge apply`. A failed cycle (peer down, transient network error)
 * reports and does NOT stop the watch — a peer being unreachable is exactly
 * when the surviving side most needs to keep the schedule. `lastStatus`
 * stays "aborted" only when no cycle ever ran; otherwise it holds the most
 * recent real outcome.
 */
export async function convergeWatch(options: ConvergeWatchOptions): Promise<ConvergeWatchOutcome> {
  const intervalMs = Math.max(
    CONVERGE_WATCH_MIN_INTERVAL_MS,
    options.intervalMs ?? CONVERGE_WATCH_DEFAULT_INTERVAL_MS,
  );
  const {
    apply,
    intervalMs: _intervalMs,
    maxCycles,
    onCycle,
    signal,
    ...applyOptions
  } = options;

  const outcome: ConvergeWatchOutcome = {
    cycles: 0,
    convergedCycles: 0,
    appliedCycles: 0,
    failedCycles: 0,
    lastStatus: "aborted",
  };

  while (maxCycles === undefined || outcome.cycles < maxCycles) {
    if (signal?.aborted) break;
    try {
      const result = await apply(applyOptions);
      outcome.cycles += 1;
      if (result.converged) outcome.convergedCycles += 1;
      else outcome.appliedCycles += 1;
      outcome.lastStatus = result.status;
      onCycle?.(outcome.cycles, { result });
    } catch (err) {
      outcome.cycles += 1;
      outcome.failedCycles += 1;
      outcome.lastStatus = "error";
      onCycle?.(outcome.cycles, { error: err });
    }
    if (maxCycles !== undefined && outcome.cycles >= maxCycles) break;
    const slept = await sleepAborted(intervalMs, signal ?? new AbortController().signal);
    if (!slept) break;
  }
  return outcome;
}
