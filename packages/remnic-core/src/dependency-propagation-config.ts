import { coerceBooleanLike, coerceNumber } from "./connectors/coerce.js";
import type { DependencyPropagationConfig } from "./types.js";

const DEFAULT_LINK_TYPES: DependencyPropagationConfig["linkTypes"] = ["supports", "follows"];
const ALLOWED_LINK_TYPES: Record<DependencyPropagationConfig["linkTypes"][number], true> = {
  supports: true,
  follows: true,
  references: true,
};

function parseBoolean(value: unknown, fallback: boolean, keyName: string): boolean {
  if (value === undefined) return fallback;
  const parsed = coerceBooleanLike(value, keyName);
  if (parsed === undefined) {
    throw new Error(`${keyName} must be a boolean; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseIntegerAtLeast(value: unknown, min: number, fallback: number, keyName: string): number {
  if (value === undefined) return fallback;
  const parsed = coerceNumber(value, keyName);
  if (
    parsed === undefined ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min
  ) {
    throw new Error(
      `${keyName} must be ${min === 0 ? "a non-negative" : "a positive"} integer; got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseLinkTypes(value: unknown): DependencyPropagationConfig["linkTypes"] {
  if (value === undefined) return [...DEFAULT_LINK_TYPES];
  if (!Array.isArray(value)) {
    throw new Error(`dependencyPropagation.linkTypes must be an array; got ${JSON.stringify(value)}`);
  }
  const linkTypes: DependencyPropagationConfig["linkTypes"] = [];
  for (const linkType of value) {
    if (
      typeof linkType !== "string" ||
      !Object.hasOwn(ALLOWED_LINK_TYPES, linkType)
    ) {
      throw new Error(
        "dependencyPropagation.linkTypes must contain only supports, follows, references",
      );
    }
    if (!linkTypes.includes(linkType as DependencyPropagationConfig["linkTypes"][number])) {
      linkTypes.push(linkType as DependencyPropagationConfig["linkTypes"][number]);
    }
  }
  return linkTypes;
}

export function parseDependencyPropagationConfig(
  cfg: Record<string, unknown>,
): DependencyPropagationConfig {
  const raw = cfg.dependencyPropagation;
  if (raw === undefined) {
    return {
      enabled: false,
      linkTypes: [...DEFAULT_LINK_TYPES],
      maxDependents: 10,
      timeoutMs: 20_000,
      dryRun: false,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`dependencyPropagation must be a plain object; got ${JSON.stringify(raw)}`);
  }

  const block = raw as Record<string, unknown>;

  return {
    enabled: parseBoolean(block.enabled, false, "dependencyPropagation.enabled"),
    linkTypes: parseLinkTypes(block.linkTypes),
    maxDependents: parseIntegerAtLeast(
      block.maxDependents,
      0,
      10,
      "dependencyPropagation.maxDependents",
    ),
    timeoutMs: parseIntegerAtLeast(
      block.timeoutMs,
      1,
      20_000,
      "dependencyPropagation.timeoutMs",
    ),
    dryRun: parseBoolean(block.dryRun, false, "dependencyPropagation.dryRun"),
  };
}
