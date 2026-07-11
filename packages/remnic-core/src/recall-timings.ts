import type { PluginConfig } from "./types.js";

export interface RecallTimingRecord {
  readonly timestamp: string;
  readonly namespace: string;
  readonly total: number;
  readonly recallPlan: string;
  readonly queryPolicy: string;
  readonly [field: string]: string | number;
}

export interface RecallTimingStatus {
  readonly count: number;
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
] as const;
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
  const record: Record<string, string | number> = {
    timestamp: typeof input.timestamp === "string" ? input.timestamp : "",
    namespace: typeof input.namespace === "string" ? input.namespace : "",
    total: numericMilliseconds(input.total) ?? 0,
    recallPlan: typeof input.recallPlan === "string" ? input.recallPlan : "",
    queryPolicy: typeof input.queryPolicy === "string" ? input.queryPolicy : "",
  };
  for (const field of TIMING_FIELD_ALLOWLIST) {
    if (field === "total") continue;
    const value = numericMilliseconds(input[field]);
    if (value !== undefined) record[field] = value;
  }
  return record as RecallTimingRecord;
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

export function isRecallTimingsOperator(
  operatorPrincipal: string | undefined,
  authenticatedPrincipal?: string,
): boolean {
  const configuredOperator = operatorPrincipal?.trim();
  return Boolean(
    configuredOperator
    && authenticatedPrincipal
    && authenticatedPrincipal === configuredOperator,
  );
}

export function getRecallTimings(config: PluginConfig): RecallTimingRecord[] {
  const history = histories.get(config) ?? [];
  return history.slice().reverse().map((record) => ({ ...record }));
}

export function getRecallTimingStatus(config: PluginConfig): RecallTimingStatus {
  const records = getRecallTimings(config);
  return { count: records.length, records };
}
