import type { PluginConfig } from "./types.js";

export type RecallTimingOutcome = "ok" | "error";

/**
 * Flat per-phase timing payload the recall pipeline emits (recall-timings
 * attempt contract). `timestamp`/`namespace` are required; every other key is
 * a phase or dimension the recall-timings sanitizer already knows how to
 * parse (string durations like "12ms", plus `recallPlan`/`queryPolicy`).
 */
export type RecallTimingEmission = {
  timestamp: string;
  namespace: string;
} & Record<string, string>;

export interface RecallTimingRecord {
  readonly timestamp: string;
  readonly namespace: string;
  readonly recallPlan: string;
  readonly queryPolicy: string;
  /** Server-generated id for the recall attempt; never caller-supplied input. */
  readonly requestId: string;
  readonly outcome: RecallTimingOutcome;
  /** Monotonic (performance.now) total for the whole recall attempt, in ms. */
  readonly httpTotalMs: number;
  readonly timingsMs: Readonly<Record<string, number>>;
}

export interface RecallTimingStatus {
  readonly generatedAt: string;
  readonly processStartedAt: string;
  readonly capacity: number;
  readonly count: number;
  readonly order: "newest-first";
  readonly records: RecallTimingRecord[];
}

const RECALL_TIMING_HISTORY_LIMIT = 50;
const TIMING_FIELD_ALLOWLIST = [
  "total",
  "sharedCtx",
  "profile",
  "peerProfile",
  "identityContinuity",
  "entityRetrieval",
  "ki",
  "artifacts",
  "objectiveState",
  "causalTrajectories",
  "cmcCausalChains",
  "calibrationRules",
  "trustZones",
  "harmonicRetrieval",
  "verifiedRecall",
  "verifiedRules",
  "workProducts",
  "qmd",
  "transcript",
  "summaries",
  "nativeKnowledge",
  "convRecall",
  "compounding",
  "graphShadow",
  "qmdPost",
  "trustStage",
  "queueWaitMs",
] as const;
// The ring buffer is process-local: a daemon restart or haproxy failover to
// the other backend starts an empty history. processStartedAt lets consumers
// detect that discontinuity. Derived from the process time origin, not module
// initialization, so lazy imports cannot skew it.
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
const histories = new WeakMap<PluginConfig, RecallTimingRecord[]>();

function numericMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)ms/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function sanitizeRecallTiming(
  input: Record<string, unknown>,
): RecallTimingRecord {
  // Serialization boundary: ONLY allowlisted numeric phases reach timingsMs,
  // and the four dimension strings are copied field-by-field. Never spread
  // the internal record into the public shape.
  const timingsMs: Record<string, number> = {
    total: numericMilliseconds(input.total) ?? 0,
  };
  for (const field of TIMING_FIELD_ALLOWLIST) {
    if (field === "total") continue;
    const value = numericMilliseconds(input[field]);
    // Phases that did not run are omitted; 0 means "ran, measured zero".
    if (value !== undefined) timingsMs[field] = value;
  }
  // Attempt-contract id decode: String(x) === x holds exactly for string
  // primitives; every other value coalesces to "" (no runtime typeof here).
  const requestId = String(input.requestId);
  return {
    timestamp: typeof input.timestamp === "string" ? input.timestamp : "",
    namespace: typeof input.namespace === "string" ? input.namespace : "",
    recallPlan: typeof input.recallPlan === "string" ? input.recallPlan : "",
    queryPolicy: typeof input.queryPolicy === "string" ? input.queryPolicy : "",
    // Attempt contract, copied field-by-field like the dimension strings:
    // non-string requestIds drop, anything but the literal error mark is
    // "ok", and the monotonic total rides the same numeric-ms parsing as
    // the phases (absent or negative floors to 0 for legacy emitters).
    requestId: requestId === input.requestId ? requestId : "",
    outcome: input.outcome === "error" ? "error" : "ok",
    httpTotalMs: numericMilliseconds(input.httpTotalMs) ?? 0,
    timingsMs,
  };
}

/**
 * Build the recall `timings` map, seeding the additive queue-wait phase (issue
 * #1906) when the caller measured a real per-principal slot / single-flight
 * wait. `queueWaitMs` 0/undefined/non-finite omits the phase so recall-timings
 * stays byte-identical to the uncontended pre-#1906 path.
 */
export function foldQueueWaitTiming(queueWaitMs?: number): Record<string, string> {
  const timings: Record<string, string> = {};
  if (typeof queueWaitMs === "number" && Number.isFinite(queueWaitMs) && queueWaitMs >= 0) {
    timings.queueWaitMs = `${queueWaitMs}ms`;
  }
  return timings;
}

export function recordRecallTiming(
  config: PluginConfig,
  input: Record<string, unknown>,
): void {
  const history = histories.get(config) ?? [];
  history.push(sanitizeRecallTiming(input));
  if (history.length > RECALL_TIMING_HISTORY_LIMIT) history.shift();
  histories.set(config, history);
}

export function resolveRecallTimingsOperatorPrincipal(
  config: PluginConfig,
  transportPrincipal?: string,
): string | undefined {
  return config.agentAccessHttp.principal?.trim()
    || transportPrincipal?.trim()
    || undefined;
}

export function isRecallTimingsOperator(
  config: PluginConfig,
  authenticatedPrincipal?: string,
  transportPrincipal?: string,
): boolean {
  const operatorPrincipal = resolveRecallTimingsOperatorPrincipal(
    config,
    transportPrincipal,
  );
  return Boolean(
    operatorPrincipal
    && authenticatedPrincipal
    && authenticatedPrincipal === operatorPrincipal,
  );
}

export function getRecallTimings(config: PluginConfig): RecallTimingRecord[] {
  const history = histories.get(config) ?? [];
  return history.slice().reverse().map((record) => ({
    ...record,
    timingsMs: { ...record.timingsMs },
  }));
}

export function getRecallTimingStatus(config: PluginConfig): RecallTimingStatus {
  const records = getRecallTimings(config);
  return {
    generatedAt: new Date().toISOString(),
    processStartedAt: PROCESS_STARTED_AT,
    capacity: RECALL_TIMING_HISTORY_LIMIT,
    count: records.length,
    order: "newest-first",
    records,
  };
}
