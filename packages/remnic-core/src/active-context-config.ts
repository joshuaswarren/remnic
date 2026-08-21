import { coerceBooleanLike, coerceNumber } from "./connectors/coerce.js";

export interface ActiveContextConfigFields {
  activeContextTransformLlmEnabled: boolean;
  activeContextMaxMessages: number;
  activeContextMaxSnapshotChars: number;
  activeContextSummaryMaxTokens: number;
  activeContextMinRetainedMessages: number;
  activeContextPlanTtlMinutes: number;
  activeContextRetentionMaxBytes: number;
}

export interface ActiveContextCapabilitySet {
  readonly activeContextTransforms: boolean;
  readonly activeContextMaxMessages: number;
  readonly activeContextMaxSnapshotChars: number;
  readonly activeContextSummaryMaxTokens: number;
  readonly activeContextMinRetainedMessages: number;
  readonly activeContextPlanTtlMinutes: number;
  readonly activeContextRetentionMaxBytes: number;
  readonly activeContextLlm: boolean;
}

export const DEFAULT_ACTIVE_CONTEXT_CAPS: Readonly<
  Omit<ActiveContextCapabilitySet, "activeContextTransforms" | "activeContextLlm">
> = Object.freeze({
  activeContextMaxMessages: 200,
  activeContextMaxSnapshotChars: 200_000,
  activeContextSummaryMaxTokens: 512,
  activeContextMinRetainedMessages: 3,
  activeContextPlanTtlMinutes: 15,
  activeContextRetentionMaxBytes: 1_000_000,
});

export type ActiveContextConfigProjection = ActiveContextConfigFields & {
  contextCompressionActionsEnabled: boolean;
};

export function resolveActiveContextCapabilities(
  projection: ActiveContextConfigProjection,
): ActiveContextCapabilitySet {
  return Object.freeze({
    activeContextTransforms: projection.contextCompressionActionsEnabled,
    activeContextMaxMessages: projection.activeContextMaxMessages,
    activeContextMaxSnapshotChars: projection.activeContextMaxSnapshotChars,
    activeContextSummaryMaxTokens: projection.activeContextSummaryMaxTokens,
    activeContextMinRetainedMessages: projection.activeContextMinRetainedMessages,
    activeContextPlanTtlMinutes: projection.activeContextPlanTtlMinutes,
    activeContextRetentionMaxBytes: projection.activeContextRetentionMaxBytes,
    activeContextLlm: projection.activeContextTransformLlmEnabled,
  });
}

function activeContextCap(raw: unknown, key: string, fallback: number, hardCap: number): number {
  if (raw === undefined || raw === null) return fallback;
  const value = coerceNumber(raw, key);
  if (value === undefined || value <= 0 || value > hardCap) {
    throw new Error(`${key} must be a finite number in (0, ${hardCap}]; got ${JSON.stringify(raw)}`);
  }
  return Math.floor(value);
}

export function parseActiveContextFields(cfg: Record<string, unknown>): ActiveContextConfigFields {
  return {
    activeContextTransformLlmEnabled: coerceBooleanLike(cfg.activeContextTransformLlmEnabled) ?? false,
    activeContextMaxMessages: activeContextCap(cfg.activeContextMaxMessages, "activeContextMaxMessages", 200, 1000),
    activeContextMaxSnapshotChars: activeContextCap(
      cfg.activeContextMaxSnapshotChars,
      "activeContextMaxSnapshotChars",
      200_000,
      1_000_000,
    ),
    activeContextSummaryMaxTokens: activeContextCap(
      cfg.activeContextSummaryMaxTokens,
      "activeContextSummaryMaxTokens",
      512,
      4096,
    ),
    activeContextMinRetainedMessages: activeContextCap(
      cfg.activeContextMinRetainedMessages,
      "activeContextMinRetainedMessages",
      3,
      50,
    ),
    activeContextPlanTtlMinutes: activeContextCap(
      cfg.activeContextPlanTtlMinutes,
      "activeContextPlanTtlMinutes",
      15,
      1440,
    ),
    activeContextRetentionMaxBytes: activeContextCap(
      cfg.activeContextRetentionMaxBytes,
      "activeContextRetentionMaxBytes",
      1_000_000,
      10_000_000,
    ),
  };
}
