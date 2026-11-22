import type { ProviderConfig } from "./types.js";

const BUILT_IN_PROVIDERS = [
  "openai",
  "anthropic",
  "ollama",
  "litellm",
  "local-llm",
  "codex-cli",
  "claude-cli",
] as const;

const BENCH_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

function quotedList(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  return quoted.length <= 1
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

const PROVIDER_ENUM_LIST = quotedList(BUILT_IN_PROVIDERS);
const REASONING_EFFORT_LIST = quotedList(BENCH_REASONING_EFFORTS);

const PROVIDER_CONFIG_FIELD_MARKERS = {
  provider: true,
  model: true,
  rubricVersion: true,
  baseUrl: true,
  apiKey: true,
  retryOptions: true,
  providerRequestTimeoutMs: true,
  disableThinking: true,
  reasoningEffort: true,
  responderContextBudgetChars: true,
  responderPromptBudgetChars: true,
  temperature: true,
  seed: true,
} satisfies Record<keyof ProviderConfig, true>;

export type ValidatedProviderConfigField = keyof typeof PROVIDER_CONFIG_FIELD_MARKERS;

export const PROVIDER_CONFIG_VALIDATED_FIELDS: readonly ValidatedProviderConfigField[] =
  Object.keys(PROVIDER_CONFIG_FIELD_MARKERS) as ValidatedProviderConfigField[];

export interface ProviderConfigIssue {
  /** Field path relative to the provider config root (e.g. `retryOptions.maxAttempts`). */
  readonly fieldPath: string;
  /** What the field must be, phrased to follow the field path. */
  readonly reason: string;
}

type JsonRecord = Record<string, unknown>;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function checkOptional(
  container: JsonRecord,
  key: string,
  accept: (value: unknown) => boolean,
  reason: string,
): ProviderConfigIssue | null {
  if (!(key in container)) {
    return null;
  }
  return accept(container[key]) ? null : { fieldPath: key, reason };
}

function firstIssue(...issues: Array<ProviderConfigIssue | null>): ProviderConfigIssue | null {
  for (const issue of issues) {
    if (issue !== null) {
      return issue;
    }
  }
  return null;
}

/**
 * Validate the complete `ProviderConfig` shape. Returns `null` when valid
 * (absent optional fields are valid), otherwise the first offending field
 * path and its canonical requirement. `null`/`undefined` inputs are invalid
 * here; callers that treat an absent provider as legal check that first.
 */
export function validateProviderConfigShape(value: unknown): ProviderConfigIssue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { fieldPath: "", reason: "must be a provider config ({ provider, model })" };
  }
  const config = value as JsonRecord;
  if (!(BUILT_IN_PROVIDERS as readonly string[]).includes(config.provider as string)) {
    return { fieldPath: "provider", reason: `must be one of ${PROVIDER_ENUM_LIST}` };
  }
  if (typeof config.model !== "string") {
    return { fieldPath: "model", reason: "must be a string" };
  }
  const rootIssue = firstIssue(
    checkOptional(config, "rubricVersion", (v) => typeof v === "string", "must be a string when present"),
    checkOptional(config, "baseUrl", (v) => typeof v === "string", "must be a string when present"),
    checkOptional(config, "apiKey", (v) => typeof v === "string", "must be a string when present"),
    checkOptional(config, "providerRequestTimeoutMs", isPositiveInteger, "must be a positive integer when present"),
    checkOptional(config, "disableThinking", (v) => typeof v === "boolean", "must be a boolean when present"),
    checkOptional(
      config,
      "reasoningEffort",
      (v) => (BENCH_REASONING_EFFORTS as readonly string[]).includes(v as string),
      `must be one of ${REASONING_EFFORT_LIST} when present`,
    ),
    checkOptional(config, "responderContextBudgetChars", isPositiveInteger, "must be a positive integer when present"),
    checkOptional(config, "responderPromptBudgetChars", isPositiveInteger, "must be a positive integer when present"),
    checkOptional(config, "temperature", isNonNegativeFinite, "must be a finite non-negative number when present"),
    checkOptional(config, "seed", isNonNegativeInteger, "must be a non-negative integer when present"),
  );
  if (rootIssue) {
    return rootIssue;
  }
  if (!("retryOptions" in config)) {
    return null;
  }
  const retry = config.retryOptions;
  if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
    return { fieldPath: "retryOptions", reason: "must be an object when present" };
  }
  const retryOptions = retry as JsonRecord;
  const retryIssue = firstIssue(
    checkOptional(retryOptions, "maxAttempts", isPositiveInteger, "must be a positive integer when present"),
    checkOptional(retryOptions, "baseBackoffMs", isNonNegativeFinite, "must be a finite non-negative number when present"),
    checkOptional(retryOptions, "timeoutMs", isNonNegativeFinite, "must be a finite non-negative number when present"),
    checkOptional(retryOptions, "retryOnTimeout", (v) => typeof v === "boolean", "must be a boolean when present"),
    checkOptional(retryOptions, "max429WaitMs", isNonNegativeFinite, "must be a finite non-negative number when present"),
  );
  return retryIssue ? { fieldPath: `retryOptions.${retryIssue.fieldPath}`, reason: retryIssue.reason } : null;
}
