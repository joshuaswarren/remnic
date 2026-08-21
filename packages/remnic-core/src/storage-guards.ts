import { log } from "./logger.js";

const PROJECTION_FALLBACK_WARN_INTERVAL_MS = 5 * 60_000;
export const PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS = 100;
const projectionFallbackWarnedAt = new Map<string, number>();

export function assertMemoryFrontmatterId(
  fm: { id: string; category?: string; created?: string; entityRef?: string },
): void {
  if (typeof fm.id !== "string" || fm.id.trim().length === 0) {
    const context = [
      fm.category ? `category=${fm.category}` : null,
      fm.created ? `created=${fm.created}` : null,
      fm.entityRef ? `entityRef=${fm.entityRef}` : null,
    ].filter(Boolean).join(" ");
    throw new Error(
      `memory frontmatter id must not be blank${context ? ` (${context})` : ""}`,
    );
  }
}

export interface ProjectionLedgerLagTelemetry {
  projectedEvents: number;
  currentLedgerEvents: number;
  deltaEvents: number;
  warnThresholdEvents?: number;
}

export function warnProjectionFallback(
  memoryDir: string,
  consumer: string,
  detail?: () => string | undefined,
  ledgerLag?: ProjectionLedgerLagTelemetry,
): null {
  const fallback = `storage.${consumer}: memory projection absent or empty; falling back to full corpus`;
  const thresholdEvents = Math.max(
    0,
    Math.floor(ledgerLag?.warnThresholdEvents ?? PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS),
  );
  const lag = ledgerLag
    ? `projected_events=${ledgerLag.projectedEvents} current_ledger_events=${ledgerLag.currentLedgerEvents} `
      + `delta_events=${ledgerLag.deltaEvents} threshold_events=${thresholdEvents} `
      + "fallback_action=full-ledger-scan"
    : undefined;

  if (ledgerLag && ledgerLag.deltaEvents <= thresholdEvents) {
    const suffix = [detail?.(), lag].filter(Boolean).join("; ");
    log.debug(`${fallback}${suffix ? ` (${suffix})` : ""}`);
    return null;
  }

  const key = `${memoryDir}\0${consumer}`;
  const now = Date.now();
  const warnedAt = projectionFallbackWarnedAt.get(key) ?? 0;
  if (now - warnedAt >= PROJECTION_FALLBACK_WARN_INTERVAL_MS) {
    projectionFallbackWarnedAt.set(key, now);
    const suffix = [detail?.(), lag].filter(Boolean).join("; ");
    log.warn(`${fallback}${suffix ? ` (${suffix})` : ""}`);
  }
  return null;
}

/** @internal Test seam (#2119): clear the fallback-warn rate-limit dedup map so
 *  a focused test can prove the once-per-interval spam suppression from a clean
 *  slate regardless of prior tests in the same process. */
export function __resetProjectionFallbackWarnSuppressionForTest(): void {
  projectionFallbackWarnedAt.clear();
}
