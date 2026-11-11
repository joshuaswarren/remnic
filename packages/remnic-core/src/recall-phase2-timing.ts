/**
 * Phase-2 await timing fields for the recall-timings attempt record (issue
 * #1830). Each instrumented phase-2 await contributes three optionally-named
 * fields: `phase2<Name>Ms` (monotonic elapsed of the await itself),
 * `phase2<Name>Status` (ok | timeout | error | skipped), and — for promises
 * started earlier in phase 1 and awaited later — `phase2<Name>TotalMs`
 * (monotonic time since the promise was created). The await fields are
 * OVERLAPPING, not additive: awaits of promises started earlier include time
 * spent doing other phase-2 work.
 */

export type Phase2AwaitStatus = "ok" | "timeout" | "error" | "skipped";

export const PHASE2_AWAIT_NAMES = [
  "Harmonic",
  "GraphSnapshot",
  "IntentSnapshot",
  "Compression",
  "Compounding",
  "Questions",
  "Prefilter",
] as const;

export type Phase2AwaitName = (typeof PHASE2_AWAIT_NAMES)[number];

/** Awaits of promises started earlier in phase 1; their await time overlaps earlier work. */
export const PHASE2_AWAIT_TOTAL_NAMES: readonly Phase2AwaitName[] = [
  "Harmonic",
  "Compounding",
  "Prefilter",
];

export const PHASE2_AWAIT_STATUSES: readonly Phase2AwaitStatus[] = [
  "ok",
  "timeout",
  "error",
  "skipped",
];

export function phase2MsField(name: Phase2AwaitName): string {
  return `phase2${name}Ms`;
}

export function phase2StatusField(name: Phase2AwaitName): string {
  return `phase2${name}Status`;
}

export function phase2TotalField(name: Phase2AwaitName): string {
  return `phase2${name}TotalMs`;
}

export interface Phase2AwaitTiming {
  status: Phase2AwaitStatus;
  /** Monotonic elapsed ms of the await itself (measured at the await site). */
  ms: number;
  /** Monotonic ms since the awaited promise was created (started-earlier awaits only). */
  totalMs?: number;
}

/** Fold one await's timing into the recall pipeline's flat timing payload. Values stay string-encoded ("12ms") so the recall-timings sanitizer parses them like every other phase. */
export function recordPhase2Await(
  sink: Record<string, string>,
  name: Phase2AwaitName,
  timing: Phase2AwaitTiming,
): void {
  sink[phase2MsField(name)] = `${Math.max(0, Math.round(timing.ms))}ms`;
  sink[phase2StatusField(name)] = timing.status;
  if (timing.totalMs !== undefined) {
    sink[phase2TotalField(name)] = `${Math.max(0, Math.round(timing.totalMs))}ms`;
  }
}

export interface Phase2Timer {
  /** Time one direct phase-2 await. A throw is re-thrown unchanged after its status is recorded. */
  step<T>(name: Phase2AwaitName, run: () => Promise<T>): Promise<T>;
  /** Record a phase-2 await that did not run (section disabled): 0 ms, status skipped. */
  skipped(name: Phase2AwaitName): void;
  /**
   * Time one await of an enrichment promise started earlier (`startedMs` is its
   * performance.now() creation time). `run` reports the await's own outcome
   * through `onStatus`; `isSkipped` is read after the await so a section that
   * skipped itself (disabled / limit 0) is recorded as skipped, not ok.
   */
  enrichment<T>(
    name: Phase2AwaitName,
    startedMs: number,
    isSkipped: () => boolean,
    run: (onStatus: (status: Phase2AwaitStatus) => void) => Promise<T>,
  ): Promise<T>;
}

/** Per-recall phase-2 await timer; all durations are performance.now() deltas, never wall clock. */
export function createPhase2Timer(
  sink: Record<string, string>,
  isAborted: () => boolean,
): Phase2Timer {
  return {
    async step<T>(name: Phase2AwaitName, run: () => Promise<T>): Promise<T> {
      const awaitStartMs = performance.now();
      try {
        const value = await run();
        recordPhase2Await(sink, name, { status: "ok", ms: performance.now() - awaitStartMs });
        return value;
      } catch (err) {
        recordPhase2Await(sink, name, {
          status: isAborted() ? "skipped" : "error",
          ms: performance.now() - awaitStartMs,
        });
        throw err;
      }
    },
    skipped(name: Phase2AwaitName): void {
      recordPhase2Await(sink, name, { status: "skipped", ms: 0 });
    },
    async enrichment<T>(
      name: Phase2AwaitName,
      startedMs: number,
      isSkipped: () => boolean,
      run: (onStatus: (status: Phase2AwaitStatus) => void) => Promise<T>,
    ): Promise<T> {
      const awaitStartMs = performance.now();
      const reported: Phase2AwaitStatus[] = [];
      let threw = false;
      try {
        return await run((status) => {
          reported.push(status);
        });
      } catch (err) {
        threw = true;
        throw err;
      } finally {
        const nowMs = performance.now();
        const status: Phase2AwaitStatus = threw
          ? (isAborted() ? "skipped" : "error")
          : (reported.at(-1) ?? "ok");
        recordPhase2Await(
          sink,
          name,
          status === "ok" && isSkipped()
            ? { status: "skipped", ms: 0, totalMs: 0 }
            : { status, ms: nowMs - awaitStartMs, totalMs: nowMs - startedMs },
        );
      }
    },
  };
}
