/**
 * Extraction-pipeline liveness (issue #2151).
 *
 * A daemon's implicit extraction can fail continuously for months while
 * `/health` stays green and recall keeps serving: every individual failure is
 * logged (timeouts, fallback-no-parsed-output), but nothing aggregates them
 * into a checkable status. This module surfaces a liveness *watermark* — the
 * last successful extraction plus the current buffer backlog — and decides when
 * that watermark is stale enough to call the pipeline degraded.
 *
 * The §22 error-vs-empty principle applies at the pipeline level: "no
 * extraction succeeded for 90 days" (a non-empty buffer with a stale/absent
 * watermark) must be distinguishable from "nothing to extract" (an empty
 * buffer). Degradation therefore requires a NON-EMPTY buffer — an idle daemon
 * with nothing buffered is healthy, not degraded.
 *
 * The core decision (`evaluateExtractionLiveness`) is a pure function shared by
 * every surface (authenticated `/health`, `remnic doctor`, `remnic stats`) so
 * the verdict never diverges across code paths.
 */
import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import { log } from "./logger.js";
import type { OperatorDoctorCheck } from "./operator-doctor-types.js";
import type { PluginConfig } from "./types.js";

/** Default staleness window: 24h. A watermark older than this with a non-empty buffer is degraded. */
const DEFAULT_STALE_WINDOW_MS = 86_400_000;

export interface ExtractionLivenessConfig {
  /** Master gate. When false, liveness is never reported degraded. Default true. */
  enabled: boolean;
  /**
   * How stale the last-successful-extraction watermark may get (ms) before a
   * non-empty buffer flags the pipeline degraded. Default 24h.
   */
  staleWindowMs: number;
}

/**
 * A read-only snapshot of buffered, not-yet-extracted work. Structurally
 * satisfied by `SmartBuffer.getBufferSnapshot()` so callers can pass the live
 * buffer without this module depending on the buffer implementation.
 */
export interface ExtractionBufferSnapshot {
  bufferedSessionCount: number;
  pendingTurnCount: number;
  oldestTurnTimestamp: string | null;
  /**
   * Set by the liveness reader (never by `SmartBuffer`) when the buffer exists
   * but its snapshot read threw. An unreadable buffer is a pipeline fault, not
   * an empty queue (§22): it degrades the pipeline with a distinct reason
   * instead of masquerading as a zero-backlog (healthy) snapshot.
   */
  readFailed?: boolean;
  /** Read-failure detail, surfaced in the degraded reason when `readFailed`. */
  readError?: string;
}

export interface ExtractionBufferSource {
  getBufferSnapshot(): Promise<ExtractionBufferSnapshot>;
}

export interface ExtractionRootStats {
  extractionCount?: number;
  lastConsolidationAt?: string | null;
}

export interface ExtractionWatermarkRead {
  lastExtractionAt: string | null;
  readFailed: boolean;
  readError?: string;
  pending?: boolean;
  rootStats?: ExtractionRootStats;
}

export type ExtractionWatermarkOrStorage =
  | ExtractionWatermarkRead
  | { readMetadata(): Promise<{ lastExtractionAt?: string | null } | null> }
  | { loadMeta(): Promise<{ lastExtractionAt?: string | null }> };

export async function coerceExtractionWatermark(
  watermark: ExtractionWatermarkOrStorage,
): Promise<ExtractionWatermarkRead> {
  if (watermark && "readFailed" in watermark && typeof watermark.readFailed === "boolean") {
    return watermark as ExtractionWatermarkRead;
  }
  try {
    let lastExtractionAt: string | null = null;
    if ("loadMeta" in watermark && typeof watermark.loadMeta === "function") {
      const meta = await watermark.loadMeta();
      lastExtractionAt = meta?.lastExtractionAt ?? null;
    } else if ("readMetadata" in watermark && typeof watermark.readMetadata === "function") {
      const meta = await watermark.readMetadata();
      lastExtractionAt = meta?.lastExtractionAt ?? null;
    }
    return {
      lastExtractionAt,
      readFailed: true,
      readError: "aggregate watermark unavailable from legacy root-store-only storage argument",
    };
  } catch (error) {
    return {
      lastExtractionAt: null,
      readFailed: true,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The daemon-scoped liveness payload surfaced on `/health.extraction` and in
 * doctor/stats details. Its watermark is the maximum successful extraction
 * across every distinct namespace store, matching the daemon-wide buffer scope.
 */
export interface ExtractionLivenessStatus {
  lastExtractionAt: string | null;
  bufferedSessionCount: number;
  pendingTurnCount: number;
  oldestBufferedTurnAgeMs: number | null;
  degraded: boolean;
  degradedReason: string | null;
  watermarkPending?: boolean;
  watermarkScope: "aggregate";
}

interface ExtractionLivenessOrchestratorLike {
  config: Pick<PluginConfig, "extractionLiveness">;
  buffer?: ExtractionBufferSource;
}

/**
 * Parse the `extractionLiveness` config block. Follows the nested-block shape
 * validation used elsewhere in `config.ts` and coerces string booleans (§24:
 * CLI/JSON deliver `"false"`/`"0"` as strings, which must read as falsy).
 */
export function parseExtractionLivenessConfig(
  cfg: Record<string, unknown>,
): ExtractionLivenessConfig {
  const raw = cfg.extractionLiveness;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`extractionLiveness must be a plain object (got ${JSON.stringify(raw)})`);
  }
  const block = (raw ?? {}) as Record<string, unknown>;
  return {
    // `?? true` keeps the default on when the key is absent while honoring
    // explicit "false"/"0"/false opt-outs (coerceBool handles the string forms).
    enabled: coerceBool(block.enabled) ?? true,
    staleWindowMs: parseStaleWindowMs(block.staleWindowMs),
  };
}

/**
 * Parse `extractionLiveness.staleWindowMs`. Absent (`undefined`) → the 24h
 * default; any PRESENT value (including an explicit `null`) must coerce to a
 * positive INTEGER of milliseconds, else THROW. A fractional or non-positive
 * value ("0.5" would floor to 0, making every backlog instantly stale; 1.9 would
 * floor to 1) is rejected, never floored/reinterpreted (§1/§17/§39). Mirrors
 * config.ts's `parseIntegerInClosedRange` (round 9 finding 1): only an absent key
 * falls back; an explicit `null` is invalid input, not "use the default".
 * Inlined rather than imported because config.ts already imports this module
 * (importing back would be circular), the same reason `recall-concurrency-config.ts`
 * inlines its numeric validation.
 */
function parseStaleWindowMs(value: unknown): number {
  // Only an absent key (undefined) falls back to the default; an explicit `null`
  // is invalid input and proceeds to validation → throw (mirrors
  // parseIntegerInClosedRange, round 9 finding 1).
  if (value === undefined) return DEFAULT_STALE_WINDOW_MS;
  const coerced = coerceNumber(value);
  if (coerced === undefined || !Number.isFinite(coerced) || !Number.isInteger(coerced) || coerced < 1) {
    throw new Error(
      `extractionLiveness.staleWindowMs must be an integer greater than or equal to 1; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

/** Milliseconds between `timestamp` and `nowMs`, clamped at 0; null when unparsable/absent. */
function ageMsFrom(timestamp: string | null, nowMs: number): number | null {
  if (typeof timestamp !== "string") return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

/** Compact human-readable duration ("3d", "5h", "12m", "45s") for logs and CLI output. */
export function formatAgeMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s >= 3_600) return `${Math.floor(s / 3_600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/**
 * Pure liveness verdict. Degraded when the feature is enabled AND any of: the
 * last-extraction watermark could not be READ (a storage fault, §22), the buffer
 * read failed (a pipeline fault, §22), or the buffer is non-empty and the
 * watermark is absent or stale. Each cause yields a DISTINCT reason so an
 * operator can tell a meta-read failure from a buffer-read failure from a
 * pipeline that has genuinely never extracted.
 *
 * Staleness uses a half-open freshness window (§23): an extraction is fresh
 * while its age is in `[0, staleWindowMs)`, so an age of EXACTLY `staleWindowMs`
 * is stale (the upper bound on "fresh" is exclusive). A null/unparsable watermark
 * means "never succeeded" and is treated as stale — as is a FUTURE watermark (a
 * clock-skewed or corrupt timestamp ahead of now must not read as a fresh
 * extraction and hide a real backlog stall).
 */
export function evaluateExtractionLiveness(input: {
  config: ExtractionLivenessConfig;
  lastExtractionAt: string | null;
  snapshot: ExtractionBufferSnapshot;
  nowMs: number;
  metaReadFailed?: boolean;
  metaReadError?: string;
  watermarkPending?: boolean;
}): ExtractionLivenessStatus {
  const { config, lastExtractionAt, snapshot, nowMs } = input;
  const lastMs = lastExtractionAt !== null ? Date.parse(lastExtractionAt) : Number.NaN;
  const hasWatermark = Number.isFinite(lastMs);
  const ageMs = nowMs - lastMs;
  // A future watermark (negative age) is clock-skewed or corrupt data, not a
  // fresh extraction: treat it as stale so a real backlog stall is not hidden.
  const stale = !hasWatermark || ageMs < 0 || ageMs >= config.staleWindowMs;
  const hasBacklog = snapshot.bufferedSessionCount > 0;
  // A watermark or buffer that cannot be READ is a fault, not an empty queue
  // (§22): a storage/pipeline outage must not read as healthy, and must stay
  // distinct from a pipeline that has genuinely never extracted.
  const metaReadFailed = input.metaReadFailed === true;
  const watermarkPending = input.watermarkPending === true;
  const readFailed = snapshot.readFailed === true;
  const degraded =
    config.enabled && (metaReadFailed || readFailed || (!watermarkPending && hasBacklog && stale));

  let degradedReason: string | null = null;
  if (degraded) {
    if (metaReadFailed) {
      degradedReason = `extraction watermark unreadable: ${input.metaReadError ?? "meta read failed"}`;
    } else if (readFailed) {
      degradedReason = `extraction buffer unreadable: ${snapshot.readError ?? "buffer snapshot read failed"}`;
    } else {
      const watermark = hasWatermark
        ? `last succeeded ${formatAgeMs(nowMs - lastMs)} ago`
        : "no successful extraction on record";
      degradedReason =
        `${watermark}; ${snapshot.bufferedSessionCount} buffered session(s), ` +
        `${snapshot.pendingTurnCount} turn(s) pending extraction`;
    }
  }

  return {
    lastExtractionAt,
    bufferedSessionCount: snapshot.bufferedSessionCount,
    pendingTurnCount: snapshot.pendingTurnCount,
    oldestBufferedTurnAgeMs: ageMsFrom(snapshot.oldestTurnTimestamp, nowMs),
    degraded,
    degradedReason,
    ...(watermarkPending ? { watermarkPending: true } : {}),
    watermarkScope: "aggregate",
  };
}

const EMPTY_SNAPSHOT: ExtractionBufferSnapshot = {
  bufferedSessionCount: 0,
  pendingTurnCount: 0,
  oldestTurnTimestamp: null,
};

/**
 * Read a buffer snapshot without throwing. An ABSENT buffer degrades to an empty
 * (healthy) snapshot — some service constructions have no orchestrator buffer. A
 * buffer that EXISTS but whose read throws yields a `readFailed` snapshot so the
 * verdict can distinguish a pipeline fault from an empty queue (§22).
 */
async function readBufferSnapshot(
  buffer: ExtractionBufferSource | undefined,
): Promise<ExtractionBufferSnapshot> {
  if (!buffer || typeof buffer.getBufferSnapshot !== "function") return EMPTY_SNAPSHOT;
  try {
    return await buffer.getBufferSnapshot();
  } catch (err) {
    return {
      ...EMPTY_SNAPSHOT,
      readFailed: true,
      readError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Gather the liveness status from an aggregate watermark read and an optional
 * buffer. A read failure on either side is surfaced as a degraded status with a
 * distinct reason rather than swallowed into a healthy-looking verdict.
 */
export async function gatherExtractionLivenessStatus(input: {
  config: ExtractionLivenessConfig;
  watermark: ExtractionWatermarkOrStorage;
  buffer: ExtractionBufferSource | undefined;
  nowMs: number;
}): Promise<ExtractionLivenessStatus> {
  const { config, buffer, nowMs } = input;
  const watermarkRead = await coerceExtractionWatermark(input.watermark);
  const snapshot = await readBufferSnapshot(buffer);
  return evaluateExtractionLiveness({
    config,
    lastExtractionAt: watermarkRead.lastExtractionAt,
    snapshot,
    nowMs,
    metaReadFailed: watermarkRead.readFailed,
    metaReadError: watermarkRead.readError,
    watermarkPending: watermarkRead.pending,
  });
}

/**
 * Aggregated-WARN throttle (issue #2151): emit at most ONE warning per
 * staleness window while degraded — not one line per failed extraction attempt.
 * State is instance-scoped (held by the owning service), never a module global
 * (§5), so multiple service instances throttle independently.
 */
export class ExtractionLivenessWarnThrottle {
  private lastWarnAtMs: number | null = null;

  /** Warn if degraded and outside the throttle window; returns whether a WARN was emitted. */
  maybeWarn(status: ExtractionLivenessStatus, staleWindowMs: number, nowMs: number): boolean {
    if (!status.degraded) {
      // Recovered (or never degraded): reset so a fresh episode warns at once.
      this.lastWarnAtMs = null;
      return false;
    }
    if (this.lastWarnAtMs !== null && nowMs - this.lastWarnAtMs < staleWindowMs) return false;
    this.lastWarnAtMs = nowMs;
    log.warn(
      `extraction pipeline liveness degraded: ${status.degradedReason ?? "buffered turns are not being extracted"}`,
    );
    return true;
  }
}

/**
 * Normalize the `extractionLiveness` block at the read boundary. `parseConfig`
 * always populates it, but a host adapter, an older persisted config, or a
 * hand-built `PluginConfig` can hand us an absent, partial, or loosely-typed
 * block - and every liveness surface (/health, doctor, stats) must degrade to
 * the documented default (enabled, 24h window) rather than throw. Both fields
 * are coerced with the same rules as `parseExtractionLivenessConfig` (§24:
 * `"false"`/`"0"` read as falsy; a numeric string like `"5000"` parses), except a
 * present but non-integer or non-positive `staleWindowMs` falls back to the
 * default here rather than throwing.
 */
export function resolveExtractionLivenessConfig(
  block: { enabled?: unknown; staleWindowMs?: unknown } | undefined,
): ExtractionLivenessConfig {
  const staleWindowMs = coerceNumber(block?.staleWindowMs);
  return {
    enabled: coerceBool(block?.enabled) ?? true,
    staleWindowMs:
      staleWindowMs !== undefined && Number.isInteger(staleWindowMs) && staleWindowMs >= 1
        ? staleWindowMs
        : DEFAULT_STALE_WINDOW_MS,
  };
}

/**
 * Compute the daemon-wide liveness status for the authenticated `/health`
 * payload and emit the throttled aggregate warning.
 */
export async function computeExtractionLivenessStatus(
  orchestrator: ExtractionLivenessOrchestratorLike,
  watermark: ExtractionWatermarkOrStorage,
  throttle?: ExtractionLivenessWarnThrottle,
  nowMs: number = Date.now(),
): Promise<ExtractionLivenessStatus> {
  const config = resolveExtractionLivenessConfig(orchestrator.config.extractionLiveness);
  const status = await gatherExtractionLivenessStatus({
    config,
    watermark,
    buffer: orchestrator.buffer,
    nowMs,
  });
  throttle?.maybeWarn(status, config.staleWindowMs, nowMs);
  return status;
}

/**
 * `remnic doctor` check for extraction-pipeline liveness. Status `warn` when
 * degraded (with a remediation hint), `ok` otherwise.
 */
export async function summarizeExtractionLiveness(
  config: Pick<PluginConfig, "extractionLiveness">,
  watermark: ExtractionWatermarkOrStorage,
  buffer?: ExtractionBufferSource,
  nowMs: number = Date.now(),
): Promise<OperatorDoctorCheck> {
  const livenessConfig = resolveExtractionLivenessConfig(config.extractionLiveness);
  const status = await gatherExtractionLivenessStatus({
    config: livenessConfig,
    watermark,
    buffer,
    nowMs,
  });
  const scopeNote = ` Watermark scope: ${status.watermarkScope}.`;
  const summary =
    (status.degraded
      ? `Extraction pipeline degraded: ${status.degradedReason}.`
      : `Extraction pipeline healthy: last extraction ${status.lastExtractionAt ?? "never"}, ` +
        `${status.bufferedSessionCount} buffered session(s), ${status.pendingTurnCount} turn(s) pending` +
        `${livenessConfig.enabled ? "" : " (liveness check disabled)"}.`) + scopeNote;
  return {
    key: "extraction_liveness",
    status: status.degraded ? "warn" : "ok",
    summary,
    remediation: status.degraded
      ? "Extraction has stalled while turns are buffered. Inspect daemon logs for extraction " +
        "timeouts or fallback-no-parsed-output errors, verify the extraction model/provider is " +
        "reachable, then force a flush (e.g. `remnic flush`)."
      : undefined,
    details: { ...status, staleWindowMs: livenessConfig.staleWindowMs, enabled: livenessConfig.enabled },
  };
}

/**
 * Lines for `remnic stats`: the aggregate extraction watermark, root metadata
 * counters, buffer backlog, and liveness verdict. Root counter failures render
 * those counters unavailable; the injected aggregate read alone determines
 * watermark liveness so stats cannot diverge from health and doctor.
 */
export async function renderExtractionLivenessStats(
  orchestrator: ExtractionLivenessOrchestratorLike,
  watermark: ExtractionWatermarkRead,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const status = evaluateExtractionLiveness({
    config: resolveExtractionLivenessConfig(orchestrator.config.extractionLiveness),
    lastExtractionAt: watermark.lastExtractionAt,
    snapshot: await readBufferSnapshot(orchestrator.buffer),
    nowMs,
    metaReadFailed: watermark.readFailed,
    metaReadError: watermark.readError,
    watermarkPending: watermark.pending,
  });
  const oldestAge =
    status.oldestBufferedTurnAgeMs !== null ? formatAgeMs(status.oldestBufferedTurnAgeMs) : "n/a";
  const rootStats = watermark.rootStats;
  const watermarkDisplay = watermark.readFailed
    ? "unavailable"
    : watermark.pending
      ? "pending"
      : status.lastExtractionAt ?? "never";
  return [
    `Extractions: ${rootStats?.extractionCount ?? "unavailable"}`,
    `Last extraction: ${watermarkDisplay}`,
    `Last consolidation: ${rootStats ? rootStats.lastConsolidationAt ?? "never" : "unavailable"}`,
    `Buffered sessions: ${status.bufferedSessionCount} (${status.pendingTurnCount} turns pending)`,
    `Oldest buffered turn age: ${oldestAge}`,
    `Extraction watermark scope: ${status.watermarkScope}`,
    `Extraction liveness: ${status.degraded ? `DEGRADED — ${status.degradedReason}` : "ok"}`,
  ];
}
