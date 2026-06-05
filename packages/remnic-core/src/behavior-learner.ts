import { clamp01, clampLifecycleThreshold } from "./lifecycle.js";
import { clampInstructionHeavyTokenCap } from "./recall-query-policy.js";
import type { BehaviorLoopAdjustment, BehaviorLoopPolicyState, BehaviorSignalEvent, PluginConfig } from "./types.js";

export const TUNABLE_BEHAVIOR_PARAMETERS = [
  "recencyWeight",
  "lifecyclePromoteHeatThreshold",
  "lifecycleStaleDecayThreshold",
  "cronRecallInstructionHeavyTokenCap",
] as const;

export type TunableBehaviorParameter = (typeof TUNABLE_BEHAVIOR_PARAMETERS)[number];

export interface BehaviorLearnerInput {
  signals: BehaviorSignalEvent[];
  now?: Date;
  learningWindowDays: number;
  minSignalCount: number;
  maxDeltaPerCycle: number;
  protectedParams: string[];
  currentPolicy: Pick<
    PluginConfig,
    "recencyWeight" | "lifecyclePromoteHeatThreshold" | "lifecycleStaleDecayThreshold" | "cronRecallInstructionHeavyTokenCap"
  >;
}

function clampToRange(parameter: TunableBehaviorParameter, value: number): number {
  switch (parameter) {
    case "recencyWeight":
      return clamp01(value);
    case "lifecyclePromoteHeatThreshold":
    case "lifecycleStaleDecayThreshold":
      return clampLifecycleThreshold(value);
    case "cronRecallInstructionHeavyTokenCap":
      return clampInstructionHeavyTokenCap(value);
  }
}

function currentValueFor(
  parameter: TunableBehaviorParameter,
  currentPolicy: BehaviorLearnerInput["currentPolicy"],
): number {
  return currentPolicy[parameter];
}

function maxDeltaFor(parameter: TunableBehaviorParameter, maxDeltaPerCycle: number): number {
  if (!Number.isFinite(maxDeltaPerCycle) || maxDeltaPerCycle <= 0) return 0;
  if (parameter === "cronRecallInstructionHeavyTokenCap") {
    return Math.max(1, Math.round(maxDeltaPerCycle * 40));
  }
  return maxDeltaPerCycle;
}

function confidenceFromSignals(signalCount: number, pressureMagnitude: number): number {
  if (signalCount <= 0) return 0;
  return clamp01(pressureMagnitude * Math.min(1, signalCount / 20));
}

function aggregateSignalPressure(signals: BehaviorSignalEvent[]): number {
  if (signals.length === 0) return 0;
  let net = 0;
  for (const signal of signals) {
    const weight = clamp01(signal.confidence);
    if (signal.direction === "positive") net += weight;
    if (signal.direction === "negative") net -= weight;
  }
  return Math.max(-1, Math.min(1, net / signals.length));
}

function selectRecentSignals(input: BehaviorLearnerInput): BehaviorSignalEvent[] {
  const nowMs = (input.now ?? new Date()).getTime();
  const minTs =
    input.learningWindowDays <= 0
      ? Number.NEGATIVE_INFINITY
      : nowMs - input.learningWindowDays * 86_400_000;
  return input.signals.filter((signal) => {
    const ts = Date.parse(signal.timestamp);
    if (!Number.isFinite(ts)) return false;
    return ts >= minTs && ts <= nowMs;
  });
}

function parameterDirection(parameter: TunableBehaviorParameter, pressure: number): number {
  switch (parameter) {
    case "recencyWeight":
      return pressure;
    case "lifecyclePromoteHeatThreshold":
      return pressure * -0.5;
    case "lifecycleStaleDecayThreshold":
      return pressure * 0.5;
    case "cronRecallInstructionHeavyTokenCap":
      return pressure * 0.75;
  }
}

export function learnBehaviorPolicyAdjustments(input: BehaviorLearnerInput): BehaviorLoopPolicyState {
  const nowIso = (input.now ?? new Date()).toISOString();
  const windowedSignals = selectRecentSignals(input);
  if (windowedSignals.length < input.minSignalCount) {
    return {
      version: 1,
      windowDays: input.learningWindowDays,
      minSignalCount: input.minSignalCount,
      maxDeltaPerCycle: input.maxDeltaPerCycle,
      protectedParams: [...input.protectedParams],
      adjustments: [],
      updatedAt: nowIso,
    };
  }

  const pressure = aggregateSignalPressure(windowedSignals);
  const adjustments: BehaviorLoopAdjustment[] = [];
  for (const parameter of TUNABLE_BEHAVIOR_PARAMETERS) {
    if (input.protectedParams.includes(parameter)) continue;
    const currentValue = currentValueFor(parameter, input.currentPolicy);
    const direction = parameterDirection(parameter, pressure);
    const deltaBound = maxDeltaFor(parameter, input.maxDeltaPerCycle);
    const proposedDelta = Math.max(-deltaBound, Math.min(deltaBound, direction * deltaBound));
    if (Math.abs(proposedDelta) <= 0) continue;

    const nextValue = clampToRange(parameter, currentValue + proposedDelta);
    const roundedDelta = nextValue - currentValue;
    if (Math.abs(roundedDelta) <= Number.EPSILON) continue;

    adjustments.push({
      parameter,
      previousValue: currentValue,
      nextValue,
      delta: roundedDelta,
      evidenceCount: windowedSignals.length,
      confidence: confidenceFromSignals(windowedSignals.length, Math.abs(pressure)),
      reason: `signal_pressure=${pressure.toFixed(3)} evidence=${windowedSignals.length}`,
      appliedAt: nowIso,
    });
  }

  return {
    version: 1,
    windowDays: input.learningWindowDays,
    minSignalCount: input.minSignalCount,
    maxDeltaPerCycle: input.maxDeltaPerCycle,
    protectedParams: [...input.protectedParams],
    adjustments,
    updatedAt: nowIso,
  };
}
