/**
 * Recall audit config parsing, extracted from config.ts to keep that
 * grandfathered file within its structural-ratchet ceiling (#1520).
 * The parsed fields still live on {@link PluginConfig}; this only relocates
 * the coercion/validation logic.
 */
import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import type { PluginConfig } from "./types.js";

/** Default rolling window (ms) for the anomaly detector: 5 minutes. */
const ANOMALY_WINDOW_MS_DEFAULT = 5 * 60_000;

function floorAtLeast(n: number | undefined, min: number, fallback: number): number {
  if (n === undefined) return fallback;
  const floored = Math.floor(n);
  return floored >= min ? floored : fallback;
}

/**
 * Parse the recall audit-log and audit-anomaly knobs from raw config.
 *
 * `recallAuditLogEnabled` (issue #3548) and
 * `recallAuditAnomalyDetectionEnabled` both ship disabled so existing
 * deployments write nothing new to disk and run no detectors. The two flags
 * are independent: either may construct the audit adapter, and only its own
 * behavior activates.
 *
 * Thresholds floor AFTER validating the floored value is still >= 1 — a
 * `0.5` input that floors to 0 would turn every detector into a
 * flood-on-anything, flipping the default to max-noise instead of
 * max-silence.
 */
export function parseRecallAuditConfig(
  // Raw plugin config is intentionally open: parseConfig receives arbitrary
  // operator JSON and coerces key-by-key, same contract as the sibling
  // parseRecallConcurrencyConfig.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  cfg: Record<string, unknown>,
): Pick<
  PluginConfig,
  | "recallAuditAnomalyDetectionEnabled"
  | "recallAuditLogEnabled"
  | "recallAuditAnomalyWindowMs"
  | "recallAuditAnomalyRepeatQueryLimit"
  | "recallAuditAnomalyNamespaceWalkLimit"
  | "recallAuditAnomalyHighCardinalityLimit"
  | "recallAuditAnomalyRapidFireLimit"
> {
  return {
    recallAuditAnomalyDetectionEnabled:
      coerceBool(cfg.recallAuditAnomalyDetectionEnabled) ?? false,
    recallAuditLogEnabled: coerceBool(cfg.recallAuditLogEnabled) ?? false,
    recallAuditAnomalyWindowMs: floorAtLeast(
      coerceNumber(cfg.recallAuditAnomalyWindowMs),
      1,
      ANOMALY_WINDOW_MS_DEFAULT,
    ),
    recallAuditAnomalyRepeatQueryLimit: floorAtLeast(
      coerceNumber(cfg.recallAuditAnomalyRepeatQueryLimit),
      1,
      5,
    ),
    recallAuditAnomalyNamespaceWalkLimit: floorAtLeast(
      coerceNumber(cfg.recallAuditAnomalyNamespaceWalkLimit),
      1,
      3,
    ),
    recallAuditAnomalyHighCardinalityLimit: floorAtLeast(
      coerceNumber(cfg.recallAuditAnomalyHighCardinalityLimit),
      1,
      50,
    ),
    recallAuditAnomalyRapidFireLimit: floorAtLeast(
      coerceNumber(cfg.recallAuditAnomalyRapidFireLimit),
      1,
      30,
    ),
  };
}
