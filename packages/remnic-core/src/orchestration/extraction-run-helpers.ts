import type { BufferTurn, ExtractionFailureClass, ExtractionResult, MetaState } from "../types.js";
import type { StorageManager } from "../index.js";
import { log } from "../logger.js";

export function combineExtractionAbortSignals(
  primary: AbortSignal | undefined,
  deadlineController: AbortController | undefined,
): AbortSignal | undefined {
  if (!deadlineController) return primary;
  return primary ? AbortSignal.any([primary, deadlineController.signal]) : deadlineController.signal;
}


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

export async function runExtractionPostPersistBestEffort(
  runDeadlineAware: (
    operation: () => Promise<unknown>,
    phase: string,
    clearTimerOnError?: boolean,
    options?: { ignoreAbort?: boolean; ignoreDeadline?: boolean },
  ) => Promise<unknown>,
  stage: string,
  operation: () => Promise<unknown>,
  options?: { ignoreAbort?: boolean; ignoreDeadline?: boolean; propagateErrors?: boolean },
): Promise<void> {
  try {
    await runDeadlineAware(operation, stage, false, {
      ignoreAbort: options?.ignoreAbort,
      ignoreDeadline: options?.ignoreDeadline,
    });
  } catch (error) {
    if (options?.propagateErrors) throw error;
    log.warn(`runExtraction: ${stage} failed after persistence (non-fatal)`, error);
  }
}

/**
 * Applies deferred-judge retention only to live, non-shadow extraction runs.
 * Replay/import paths must not synthesize live-buffer entries after persistence.
 */
export interface ExtractionDeferRetentionOptions {
  clearBufferAfterExtraction: boolean;
  extractionJudgeShadow: boolean;
  getDeferredCount: () => number;
  normalizedTurns: BufferTurn[];
  bufferKey: string;
  retainDeferredTurns: (bufferKey: string, turns: BufferTurn[], max: number) => Promise<void>;
}

export async function runExtractionDeferRetention(
  runPostPersistBestEffort: (
    stage: string,
    operation: () => Promise<unknown>,
    options?: { ignoreAbort?: boolean },
  ) => Promise<void>,
  options: ExtractionDeferRetentionOptions,
): Promise<void> {
  await runPostPersistBestEffort("during_defer_retention", async () => {
    if (options.clearBufferAfterExtraction && !options.extractionJudgeShadow) {
      const deferredCount = options.getDeferredCount();
      if (deferredCount > 0 && options.normalizedTurns.length > 0) {
        await options.retainDeferredTurns(options.bufferKey, options.normalizedTurns, 10);
      } else {
        await options.retainDeferredTurns(options.bufferKey, [], 0);
      }
    }
  });
}

export interface ExtractionPostPersistOptions {
  result: ExtractionResult;
  storage: StorageManager;
  meta?: MetaState;
  extractionFingerprint?: string;
  shouldPersistProcessedFingerprint: boolean;
  recordProcessedExtractionFingerprint: (
    storage: StorageManager,
    fingerprint: string,
    meta: MetaState,
  ) => Promise<void>;
  runDeadlineAware: (
    operation: () => Promise<unknown>,
    phase: string,
    clearTimerOnError?: boolean,
    options?: { ignoreAbort?: boolean; ignoreDeadline?: boolean },
  ) => Promise<unknown>;
  isDeadlineError: (error: unknown) => boolean;
  createDeadlineError: (stage: string) => Error;
  deadlineMs?: number;
  clearBufferAfterExtraction: boolean;
  runPostPersistBestEffort: (
    stage: string,
    operation: () => Promise<unknown>,
    options?: { ignoreAbort?: boolean; ignoreDeadline?: boolean; propagateErrors?: boolean },
  ) => Promise<void>;
  extractionJudgeShadow: boolean;
  getDeferredCount: () => number;
  normalizedTurns: BufferTurn[];
  bufferKey: string;
  retainDeferredTurns: (bufferKey: string, turns: BufferTurn[], max: number) => Promise<void>;
  clearBuffer: (options?: { ignoreAbort?: boolean }) => Promise<void>;
  failOnExtractionFailure: boolean;
}

export interface ExtractionPostPersistResult {
  meta?: MetaState;
  metadataFailed: boolean;
}

export async function runExtractionPostPersist(
  options: ExtractionPostPersistOptions,
): Promise<ExtractionPostPersistResult> {
  let metadataFailed = false;
  let deadlineError: Error | undefined;
  const recordFailure = (stage: string, error: unknown): void => {
    metadataFailed = true;
    if (options.isDeadlineError(error) && deadlineError === undefined) {
      deadlineError = error as Error;
    }
    log.warn(`runExtraction: ${stage} failed after durable persistence; continuing with buffer clear`, error);
  };
  let meta = options.meta;
  try {
    meta ??= (await options.runDeadlineAware(
      () => options.storage.loadMeta(),
      "during_post_persist_load_meta",
      false,
    )) as MetaState;
  } catch (error) {
    recordFailure("metadata load", error);
  }
  if (meta && options.extractionFingerprint && options.shouldPersistProcessedFingerprint) {
    try {
      await options.runDeadlineAware(
        () => options.recordProcessedExtractionFingerprint(options.storage, options.extractionFingerprint!, meta!),
        "during_post_persist_fingerprint",
        false,
      );
    } catch (error) {
      recordFailure("processed fingerprint", error);
    }
  }
  if (meta) {
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += Array.isArray(options.result.facts) ? options.result.facts.length : 0;
    meta.totalEntities += Array.isArray(options.result.entities) ? options.result.entities.length : 0;
    try {
      await options.runDeadlineAware(
        () => options.storage.saveMeta(meta!),
        "during_post_persist_meta_save",
        false,
      );
    } catch (error) {
      recordFailure("metadata save", error);
    }
  }
  const runBestEffort = options.runPostPersistBestEffort;
  await runExtractionDeferRetention(runBestEffort, {
    clearBufferAfterExtraction: options.clearBufferAfterExtraction,
    extractionJudgeShadow: options.extractionJudgeShadow,
    getDeferredCount: options.getDeferredCount,
    normalizedTurns: options.normalizedTurns,
    bufferKey: options.bufferKey,
    retainDeferredTurns: options.retainDeferredTurns,
  });
  await runBestEffort(
    "during_buffer_clear",
    () => options.clearBuffer({ ignoreAbort: true }),
    {
      ignoreAbort: true,
      ignoreDeadline: options.failOnExtractionFailure,
      propagateErrors: options.failOnExtractionFailure,
    },
  );
  if (options.failOnExtractionFailure && typeof options.deadlineMs === "number" && Date.now() >= options.deadlineMs) {
    throw options.createDeadlineError("during_buffer_clear");
  }
  if (deadlineError) throw deadlineError;
  return { meta, metadataFailed };
}

/**
 * Record a processed fingerprint when applicable and advance the extraction
 * liveness watermark only for a provider-backed empty success. Fingerprinted
 * imports treat the metadata save as load-bearing dedupe state; normal live
 * runs treat the stamp as diagnostic and fail open. Deadline errors always
 * propagate.
 */
export async function commitEmptySuccessExtraction(args: {
  storage: StorageManager;
  meta: MetaState | null;
  extractionFingerprint: string | null;
  shouldPersistProcessedFingerprint: boolean;
  hasExtractionFailure: boolean;
  extractionSkippedReason: ExtractionResult["extractionSkippedReason"];
  recordProcessedExtractionFingerprint: (storage: StorageManager, fingerprint: string, meta: MetaState) => Promise<unknown>;
  runDeadlineAware: <T>(operation: () => Promise<T>, phase: string, clearTimerOnError?: boolean) => Promise<T>;
  isDeadlineError: (error: unknown) => boolean;
}): Promise<void> {
  const {
    storage,
    meta: existingMeta,
    extractionFingerprint,
    shouldPersistProcessedFingerprint,
    hasExtractionFailure,
    extractionSkippedReason,
    recordProcessedExtractionFingerprint,
    runDeadlineAware,
    isDeadlineError,
  } = args;
  const shouldRecordFingerprint =
    extractionFingerprint !== null &&
    shouldPersistProcessedFingerprint &&
    !hasExtractionFailure;
  const shouldStampLiveness =
    !hasExtractionFailure && extractionSkippedReason === undefined;
  if (!shouldRecordFingerprint && !shouldStampLiveness) return;

  const metadataFailureIsFatal = shouldRecordFingerprint;
  try {
    const meta =
      existingMeta ??
      await runDeadlineAware(
        () => storage.loadMeta(),
        "during_empty_success_liveness_load",
        false,
      );
    if (shouldRecordFingerprint) {
      await recordProcessedExtractionFingerprint(storage, extractionFingerprint, meta);
    }
    if (shouldStampLiveness) {
      meta.extractionCount += 1;
      meta.lastExtractionAt = new Date().toISOString();
    }
    await runDeadlineAware(
      () => storage.saveMeta(meta),
      "during_empty_success_liveness_save",
      false,
    );
  } catch (err) {
    if (isDeadlineError(err)) throw err;
    if (metadataFailureIsFatal) throw err;
    log.warn("runExtraction: failed to stamp empty-success liveness watermark (non-fatal)", err);
  }
}
