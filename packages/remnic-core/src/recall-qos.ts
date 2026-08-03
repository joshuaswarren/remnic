import { abortError, isAbortError } from "./abort-error.js";
import { log, type LoggerBackend } from "./logger.js";

/**
 * Hand the event loop one macrotask.
 *
 * A recall section deadline is a timer, and a timer cannot fire while a
 * synchronous scan holds the loop — so a provider that iterates the whole corpus
 * must call this periodically or its budget is unenforceable (issue #2291).
 * `setImmediate` (check phase) is used rather than a `0ms` timer so the yield
 * cannot be starved by the timer queue it exists to let run.
 */
export function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

export type RecallSectionPriority = "core" | "enrichment";
/**
 * `timeout` records a section that started, exceeded its deadline, and was
 * degraded to its neutral value (issue #2291).  It is distinct from `skip`
 * (never ran: disabled or zero-limit) so operators can tell a configuration
 * choice from a budget breach in the section metric log.
 */
export type RecallSectionSource = "fresh" | "stale" | "skip" | "timeout";

export interface RecallSectionMetric {
  section: string;
  priority: RecallSectionPriority;
  durationMs: number;
  deadlineMs: number;
  source: RecallSectionSource;
  success: boolean;
  timing?: string;
}

export interface RecallSectionMetricLog {
  message: string;
  payload: {
    section: string;
    priority: RecallSectionPriority;
    durationMs: number;
    deadlineMs: number;
    source: RecallSectionSource;
    success: boolean;
  };
  level: "info" | "debug";
  timing: string;
}

function defaultTiming(metric: RecallSectionMetric): string {
  if (typeof metric.timing === "string" && metric.timing.length > 0) {
    return metric.timing;
  }
  if (metric.source === "timeout") {
    return `timeout(${Math.max(0, Math.round(metric.durationMs))}ms)`;
  }
  if (metric.source === "skip") {
    return "skip";
  }
  return `${Math.max(0, Math.round(metric.durationMs))}ms`;
}

export function formatRecallSectionMetric(metric: RecallSectionMetric): RecallSectionMetricLog {
  const payload = {
    section: metric.section,
    priority: metric.priority,
    durationMs: metric.durationMs,
    deadlineMs: metric.deadlineMs,
    source: metric.source,
    success: metric.success,
  };
  return {
    message: "recall section metric",
    payload,
    level: metric.priority === "core" && metric.success && metric.source !== "skip" ? "info" : "debug",
    timing: defaultTiming(metric),
  };
}

export function createRecallSectionMetricRecorder(options: {
  timings?: Record<string, string>;
  logger?: Pick<LoggerBackend, "info" | "debug">;
} = {}) {
  const logger = options.logger ?? log;
  return (metric: RecallSectionMetric): RecallSectionMetricLog => {
    const entry = formatRecallSectionMetric(metric);
    if (options.timings) {
      options.timings[metric.section] = entry.timing;
    }
    if (entry.level === "info") {
      if (typeof logger.info === "function") {
        logger.info(entry.message, entry.payload);
      } else {
        log.info(entry.message, entry.payload);
      }
    } else {
      if (typeof logger.debug === "function") {
        logger.debug(entry.message, entry.payload);
      } else {
        log.debug(entry.message, entry.payload);
      }
    }
    return entry;
  };
}

/**
 * Fraction of a whole recall request that a single core section may consume.
 * The remainder is what makes degradation possible at all: time to assemble and
 * return the sections that did arrive before the outer timeout kills the request.
 */
const CORE_SECTION_MAX_SHARE_OF_REQUEST = 0.8;

/**
 * Effective per-section deadline for optional core recall providers.
 *
 * `recallCoreDeadlineMs` and `recallOuterTimeoutMs` both default to 75s, so a
 * section budget taken at face value can never fire before the request ceiling
 * that cancels everything — the caller loses the whole recall rather than one
 * section (issue #2291).  Capping the section at a share of the request keeps
 * graceful degradation reachable on default config, while an operator who lowers
 * `recallCoreDeadlineMs` still gets exactly what they asked for.
 *
 * A zero/non-finite value on either side means "no bound" for that side and is
 * preserved, per the config contract that a zero budget disables the limit.
 */
export function resolveRecallCoreSectionDeadlineMs(options: {
  configuredCoreDeadlineMs: number;
  outerTimeoutMs: number;
}): number {
  const configured = options.configuredCoreDeadlineMs;
  if (!Number.isFinite(configured) || configured <= 0) return configured;
  const outer = options.outerTimeoutMs;
  if (!Number.isFinite(outer) || outer <= 0) return configured;
  return Math.min(configured, Math.floor(outer * CORE_SECTION_MAX_SHARE_OF_REQUEST));
}

export interface RecallSectionDeadlineOutcome<T> {
  /** The section's value, or `fallback` when the deadline was exceeded. */
  value: T;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run one recall section under a deadline, degrading to `fallback` instead of
 * blocking the phase it belongs to (issue #2291).
 *
 * Before this existed, `deadlineMs` was recorded in the section metric but
 * never enforced for core sections: a provider doing a multi-minute scan on a
 * slow filesystem blocked the whole phase-one `Promise.all`, and kept scanning
 * after the caller aborted.  Two guarantees fix that:
 *
 *  1. The returned promise settles within `deadlineMs`, with `timedOut: true`
 *     and the caller's neutral value, so one slow optional provider degrades
 *     independently rather than holding the response.
 *  2. `run` receives a signal that fires on the deadline AND on the caller's
 *     abort, so the section can stop its own work at its next checkpoint.
 *
 * `deadlineMs <= 0` (or non-finite) means unbounded, matching the config
 * contract that a zero budget disables the limit.  The section signal is still
 * created and still tracks the parent, so cancellation propagates either way.
 */
export async function runRecallSectionWithinDeadline<T>(options: {
  deadlineMs: number;
  fallback: T;
  parentSignal?: AbortSignal;
  run: (sectionSignal: AbortSignal) => Promise<T>;
  now?: () => number;
}): Promise<RecallSectionDeadlineOutcome<T>> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const controller = new AbortController();
  const parentSignal = options.parentSignal;
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const bounded = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0;
  let timer: NodeJS.Timeout | undefined;

  try {
    // Wrap in a tagged result rather than racing raw values against a sentinel:
    // T is caller-chosen and must never be mistaken for the timeout marker.
    const work = options.run(controller.signal).then(
      (value) => ({ kind: "value" as const, value }),
    );
    if (!bounded) {
      const settled = await work;
      return { value: settled.value, timedOut: false, durationMs: now() - startedAtMs };
    }
    const deadline = Promise.withResolvers<{ kind: "timeout" }>();
    // Deliberately NOT unref'd: the caller is awaiting this bound, so the timer
    // must keep the loop alive until it fires or `finally` clears it.
    timer = setTimeout(() => deadline.resolve({ kind: "timeout" }), options.deadlineMs);
    const settled = await Promise.race([work, deadline.promise]);
    if (settled.kind === "timeout") {
      controller.abort(abortError("recall section deadline exceeded"));
      // The abandoned work outlives this call; swallow its settlement so a
      // late rejection is not reported as unhandled.
      void work.catch(() => {});
      return { value: options.fallback, timedOut: true, durationMs: now() - startedAtMs };
    }
    return { value: settled.value, timedOut: false, durationMs: now() - startedAtMs };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Runs one *optional* core recall section, bounded and accounted for.
 *
 * Binds a section's deadline, the caller's abort signal, and the QoS recorder
 * once so each provider is one call (issue #2291).  A breach degrades the
 * section to `fallback`, warns with the section name and budget, and records the
 * section as `timeout` — so a slow provider costs its own section, not the
 * response.
 *
 * Cancellation degrades too, and must: the section signal fires on the caller's
 * abort, and the phase this section belongs to is awaited through a race that the
 * caller's abort also wins.  A rejection here would therefore land on a promise
 * nobody is awaiting any more — an unhandled rejection rather than a signal.  The
 * caller learns of its own abort from that race, not from a section result.
 *
 * Only sections whose absence leaves recall coherent belong here: the fallback
 * IS the degraded contract.
 */
export function createBoundedCoreSectionRunner(options: {
  deadlineMs: number;
  parentSignal?: AbortSignal;
  record: (metric: RecallSectionMetric) => unknown;
  logger?: Pick<LoggerBackend, "warn">;
}): <T>(
  section: string,
  fallback: T,
  run: (sectionSignal: AbortSignal) => Promise<T>,
) => Promise<T> {
  const logger = options.logger ?? log;
  return async <T>(
    section: string,
    fallback: T,
    run: (sectionSignal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const startedAtMs = Date.now();
    let outcome: RecallSectionDeadlineOutcome<T>;
    try {
      outcome = await runRecallSectionWithinDeadline({
        deadlineMs: options.deadlineMs,
        fallback,
        parentSignal: options.parentSignal,
        run,
      });
    } catch (err) {
      if (!isAbortError(err)) throw err;
      const durationMs = Date.now() - startedAtMs;
      options.record({
        section,
        priority: "core",
        durationMs,
        deadlineMs: options.deadlineMs,
        source: "skip",
        success: false,
        timing: `cancelled(${durationMs}ms)`,
      });
      return fallback;
    }
    if (outcome.timedOut) {
      logger.warn(
        `recall section [${section}] exceeded its ${options.deadlineMs}ms core deadline ` +
          `after ${outcome.durationMs}ms; recall continues without it`,
      );
    }
    options.record({
      section,
      priority: "core",
      durationMs: outcome.durationMs,
      deadlineMs: options.deadlineMs,
      source: outcome.timedOut ? "timeout" : "fresh",
      success: !outcome.timedOut,
    });
    return outcome.value;
  };
}