import { coerceBool, coerceNumber } from "./connectors/coerce.js";

export interface GraphPathScoringConfig {
  enabled: boolean;
  invalidNodePenalty: number;
  includePathInProvenance: boolean;
}

function resolveBooleanConfig(value: unknown, defaultValue: boolean, keyName: string): boolean {
  if (value === undefined || value === null) return defaultValue;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `${keyName} must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

export function parseGraphPathScoringConfig(
  cfg: Record<string, unknown> | undefined,
): GraphPathScoringConfig {
  if (cfg !== undefined && (typeof cfg !== "object" || Array.isArray(cfg))) {
    throw new Error("graphPathScoring must be a plain object");
  }
  const block = cfg ?? {};
  const invalidNodePenalty = coerceNumber(block.invalidNodePenalty);
  if (
    invalidNodePenalty === undefined ||
    !Number.isFinite(invalidNodePenalty) ||
    invalidNodePenalty <= 0 ||
    invalidNodePenalty > 1
  ) {
    if (block.invalidNodePenalty !== undefined) {
      throw new Error(
        `graphPathScoring.invalidNodePenalty must be a number in (0,1]; got ${JSON.stringify(block.invalidNodePenalty)}`,
      );
    }
  }
  return {
    enabled: resolveBooleanConfig(block.enabled, false, "graphPathScoring.enabled"),
    invalidNodePenalty:
      invalidNodePenalty !== undefined &&
      Number.isFinite(invalidNodePenalty) &&
      invalidNodePenalty > 0 &&
      invalidNodePenalty <= 1
        ? invalidNodePenalty
        : 0.2,
    includePathInProvenance: resolveBooleanConfig(
      block.includePathInProvenance,
      true,
      "graphPathScoring.includePathInProvenance",
    ),
  };
}
