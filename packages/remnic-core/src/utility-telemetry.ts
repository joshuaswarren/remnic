import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

export type UtilityTelemetrySource = "cli" | "system" | "benchmark" | "tool_result";
export type UtilityTelemetryTarget = "promotion" | "ranking";
export type UtilityTelemetryDecision = "promote" | "demote" | "hold" | "boost" | "suppress";
export type UtilityTelemetryOutcome = "helpful" | "neutral" | "harmful";

export interface UtilityTelemetryEvent {
  schemaVersion: 1;
  eventId: string;
  recordedAt: string;
  sessionKey: string;
  source: UtilityTelemetrySource;
  target: UtilityTelemetryTarget;
  decision: UtilityTelemetryDecision;
  outcome: UtilityTelemetryOutcome;
  utilityScore: number;
  summary: string;
  memoryIds?: string[];
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface UtilityTelemetryStatus {
  enabled: boolean;
  promotionByOutcomeEnabled: boolean;
  rootDir: string;
  eventsDir: string;
  events: {
    total: number;
    valid: number;
    invalid: number;
    byTarget: Partial<Record<UtilityTelemetryTarget, number>>;
    byDecision: Partial<Record<UtilityTelemetryDecision, number>>;
    byOutcome: Partial<Record<UtilityTelemetryOutcome, number>>;
    latestEventId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestEvent?: UtilityTelemetryEvent;
  invalidEvents: Array<{
    path: string;
    error: string;
  }>;
}

export function resolveUtilityTelemetryDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "utility-telemetry");
}

function assertUtilityScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("utilityScore must be a finite number");
  }
  if (value < -1 || value > 1) {
    throw new Error("utilityScore must be between -1 and 1");
  }
  return value;
}

export function validateUtilityTelemetryEvent(raw: unknown): UtilityTelemetryEvent {
  if (!isRecord(raw)) throw new Error("utility telemetry event must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["cli", "system", "benchmark", "tool_result"].includes(source)) {
    throw new Error("source must be one of cli|system|benchmark|tool_result");
  }

  const target = assertString(raw.target, "target");
  if (!["promotion", "ranking"].includes(target)) {
    throw new Error("target must be one of promotion|ranking");
  }

  const decision = assertString(raw.decision, "decision");
  if (!["promote", "demote", "hold", "boost", "suppress"].includes(decision)) {
    throw new Error("decision must be one of promote|demote|hold|boost|suppress");
  }

  const outcome = assertString(raw.outcome, "outcome");
  if (!["helpful", "neutral", "harmful"].includes(outcome)) {
    throw new Error("outcome must be one of helpful|neutral|harmful");
  }

  return {
    schemaVersion: 1,
    eventId: assertSafePathSegment(assertString(raw.eventId, "eventId"), "eventId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as UtilityTelemetrySource,
    target: target as UtilityTelemetryTarget,
    decision: decision as UtilityTelemetryDecision,
    outcome: outcome as UtilityTelemetryOutcome,
    utilityScore: assertUtilityScore(raw.utilityScore),
    summary: assertString(raw.summary, "summary"),
    memoryIds: optionalStringArray(raw.memoryIds, "memoryIds"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordUtilityTelemetryEvent(options: {
  memoryDir: string;
  utilityTelemetryDir?: string;
  event: UtilityTelemetryEvent;
}): Promise<string> {
  const rootDir = resolveUtilityTelemetryDir(options.memoryDir, options.utilityTelemetryDir);
  const validated = validateUtilityTelemetryEvent(options.event);
  const day = recordStoreDay(validated.recordedAt);
  const eventsDir = path.join(rootDir, "events", day);
  const filePath = path.join(eventsDir, `${validated.eventId}.json`);
  await mkdir(eventsDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), { encoding: "utf8", flag: "wx" });
  return filePath;
}

export async function readUtilityTelemetryEvents(options: {
  memoryDir: string;
  utilityTelemetryDir?: string;
}): Promise<{
  files: string[];
  events: UtilityTelemetryEvent[];
  invalidEvents: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveUtilityTelemetryDir(options.memoryDir, options.utilityTelemetryDir);
  const files = await listJsonFiles(path.join(rootDir, "events"));
  const events: UtilityTelemetryEvent[] = [];
  const invalidEvents: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      events.push(validateUtilityTelemetryEvent(await readJsonFile(filePath)));
    } catch (error) {
      invalidEvents.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, events, invalidEvents };
}

export async function getUtilityTelemetryStatus(options: {
  memoryDir: string;
  utilityTelemetryDir?: string;
  enabled: boolean;
  promotionByOutcomeEnabled?: boolean;
}): Promise<UtilityTelemetryStatus> {
  const rootDir = resolveUtilityTelemetryDir(options.memoryDir, options.utilityTelemetryDir);
  const eventsDir = path.join(rootDir, "events");
  if (!options.enabled) {
    return {
      enabled: false,
      promotionByOutcomeEnabled: options.promotionByOutcomeEnabled === true,
      rootDir,
      eventsDir,
      events: {
        total: 0,
        valid: 0,
        invalid: 0,
        byTarget: {},
        byDecision: {},
        byOutcome: {},
      },
      invalidEvents: [],
    };
  }

  const { files, events, invalidEvents } = await readUtilityTelemetryEvents(options);
  events.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byTarget: Partial<Record<UtilityTelemetryTarget, number>> = {};
  const byDecision: Partial<Record<UtilityTelemetryDecision, number>> = {};
  const byOutcome: Partial<Record<UtilityTelemetryOutcome, number>> = {};
  for (const event of events) {
    byTarget[event.target] = (byTarget[event.target] ?? 0) + 1;
    byDecision[event.decision] = (byDecision[event.decision] ?? 0) + 1;
    byOutcome[event.outcome] = (byOutcome[event.outcome] ?? 0) + 1;
  }

  return {
    enabled: true,
    promotionByOutcomeEnabled: options.promotionByOutcomeEnabled === true,
    rootDir,
    eventsDir,
    events: {
      total: files.length,
      valid: events.length,
      invalid: invalidEvents.length,
      byTarget,
      byDecision,
      byOutcome,
      latestEventId: events[0]?.eventId,
      latestRecordedAt: events[0]?.recordedAt,
      latestSessionKey: events[0]?.sessionKey,
    },
    latestEvent: events[0],
    invalidEvents,
  };
}
