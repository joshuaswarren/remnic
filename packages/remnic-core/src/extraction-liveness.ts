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
import type { OperatorDoctorCheck } from "./operator-toolkit.js";
import type { MetaState, PluginConfig } from "./types.js";

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
}

export interface ExtractionBufferSource {
  getBufferSnapshot(): Promise<ExtractionBufferSnapshot>;
}

/** The liveness payload surfaced on `/health.extraction` and in the doctor/stats details. */
export interface ExtractionLivenessStatus {
  lastExtractionAt: string | null;
  bufferedSessionCount: number;
  pendingTurnCount: number;
  oldestBufferedTurnAgeMs: number | null;
  degraded: boolean;
  degradedReason: string | null;
}

interface ExtractionLivenessStorageLike {
  loadMeta(): Promise<Pick<MetaState, "lastExtractionAt">>;
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
  const staleRaw = coerceNumber(block.staleWindowMs);
  return {
    // `?? true` keeps the default on when the key is absent while honoring
    // explicit "false"/"0"/false opt-outs (coerceBool handles the string forms).
    enabled: coerceBool(block.enabled) ?? true,
    staleWindowMs:
      staleRaw !== undefined && Number.isFinite(staleRaw) && staleRaw > 0
        ? Math.floor(staleRaw)
        : DEFAULT_STALE_WINDOW_MS,
  };
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
 * Pure liveness verdict. Degraded ONLY when the feature is enabled, the buffer
 * is non-empty, and the last-successful-extraction watermark is absent or stale.
 *
 * Staleness uses a half-open freshness window (§23): an extraction is fresh
 * while its age is in `[0, staleWindowMs)`, so an age of EXACTLY `staleWindowMs`
 * is stale (the upper bound on "fresh" is exclusive). A null/unparsable
 * watermark means "never succeeded" and is treated as stale.
 */
export function evaluateExtractionLiveness(input: {
  config: ExtractionLivenessConfig;
  lastExtractionAt: string | null;
  snapshot: ExtractionBufferSnapshot;
  nowMs: number;
}): ExtractionLivenessStatus {
  const { config, lastExtractionAt, snapshot, nowMs } = input;
  const lastMs = lastExtractionAt !== null ? Date.parse(lastExtractionAt) : Number.NaN;
  const hasWatermark = Number.isFinite(lastMs);
  const stale = !hasWatermark || nowMs - lastMs >= config.staleWindowMs;
  const hasBacklog = snapshot.bufferedSessionCount > 0;
  const degraded = config.enabled && hasBacklog && stale;

  let degradedReason: string | null = null;
  if (degraded) {
    const watermark = hasWatermark
      ? `last succeeded ${formatAgeMs(nowMs - lastMs)} ago`
      : "no successful extraction on record";
    degradedReason =
      `${watermark}; ${snapshot.bufferedSessionCount} buffered session(s), ` +
      `${snapshot.pendingTurnCount} turn(s) pending extraction`;
  }

  return {
    lastExtractionAt,
    bufferedSessionCount: snapshot.bufferedSessionCount,
    pendingTurnCount: snapshot.pendingTurnCount,
    oldestBufferedTurnAgeMs: ageMsFrom(snapshot.oldestTurnTimestamp, nowMs),
    degraded,
    degradedReason,
  };
}

const EMPTY_SNAPSHOT: ExtractionBufferSnapshot = {
  bufferedSessionCount: 0,
  pendingTurnCount: 0,
  oldestTurnTimestamp: null,
};

/**
 * Read a buffer snapshot, degrading to an empty snapshot (not throwing) when
 * the buffer is absent — some service constructions have no orchestrator buffer.
 */
async function readBufferSnapshot(
  buffer: ExtractionBufferSource | undefined,
): Promise<ExtractionBufferSnapshot> {
  if (!buffer || typeof buffer.getBufferSnapshot !== "function") return EMPTY_SNAPSHOT;
  try {
    return await buffer.getBufferSnapshot();
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Gather the liveness status from a meta store (last-extraction watermark) and
 * an optional buffer (backlog). Every failure path degrades gracefully to a
 * well-formed, non-degraded status rather than throwing.
 */
export async function gatherExtractionLivenessStatus(input: {
  config: ExtractionLivenessConfig;
  storage: ExtractionLivenessStorageLike;
  buffer: ExtractionBufferSource | undefined;
  nowMs: number;
}): Promise<ExtractionLivenessStatus> {
  const { config, storage, buffer, nowMs } = input;
  let lastExtractionAt: string | null = null;
  try {
    lastExtractionAt = (await storage.loadMeta()).lastExtractionAt ?? null;
  } catch {
    lastExtractionAt = null;
  }
  const snapshot = await readBufferSnapshot(buffer);
  return evaluateExtractionLiveness({ config, lastExtractionAt, snapshot, nowMs });
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
 * Compute the liveness status for the authenticated `/health` payload and emit
 * the throttled aggregated WARN. Reads config + buffer from the orchestrator and
 * the last-extraction watermark from the resolved namespace storage.
 */
export async function computeExtractionLivenessStatus(
  orchestrator: ExtractionLivenessOrchestratorLike,
  storage: ExtractionLivenessStorageLike,
  throttle?: ExtractionLivenessWarnThrottle,
  nowMs: number = Date.now(),
): Promise<ExtractionLivenessStatus> {
  const config = orchestrator.config.extractionLiveness;
  const status = await gatherExtractionLivenessStatus({
    config,
    storage,
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
  storage: ExtractionLivenessStorageLike,
  buffer?: ExtractionBufferSource,
  nowMs: number = Date.now(),
): Promise<OperatorDoctorCheck> {
  const livenessConfig = config.extractionLiveness;
  const status = await gatherExtractionLivenessStatus({
    config: livenessConfig,
    storage,
    buffer,
    nowMs,
  });
  const summary = status.degraded
    ? `Extraction pipeline degraded: ${status.degradedReason}.`
    : `Extraction pipeline healthy: last extraction ${status.lastExtractionAt ?? "never"}, ` +
      `${status.bufferedSessionCount} buffered session(s), ${status.pendingTurnCount} turn(s) pending` +
      `${livenessConfig.enabled ? "" : " (liveness check disabled)"}.`;
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
 * Lines for `remnic stats`: extraction watermark, buffer backlog, and the
 * liveness verdict so dashboards can alert on a stalled pipeline.
 */
export async function renderExtractionLivenessStats(
  orchestrator: ExtractionLivenessOrchestratorLike,
  meta: Pick<MetaState, "extractionCount" | "lastExtractionAt" | "lastConsolidationAt">,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const status = await gatherExtractionLivenessStatus({
    config: orchestrator.config.extractionLiveness,
    storage: { loadMeta: async () => ({ lastExtractionAt: meta.lastExtractionAt ?? null }) },
    buffer: orchestrator.buffer,
    nowMs,
  });
  const oldestAge =
    status.oldestBufferedTurnAgeMs !== null ? formatAgeMs(status.oldestBufferedTurnAgeMs) : "n/a";
  return [
    `Extractions: ${meta.extractionCount}`,
    `Last extraction: ${meta.lastExtractionAt ?? "never"}`,
    `Last consolidation: ${meta.lastConsolidationAt ?? "never"}`,
    `Buffered sessions: ${status.bufferedSessionCount} (${status.pendingTurnCount} turns pending)`,
    `Oldest buffered turn age: ${oldestAge}`,
    `Extraction liveness: ${status.degraded ? `DEGRADED — ${status.degradedReason}` : "ok"}`,
  ];
}
