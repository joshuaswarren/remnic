
import { coerceBool, coerceNumber } from "./connectors/coerce.js";

function parseIntegerAtLeast(
  value: unknown,
  fallback: number,
  min: number,
  keyName: string,
): number {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < min
  ) {
    throw new Error(
      `${keyName} must be an integer greater than or equal to ${min}; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

/**
 * Parse the extraction faithfulness gate config block.
 *
 * Returns exactly the `PluginConfig` fields this block owns. Defaults preserve
 * the byte-identical pre-feature pipeline (rule 39): gate "off", empty model
 * + base URL, context 400 chars, timeout 8000 ms. Invalid `gate` values reject
 * listing valid options (rule 51); invalid integers throw (issue #1634).
 *
 * `extractionFaithfulnessBaseUrl` (issue #1585) is the model-lab pointer: when
 * set together with `extractionFaithfulnessModel`, the gate routes to that
 * local openai-compatible endpoint before the configured chain; empty string
 * (default) preserves the existing routing exactly.
 */
export function parseFaithfulnessGateConfig(cfg: Record<string, unknown>): {
  extractionFaithfulnessGate: "off" | "shadow" | "enforce";
  extractionFaithfulnessModel: string;
  extractionFaithfulnessBaseUrl: string;
  extractionFaithfulnessContextChars: number;
  extractionFaithfulnessTimeoutMs: number;
  extractionFaithfulnessLocalParseFallback: boolean;
} {
  const gateValue = cfg.extractionFaithfulnessGate;
  let extractionFaithfulnessGate: "off" | "shadow" | "enforce";
  if (gateValue === undefined || gateValue === null) {
    extractionFaithfulnessGate = "off";
  } else {
    const raw = typeof gateValue === "string" ? gateValue.trim().toLowerCase() : gateValue;
    if (raw === "off" || raw === "shadow" || raw === "enforce") {
      extractionFaithfulnessGate = raw;
    } else {
      throw new Error(
        `extractionFaithfulnessGate must be one of "off" | "shadow" | "enforce" (got ${JSON.stringify(gateValue)})`,
      );
    }
  }

  const extractionFaithfulnessModel =
    typeof cfg.extractionFaithfulnessModel === "string" ? cfg.extractionFaithfulnessModel : "";

  const extractionFaithfulnessBaseUrl =
    typeof cfg.extractionFaithfulnessBaseUrl === "string"
      ? cfg.extractionFaithfulnessBaseUrl
      : "";

  const extractionFaithfulnessContextChars = Math.min(
    parseIntegerAtLeast(cfg.extractionFaithfulnessContextChars, 400, 1, "extractionFaithfulnessContextChars"),
    4000,
  );

  const extractionFaithfulnessTimeoutMs = Math.min(
    parseIntegerAtLeast(cfg.extractionFaithfulnessTimeoutMs, 8000, 1, "extractionFaithfulnessTimeoutMs"),
    60_000,
  );

  const extractionFaithfulnessLocalParseFallback =
    coerceBool(cfg.extractionFaithfulnessLocalParseFallback) === true;

  return {
    extractionFaithfulnessGate,
    extractionFaithfulnessModel,
    extractionFaithfulnessBaseUrl,
    extractionFaithfulnessContextChars,
    extractionFaithfulnessTimeoutMs,
    extractionFaithfulnessLocalParseFallback,
  };
}

/**
 * Parse the correction-intent config block (issue #1581 / #1585).
 *
 * The model-lab pointer for passive-correction detection: when both
 * `correctionIntentModel` and `correctionIntentBaseUrl` are set, the detection
 * path can route to that local fine-tuned classifier; empty defaults (the
 * common case) keep the rule-based `detectPassiveCorrections` heuristic as the
 * sole detector — byte-identical to the pre-feature path. Consumption by the
 * detector is the consuming child's job (#1581's detector is a pure function;
 * wiring a model call into it is out of scope for this config-pointer PR).
 */
export function parseCorrectionIntentConfig(cfg: Record<string, unknown>): {
  correctionIntentModel: string;
  correctionIntentBaseUrl: string;
} {
  return {
    correctionIntentModel:
      typeof cfg.correctionIntentModel === "string" ? cfg.correctionIntentModel : "",
    correctionIntentBaseUrl:
      typeof cfg.correctionIntentBaseUrl === "string" ? cfg.correctionIntentBaseUrl : "",
  };
}
