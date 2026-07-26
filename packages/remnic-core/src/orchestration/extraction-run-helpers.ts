import type { BufferTurn, ExtractionFailureClass, ExtractionResult } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function deriveTopicsFromExtraction(result: ExtractionResult): string[] {
  if (!isRecord(result)) return [];
  const topics = new Set<string>();
  const facts = Array.isArray(result.facts) ? result.facts : [];
  for (const rawFact of facts) {
    if (!isRecord(rawFact)) continue;
    const tags = Array.isArray(rawFact.tags) ? rawFact.tags : [];
    for (const tag of tags) {
      if (typeof tag === "string" && tag.length >= 2) topics.add(tag.toLowerCase());
    }
    if (typeof rawFact.entityRef === "string" && rawFact.entityRef.length >= 2) {
      topics.add(rawFact.entityRef.toLowerCase());
    }
    if (typeof rawFact.category === "string" && rawFact.category.length > 0) {
      topics.add(rawFact.category);
    }
  }
  const entities = Array.isArray(result.entities) ? result.entities : [];
  for (const rawEntity of entities) {
    if (!isRecord(rawEntity)) continue;
    if (typeof rawEntity.name === "string" && rawEntity.name.length >= 2) {
      topics.add(rawEntity.name.toLowerCase());
    }
  }
  return [...topics].slice(0, 16);
}

/** Bounded cap on persisted per-fingerprint retry-state entries (per namespace meta). */
export const EXTRACTION_RETRY_STATE_MAX_ENTRIES = 500;

export interface ExtractionRetryStateEntry {
  attempts: number;
  nextEligibleAtMs: number;
  firstFailedAtMs: number;
  lastFailureClass: ExtractionFailureClass;
}

export interface ExtractionResilienceStatus {
  breaker: {
    state: "closed" | "open" | "half_open";
    openUntilMs: number;
    consecutiveFailures: number;
    lastReason: string;
  };
  backoffFingerprintCount: number;
}

/**
 * Pure backoff scheduler. Returns the absolute ms timestamp at which a
 * fingerprint that has failed `attempts` times becomes eligible again:
 * exponential via the configured schedule, clamped to `maxBackoffMs`, with
 * ±`jitterRatio` multiplicative jitter. `rng` is injectable for deterministic
 * tests. Never returns a timestamp before `now`.
 */
export function computeExtractionRetryNextEligibleMs(
  attempts: number,
  scheduleMs: readonly number[],
  maxBackoffMs: number,
  jitterRatio: number,
  now: number,
  rng: () => number = Math.random,
): number {
  if (!Number.isFinite(attempts) || !Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a finite integer >= 1");
  }
  if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < 0) {
    throw new RangeError("maxBackoffMs must be a finite number >= 0");
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError("jitterRatio must be a finite number in [0, 1]");
  }
  const safeNow = Number.isFinite(now) ? now : 0;
  const cap = maxBackoffMs;
  if (!Array.isArray(scheduleMs) || scheduleMs.length === 0) {
    return safeNow + cap;
  }
  const idx = Math.min(attempts - 1, scheduleMs.length - 1);
  const step = scheduleMs[idx];
  const base = Math.min(typeof step === "number" && Number.isFinite(step) && step > 0 ? step : cap, cap);
  const randomValue = rng();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new RangeError("rng() must return a finite number in [0, 1]");
  }
  const jitter = 1 + (randomValue * 2 - 1) * jitterRatio;
  return safeNow + Math.max(0, Math.round(base * jitter));
}

/**
 * Cap the persisted retry-state array to the newest `maxEntries` by
 * firstFailedAt. Guards invalid caps so they cannot turn `slice(-maxEntries)`
 * into an unbounded copy (AGENTS.md rule 17).
 */
export function capExtractionRetryStateEntries<T extends { firstFailedAt: string }>(
  entries: readonly T[],
  maxEntries: number,
): T[] {
  if (!Number.isFinite(maxEntries) || !Number.isInteger(maxEntries) || maxEntries <= 0) return [];
  const sorted = [...entries].sort((a, b) => a.firstFailedAt.localeCompare(b.firstFailedAt));
  return sorted.slice(-maxEntries);
}

/**
 * Derive a single `sourceConnector` from a batch of turns.
 * Returns the connector ONLY when ALL turns carry the same connector.
 * Mixed tagged/untagged batches return undefined — extraction facts are
 * persisted at batch level, so attributing them to the single tagged
 * connector would falsely label facts from untagged turns.
 * Conflicting connectors (different values) also return undefined.
 */
export function deriveSourceConnector(turns: readonly BufferTurn[]): string | undefined {
  if (turns.length === 0) return undefined;
  const connectors = new Set<string>();
  let untaggedCount = 0;
  for (const turn of turns) {
    if (typeof turn.sourceConnector === "string" && turn.sourceConnector.length > 0) {
      connectors.add(turn.sourceConnector);
    } else {
      untaggedCount += 1;
    }
  }
  // All turns must agree on the same connector — no untagged turns mixed in.
  if (untaggedCount > 0) return undefined;
  return connectors.size === 1 ? [...connectors][0] : undefined;
}
