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

/**
 * The liveness payload surfaced on `/health.extraction` and in the doctor/stats
 * details.
 *
 * DAEMON-SCOPED SIGNAL: a daemon exposes a single extraction verdict; the
 * last-extraction watermark is read from the daemon's default/root store, so
 * `/health` returns the same `extraction` block for every namespace argument.
 *
 * KNOWN LIMITATION (issue #2159): extraction stamps `lastExtractionAt` on the
 * PER-NAMESPACE store (`storageFor(selfNamespace)`), so this watermark reflects
 * only extraction that stamped the root store (default-namespace work). On a
 * single-namespace deployment (the common case) the watermark and buffer share
 * one scope and the verdict is exact. On a multi-namespace deployment the verdict
 * is NOT guaranteed correct for work isolated to a non-default namespace: it can
 * over-report `degraded` (the default namespace idle while another is extracting)
 * or miss a stall confined to a non-default namespace. Aggregating the watermark
 * across namespace stores is tracked in #2159.
 */
export interface ExtractionLivenessStatus {
  lastExtractionAt: string | null;
  bufferedSessionCount: number;
  pendingTurnCount: number;
  oldestBufferedTurnAgeMs: number | null;
  degraded: boolean;
  degradedReason: string | null;
  /**
   * Scope of the last-extraction watermark: `root-store` today (read from the
   * daemon's default/root store only), `aggregate` once it is resolved across
   * every namespace store (#2159). A monitor can alert on
   * `watermarkScope !== "aggregate"` while namespaces are enabled instead of
   * trusting a number that may be wrong in either direction.
   */
  watermarkScope: "root-store" | "aggregate";
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
  watermarkScope?: "root-store" | "aggregate";
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
  const readFailed = snapshot.readFailed === true;
  const degraded = config.enabled && (metaReadFailed || readFailed || (hasBacklog && stale));

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
    watermarkScope: input.watermarkScope ?? "root-store",
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
 * Gather the liveness status from a meta store (last-extraction watermark) and
 * an optional buffer (backlog). A read failure on EITHER side is captured and
 * surfaced as a DEGRADED status with a distinct reason (§22) rather than being
 * swallowed into a healthy-looking verdict; no failure path throws.
 */
export async function gatherExtractionLivenessStatus(input: {
  config: ExtractionLivenessConfig;
  storage: ExtractionLivenessStorageLike;
  buffer: ExtractionBufferSource | undefined;
  nowMs: number;
}): Promise<ExtractionLivenessStatus> {
  const { config, storage, buffer, nowMs } = input;
  let lastExtractionAt: string | null = null;
  let metaReadFailed = false;
  let metaReadError: string | undefined;
  try {
    lastExtractionAt = (await storage.loadMeta()).lastExtractionAt ?? null;
  } catch (err) {
    // A swallowed loadMeta() failure that reads as "never extracted" is the
    // exact §22 conflation this feature exists to kill — surface it explicitly.
    metaReadFailed = true;
    metaReadError = err instanceof Error ? err.message : String(err);
  }
  const snapshot = await readBufferSnapshot(buffer);
  return evaluateExtractionLiveness({
    config,
    lastExtractionAt,
    snapshot,
    nowMs,
    metaReadFailed,
    metaReadError,
    // Today the watermark comes from the root store only; #2159 flips this to
    // "aggregate" when the resolver reads across every namespace store.
    watermarkScope: "root-store",
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
 * Compute the liveness status for the authenticated `/health` payload and emit
 * the throttled aggregated WARN.
 *
 * The watermark is read from the daemon's default/root store (`orchestrator.storage`),
 * which is why `/health` returns the same `extraction` block for any namespace
 * argument. KNOWN LIMITATION (issue #2159): extraction writes `lastExtractionAt`
 * per-namespace, so this watermark reflects only default-namespace extraction and
 * the verdict is exact only for a single-namespace daemon (see
 * `ExtractionLivenessStatus`).
 */
export async function computeExtractionLivenessStatus(
  orchestrator: ExtractionLivenessOrchestratorLike & { storage: ExtractionLivenessStorageLike },
  throttle?: ExtractionLivenessWarnThrottle,
  nowMs: number = Date.now(),
): Promise<ExtractionLivenessStatus> {
  const config = orchestrator.config.extractionLiveness;
  const status = await gatherExtractionLivenessStatus({
    config,
    storage: orchestrator.storage,
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
  const scopeNote =
    ` Watermark scope: ${status.watermarkScope}` +
    (status.watermarkScope === "root-store"
      ? " (default-namespace only; multi-namespace aggregation tracked in #2159)."
      : ".");
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

/** Meta fields the `remnic stats` view renders directly, beyond the liveness watermark. */
type ExtractionStatsMeta = Pick<MetaState, "extractionCount" | "lastExtractionAt" | "lastConsolidationAt">;

/**
 * Lines for `remnic stats`: extraction watermark, buffer backlog, and the
 * liveness verdict so dashboards can alert on a stalled pipeline. The meta
 * watermark is loaded HERE (not by the caller) so a meta-read failure surfaces
 * as an explicit DEGRADED verdict plus "unavailable" counts (§22) instead of
 * crashing the whole `stats` command.
 */
export async function renderExtractionLivenessStats(
  orchestrator: ExtractionLivenessOrchestratorLike & { storage: { loadMeta(): Promise<ExtractionStatsMeta> } },
  nowMs: number = Date.now(),
): Promise<string[]> {
  let meta: ExtractionStatsMeta | null = null;
  let metaReadFailed = false;
  let metaReadError: string | undefined;
  try {
    meta = await orchestrator.storage.loadMeta();
  } catch (err) {
    metaReadFailed = true;
    metaReadError = err instanceof Error ? err.message : String(err);
  }
  const status = evaluateExtractionLiveness({
    config: orchestrator.config.extractionLiveness,
    lastExtractionAt: meta?.lastExtractionAt ?? null,
    snapshot: await readBufferSnapshot(orchestrator.buffer),
    nowMs,
    metaReadFailed,
    metaReadError,
  });
  const oldestAge =
    status.oldestBufferedTurnAgeMs !== null ? formatAgeMs(status.oldestBufferedTurnAgeMs) : "n/a";
  const unavailable = metaReadFailed ? "unavailable" : "never";
  return [
    `Extractions: ${meta?.extractionCount ?? unavailable}`,
    `Last extraction: ${meta?.lastExtractionAt ?? unavailable}`,
    `Last consolidation: ${meta?.lastConsolidationAt ?? unavailable}`,
    `Buffered sessions: ${status.bufferedSessionCount} (${status.pendingTurnCount} turns pending)`,
    `Oldest buffered turn age: ${oldestAge}`,
    `Extraction watermark scope: ${status.watermarkScope}`,
    `Extraction liveness: ${status.degraded ? `DEGRADED — ${status.degradedReason}` : "ok"}`,
  ];
}
