import { abortError, isAbortError } from "./abort-error.js";
import { log, type LoggerBackend } from "./logger.js";

export function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

export type RecallSectionPriority = "core" | "enrichment";
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

const CORE_SECTION_MAX_SHARE_OF_REQUEST = 0.8;

/**
 * Epoch-ms floor separating the two `deadlineMs` readings: anything at or
 * above it is an absolute timestamp, anything below is a relative budget —
 * the convention force-flush established (issue #3140).
 */
const CLIENT_DEADLINE_EPOCH_FLOOR_MS = 1e11;

/**
 * The client's own deadline for this request, as an absolute timestamp —
 * or null when the request carries no usable value (issue #3499).
 *
 * Garbage (NaN, infinite, negative) is ignored rather than rejected: a
 * malformed hint must never cost the caller its recall.  Values under the
 * epoch floor are a relative budget from `now`, matching force-flush.
 */
export function resolveClientDeadlineAtMs(
  deadlineMs: number | undefined,
  now: number,
): number | null {
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs) || deadlineMs < 0) {
    return null;
  }
  return deadlineMs > CLIENT_DEADLINE_EPOCH_FLOOR_MS ? deadlineMs : now + deadlineMs;
}

// Node clamps timer delays to 2^31-1 ms (~24.8 days) and a larger delay
// overflows to an immediate fire — every client-deadline timer must clamp
// or a far-future budget aborts a healthy call at once (issue #3499).
const CLIENT_DEADLINE_TIMER_MAX_MS = 2_147_483_647;

export function clientDeadlineTimerMs(clientDeadlineAtMs: number, now: number): number {
  // Floor before clamping: a fractional deadlineMs produces a fractional
  // delay, which AbortSignal.timeout rejects with ERR_OUT_OF_RANGE — flooring
  // also keeps the abort at or before the deadline (#3514 review).
  return Math.max(1, Math.min(Math.floor(clientDeadlineAtMs - now), CLIENT_DEADLINE_TIMER_MAX_MS));
}

export function recallDeadlineSignal(
  baseSignal: AbortSignal | undefined,
  deadlineMs: number | undefined,
  now = Date.now(),
): AbortSignal | undefined {
  const deadlineAtMs = resolveClientDeadlineAtMs(deadlineMs, now);
  if (deadlineAtMs === null) return baseSignal;
  const deadlineSignal =
    deadlineAtMs <= now
      ? AbortSignal.abort()
      : AbortSignal.timeout(clientDeadlineTimerMs(deadlineAtMs, now));
  return baseSignal === undefined ? deadlineSignal : AbortSignal.any([baseSignal, deadlineSignal]);
}

/**
 * Effective outer deadline for a recall: the configured ceiling capped by
 * the client's own deadline when the request carries one (issue #3499).
 *
 * A client deadline that has already passed yields a deadline in the past —
 * sections then see a non-positive remainder and degrade immediately, which
 * is the fast-degraded-recall contract, never a request rejection.  `null`
 * means the request is genuinely unbounded (no configured ceiling AND no
 * client deadline).
 */
export function resolveRecallOuterDeadlineAtMs(options: {
  recallStart: number;
  recallOuterTimeoutMs: number;
  clientDeadlineMs?: number;
}): number | null {
  const configured =
    options.recallOuterTimeoutMs > 0
      ? options.recallStart + options.recallOuterTimeoutMs
      : null;
  const client = resolveClientDeadlineAtMs(options.clientDeadlineMs, options.recallStart);
  if (client === null) return configured;
  return configured === null ? client : Math.min(configured, client);
}

export function resolveRecallCoreSectionDeadlineMs(options: {
  configuredCoreDeadlineMs: number;
  remainingOuterMs: number | null;
}): number {
  const configured = options.configuredCoreDeadlineMs;
  if (!Number.isFinite(configured) || configured <= 0) return configured;
  const remaining = options.remainingOuterMs;
  if (remaining === null || !Number.isFinite(remaining)) return configured;
  if (remaining <= 0) return 1;
  return Math.min(
    configured,
    Math.max(1, Math.floor(remaining * CORE_SECTION_MAX_SHARE_OF_REQUEST)),
  );
}

export interface RecallSectionDeadlineOutcome<T> {
  /** The section's value, or `fallback` when the deadline was exceeded. */
  value: T;
  timedOut: boolean;
  durationMs: number;
}

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
    const work = options.run(controller.signal).then(
      (value) => ({ kind: "value" as const, value }),
    );
    if (!bounded) {
      const settled = await work;
      return { value: settled.value, timedOut: false, durationMs: now() - startedAtMs };
    }
    const deadline = Promise.withResolvers<{ kind: "timeout" }>();
    timer = setTimeout(() => deadline.resolve({ kind: "timeout" }), options.deadlineMs);
    const settled = await Promise.race([work, deadline.promise]);
    if (settled.kind === "timeout") {
      controller.abort(abortError("recall section deadline exceeded"));
      void work.catch(() => {});
      return { value: options.fallback, timedOut: true, durationMs: now() - startedAtMs };
    }
    return { value: settled.value, timedOut: false, durationMs: now() - startedAtMs };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function createBoundedCoreSectionRunner(options: {
  configuredDeadlineMs: number;
  /** Absolute time the whole request is aborted, or null when unbounded. */
  outerDeadlineAtMs: number | null;
  parentSignal?: AbortSignal;
  record: (metric: RecallSectionMetric) => unknown;
  logger?: Pick<LoggerBackend, "warn">;
  now?: () => number;
}): <T>(
  section: string,
  fallback: T,
  run: (sectionSignal: AbortSignal) => Promise<T>,
) => Promise<T> {
  const logger = options.logger ?? log;
  const now = options.now ?? Date.now;
  return async <T>(
    section: string,
    fallback: T,
    run: (sectionSignal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const startedAtMs = now();
    const deadlineMs = resolveRecallCoreSectionDeadlineMs({
      configuredCoreDeadlineMs: options.configuredDeadlineMs,
      remainingOuterMs:
        options.outerDeadlineAtMs === null ? null : options.outerDeadlineAtMs - startedAtMs,
    });
    let outcome: RecallSectionDeadlineOutcome<T>;
    try {
      outcome = await runRecallSectionWithinDeadline({
        deadlineMs,
        fallback,
        parentSignal: options.parentSignal,
        run,
        now,
      });
    } catch (err) {
      if (!isAbortError(err)) throw err;
      const durationMs = now() - startedAtMs;
      options.record({
        section,
        priority: "core",
        durationMs,
        deadlineMs,
        source: "skip",
        success: false,
        timing: `cancelled(${durationMs}ms)`,
      });
      return fallback;
    }
    if (outcome.timedOut) {
      logger.warn(
        `recall section [${section}] exceeded its ${deadlineMs}ms core deadline ` +
          `after ${outcome.durationMs}ms; recall continues without it`,
      );
    }
    options.record({
      section,
      priority: "core",
      durationMs: outcome.durationMs,
      deadlineMs,
      source: outcome.timedOut ? "timeout" : "fresh",
      success: !outcome.timedOut,
    });
    return outcome.value;
  };
}