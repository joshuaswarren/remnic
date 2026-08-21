import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { clamp01 } from "./lifecycle.js";
import {
  readUtilityTelemetryEvents,
  resolveUtilityTelemetryDir,
  type UtilityTelemetryDecision,
  type UtilityTelemetryEvent,
  type UtilityTelemetryOutcome,
  type UtilityTelemetryTarget,
} from "./utility-telemetry.js";

export interface UtilityLearningWeight {
  target: UtilityTelemetryTarget;
  decision: UtilityTelemetryDecision;
  eventCount: number;
  learnedWeight: number;
  averageUtilityScore: number;
  confidence: number;
  outcomeCounts: Partial<Record<UtilityTelemetryOutcome, number>>;
  updatedAt: string;
}

export interface UtilityLearningSnapshot {
  version: 1;
  updatedAt: string;
  windowDays: number;
  minEventCount: number;
  maxWeightMagnitude: number;
  weights: UtilityLearningWeight[];
}

export interface UtilityLearningStatus {
  enabled: boolean;
  promotionByOutcomeEnabled: boolean;
  rootDir: string;
  statePath: string;
  snapshot: UtilityLearningSnapshot | null;
  weights: {
    total: number;
    positive: number;
    negative: number;
    zero: number;
    latestUpdatedAt?: string;
  };
}

export interface UtilityLearningResult {
  applied: boolean;
  reason: "disabled" | "insufficient_events" | "learned";
  statePath: string;
  snapshot: UtilityLearningSnapshot | null;
}

const UTILITY_LEARNING_SNAPSHOT_VERSION = 1;
const UTILITY_LEARNING_STATE_FILE = "learning-state.json";

function clampWeight(value: number, maxWeightMagnitude: number): number {
  const limit = Number.isFinite(maxWeightMagnitude) && maxWeightMagnitude > 0
    ? maxWeightMagnitude
    : 0;
  return Math.max(-limit, Math.min(limit, value));
}

function coerceLearningWindowDays(value: number): number {
  if (!Number.isFinite(value)) return 14;
  return Math.max(1, Math.floor(value));
}

function coerceMinEventCount(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.floor(value));
}

function coerceMaxWeightMagnitude(value: number): number {
  if (!Number.isFinite(value)) return 0.35;
  return Math.max(0, Math.min(1, value));
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function outcomeCountsFor(events: UtilityTelemetryEvent[]): Partial<Record<UtilityTelemetryOutcome, number>> {
  const counts: Partial<Record<UtilityTelemetryOutcome, number>> = {};
  for (const event of events) {
    counts[event.outcome] = (counts[event.outcome] ?? 0) + 1;
  }
  return counts;
}

function selectRecentEvents(events: UtilityTelemetryEvent[], now: Date, windowDays: number): UtilityTelemetryEvent[] {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return [...events];
  const minTimestamp = now.getTime() - windowDays * 86_400_000;
  return events.filter((event) => {
    const ts = Date.parse(event.recordedAt);
    return Number.isFinite(ts) && ts >= minTimestamp;
  });
}

function confidenceFromEvents(eventCount: number, averageUtilityScore: number): number {
  if (eventCount <= 0) return 0;
  return roundWeight(clamp01(Math.abs(averageUtilityScore) * Math.min(1, eventCount / 10)));
}

function validateUtilityLearningSnapshot(raw: unknown): UtilityLearningSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("utility learning snapshot must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== UTILITY_LEARNING_SNAPSHOT_VERSION) {
    throw new Error("utility learning snapshot version must be 1");
  }
  if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) {
    throw new Error("utility learning snapshot updatedAt must be a string");
  }
  if (typeof record.windowDays !== "number" || !Number.isFinite(record.windowDays) || record.windowDays < 0) {
    throw new Error("utility learning snapshot windowDays must be a non-negative number");
  }
  if (typeof record.minEventCount !== "number" || !Number.isFinite(record.minEventCount) || record.minEventCount < 1) {
    throw new Error("utility learning snapshot minEventCount must be >= 1");
  }
  if (
    typeof record.maxWeightMagnitude !== "number" ||
    !Number.isFinite(record.maxWeightMagnitude) ||
    record.maxWeightMagnitude < 0
  ) {
    throw new Error("utility learning snapshot maxWeightMagnitude must be >= 0");
  }
  if (!Array.isArray(record.weights)) {
    throw new Error("utility learning snapshot weights must be an array");
  }

  const weights = record.weights.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("utility learning weight must be an object");
    }
    const weight = entry as Record<string, unknown>;
    const target = weight.target;
    const decision = weight.decision;
    if (target !== "promotion" && target !== "ranking") {
      throw new Error("utility learning weight target must be promotion|ranking");
    }
    if (!["promote", "demote", "hold", "boost", "suppress"].includes(String(decision))) {
      throw new Error("utility learning weight decision is invalid");
    }
    if (typeof weight.eventCount !== "number" || !Number.isFinite(weight.eventCount) || weight.eventCount < 0) {
      throw new Error("utility learning weight eventCount must be >= 0");
    }
    if (typeof weight.learnedWeight !== "number" || !Number.isFinite(weight.learnedWeight)) {
      throw new Error("utility learning weight learnedWeight must be finite");
    }
    if (typeof weight.averageUtilityScore !== "number" || !Number.isFinite(weight.averageUtilityScore)) {
      throw new Error("utility learning weight averageUtilityScore must be finite");
    }
    if (typeof weight.confidence !== "number" || !Number.isFinite(weight.confidence)) {
      throw new Error("utility learning weight confidence must be finite");
    }
    if (typeof weight.updatedAt !== "string" || weight.updatedAt.length === 0) {
      throw new Error("utility learning weight updatedAt must be a string");
    }
    const outcomeCounts = (weight.outcomeCounts ?? {}) as Partial<Record<UtilityTelemetryOutcome, number>>;
    return {
      target,
      decision: decision as UtilityTelemetryDecision,
      eventCount: weight.eventCount,
      learnedWeight: roundWeight(weight.learnedWeight),
      averageUtilityScore: roundWeight(weight.averageUtilityScore),
      confidence: roundWeight(clamp01(weight.confidence)),
      outcomeCounts,
      updatedAt: weight.updatedAt,
    } satisfies UtilityLearningWeight;
  });

  return {
    version: 1,
    updatedAt: record.updatedAt,
    windowDays: record.windowDays,
    minEventCount: record.minEventCount,
    maxWeightMagnitude: record.maxWeightMagnitude,
    weights,
  };
}

export function resolveUtilityLearningStatePath(memoryDir: string, utilityTelemetryDir?: string): string {
  return path.join(resolveUtilityTelemetryDir(memoryDir, utilityTelemetryDir), UTILITY_LEARNING_STATE_FILE);
}

export async function readUtilityLearningSnapshot(
  memoryDir: string,
  utilityTelemetryDir?: string,
): Promise<UtilityLearningSnapshot | null> {
  const statePath = resolveUtilityLearningStatePath(memoryDir, utilityTelemetryDir);
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    return validateUtilityLearningSnapshot(raw);
  } catch {
    return null;
  }
}

async function writeUtilityLearningSnapshot(
  statePath: string,
  snapshot: UtilityLearningSnapshot,
): Promise<void> {
  const tempPath = `${statePath}.tmp`;
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
}

export async function learnUtilityPromotionWeights(options: {
  memoryDir: string;
  utilityTelemetryDir?: string;
  enabled: boolean;
  now?: Date;
  learningWindowDays: number;
  minEventCount: number;
  maxWeightMagnitude: number;
}): Promise<UtilityLearningResult> {
  const statePath = resolveUtilityLearningStatePath(options.memoryDir, options.utilityTelemetryDir);
  if (!options.enabled) {
    return {
      applied: false,
      reason: "disabled",
      statePath,
      snapshot: null,
    };
  }

  const now = options.now ?? new Date();
  const updatedAt = now.toISOString();
  const windowDays = coerceLearningWindowDays(options.learningWindowDays);
  const minEventCount = coerceMinEventCount(options.minEventCount);
  const maxWeightMagnitude = coerceMaxWeightMagnitude(options.maxWeightMagnitude);
  const recentEvents = selectRecentEvents(
    (
      await readUtilityTelemetryEvents({
        memoryDir: options.memoryDir,
        utilityTelemetryDir: options.utilityTelemetryDir,
      })
    ).events,
    now,
    windowDays,
  );

  const grouped = new Map<string, UtilityTelemetryEvent[]>();
  for (const event of recentEvents) {
    const key = `${event.target}:${event.decision}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }

  const weights: UtilityLearningWeight[] = [];
  for (const events of grouped.values()) {
    if (events.length < minEventCount) continue;
    const target = events[0].target;
    const decision = events[0].decision;
    const averageUtilityScore = events.reduce((sum, event) => sum + event.utilityScore, 0) / events.length;
    const confidence = confidenceFromEvents(events.length, averageUtilityScore);
    const learnedWeight = roundWeight(
      clampWeight(averageUtilityScore * confidence, maxWeightMagnitude),
    );
    weights.push({
      target,
      decision,
      eventCount: events.length,
      learnedWeight,
      averageUtilityScore: roundWeight(averageUtilityScore),
      confidence,
      outcomeCounts: outcomeCountsFor(events),
      updatedAt,
    });
  }

  weights.sort((left, right) => {
    const targetCompare = left.target.localeCompare(right.target);
    if (targetCompare !== 0) return targetCompare;
    return left.decision.localeCompare(right.decision);
  });

  const snapshot: UtilityLearningSnapshot = {
    version: 1,
    updatedAt,
    windowDays,
    minEventCount,
    maxWeightMagnitude,
    weights,
  };

  if (weights.length === 0) {
    await writeUtilityLearningSnapshot(statePath, snapshot);
    return {
      applied: false,
      reason: "insufficient_events",
      statePath,
      snapshot,
    };
  }

  await writeUtilityLearningSnapshot(statePath, snapshot);
  return {
    applied: true,
    reason: "learned",
    statePath,
    snapshot,
  };
}

export async function getUtilityLearningStatus(options: {
  memoryDir: string;
  utilityTelemetryDir?: string;
  enabled: boolean;
  promotionByOutcomeEnabled?: boolean;
}): Promise<UtilityLearningStatus> {
  const rootDir = resolveUtilityTelemetryDir(options.memoryDir, options.utilityTelemetryDir);
  const statePath = resolveUtilityLearningStatePath(options.memoryDir, options.utilityTelemetryDir);
  if (!options.enabled) {
    return {
      enabled: false,
      promotionByOutcomeEnabled: options.promotionByOutcomeEnabled === true,
      rootDir,
      statePath,
      snapshot: null,
      weights: {
        total: 0,
        positive: 0,
        negative: 0,
        zero: 0,
      },
    };
  }

  const snapshot = await readUtilityLearningSnapshot(options.memoryDir, options.utilityTelemetryDir);
  const weights = snapshot?.weights ?? [];
  return {
    enabled: true,
    promotionByOutcomeEnabled: options.promotionByOutcomeEnabled === true,
    rootDir,
    statePath,
    snapshot,
    weights: {
      total: weights.length,
      positive: weights.filter((entry) => entry.learnedWeight > 0).length,
      negative: weights.filter((entry) => entry.learnedWeight < 0).length,
      zero: weights.filter((entry) => entry.learnedWeight === 0).length,
      latestUpdatedAt: snapshot?.updatedAt,
    },
  };
}
