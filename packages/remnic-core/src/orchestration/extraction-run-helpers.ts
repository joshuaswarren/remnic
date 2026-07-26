import type { BufferTurn, ExtractionFailureClass, ExtractionResult } from "../types.js";

export function deriveTopicsFromExtraction(result: ExtractionResult): string[] {
  const topics = new Set<string>();
  for (const fact of result.facts ?? []) {
    for (const tag of fact.tags ?? []) {
      if (tag && tag.length >= 2) topics.add(tag.toLowerCase());
    }
    if (fact.entityRef) topics.add(fact.entityRef.toLowerCase());
    if (fact.category) topics.add(fact.category);
  }
  for (const entity of (result as any).entities ?? []) {
    if (typeof entity.name === "string" && entity.name.length >= 2) {
      topics.add(entity.name.toLowerCase());
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
  const cap = Number.isFinite(maxBackoffMs) && maxBackoffMs > 0 ? maxBackoffMs : 0;
  if (!Array.isArray(scheduleMs) || scheduleMs.length === 0) {
    return now + cap;
  }
  const idx = Math.min(Math.max(attempts - 1, 0), scheduleMs.length - 1);
  const step = scheduleMs[idx];
  const base = Math.min(typeof step === "number" && step > 0 ? step : cap, cap);
  const jitter = 1 + (rng() * 2 - 1) * jitterRatio;
  return now + Math.max(0, Math.round(base * jitter));
}

/**
 * Cap the persisted retry-state array to the newest `maxEntries` by
 * firstFailedAt. Guards `maxEntries <= 0` so a zero cap returns [] rather than
 * `slice(-0)`, which returns ALL entries (AGENTS.md rule 17).
 */
export function capExtractionRetryStateEntries<T extends { firstFailedAt: string }>(
  entries: readonly T[],
  maxEntries: number,
): T[] {
  if (maxEntries <= 0) return [];
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
