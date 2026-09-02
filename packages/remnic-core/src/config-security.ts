import { coerceBool } from "./connectors/coerce.js";
import { readEnvVar } from "./runtime/env.js";
import {
  DEFAULT_UNTRUSTED_ORIGINS,
  HARDENED_UNTRUSTED_ORIGINS,
} from "./security/origin-authority.js";
import type { MemoryInjectionDefenseMode } from "./security/types.js";
import type { InjectionScreenProfile } from "./security/injection-screen.js";

// Memory-poisoning hardening (#1955): preserve explicit config, but let env
// values replace schema-materialized defaults from the host config loader.
function resolveSecurityBooleanConfig(
  value: unknown,
  rawOperatorConfig: Record<string, unknown> | null | undefined,
  flagName: string,
  envName: string,
  defaultValue: boolean,
): boolean {
  const rawAuthored =
    rawOperatorConfig !== undefined &&
    rawOperatorConfig !== null &&
    Object.prototype.hasOwnProperty.call(rawOperatorConfig, flagName) &&
    rawOperatorConfig[flagName] !== undefined &&
    rawOperatorConfig[flagName] !== null;
  const schemaDefaultMaterialized =
    rawOperatorConfig !== undefined &&
    !rawAuthored &&
    value === defaultValue;
  if (!schemaDefaultMaterialized && value !== undefined && value !== null) {
    return resolveBooleanConfig(value, defaultValue, flagName);
  }
  if (rawAuthored) {
    return resolveBooleanConfig(value ?? rawOperatorConfig?.[flagName], defaultValue, flagName);
  }
  const envValue = readEnvVar(envName);
  return envValue === undefined
    ? defaultValue
    : resolveBooleanConfig(envValue, defaultValue, flagName);
}

function resolveBooleanConfig(
  value: unknown,
  defaultValue: boolean,
  keyName: string,
): boolean {
  if (value === undefined || value === null) return defaultValue;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `${keyName} must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

// Memory-poisoning hardening (#1955): keep origin allow-list parsing in the
// parser module so config-contract extraction covers this delegated surface.
function resolveUntrustedOrigins(
  value: unknown,
  rawOperatorConfig: Record<string, unknown> | null | undefined,
): string[] {
  const rawAuthored =
    rawOperatorConfig !== undefined &&
    rawOperatorConfig !== null &&
    Object.prototype.hasOwnProperty.call(rawOperatorConfig, "untrustedOrigins") &&
    rawOperatorConfig.untrustedOrigins !== undefined &&
    rawOperatorConfig.untrustedOrigins !== null;
  const schemaDefaultMaterialized =
    rawOperatorConfig !== undefined &&
    !rawAuthored &&
    Array.isArray(value) &&
    value.length === DEFAULT_UNTRUSTED_ORIGINS.length &&
    value.every((entry, index) => entry === DEFAULT_UNTRUSTED_ORIGINS[index]);
  const configValue = schemaDefaultMaterialized ? undefined : value;
  const fromEnv = configValue === undefined || configValue === null;
  const envValue = fromEnv ? readEnvVar("REMNIC_UNTRUSTED_ORIGINS") : undefined;
  const source = fromEnv ? envValue : configValue;
  if (source === undefined || source === null) return [...DEFAULT_UNTRUSTED_ORIGINS];

  let entries: unknown[];
  if (Array.isArray(source)) {
    entries = source;
  } else if (fromEnv && typeof source === "string" && source.trim().length > 0) {
    const trimmed = source.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        entries = parsed;
      } catch {
        throw new Error("untrustedOrigins must be an array of strings");
      }
    } else {
      entries = trimmed.split(",");
    }
  } else {
    throw new Error("untrustedOrigins must be an array of strings");
  }

  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new Error("untrustedOrigins must be an array of strings");
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_UNTRUSTED_ORIGINS];
}

function validateDefenseMode(value: unknown): MemoryInjectionDefenseMode {
  if (
    value === "custom"
    || value === "off"
    || value === "fencing"
    || value === "quarantine"
    || value === "layered"
  ) {
    return value;
  }
  throw new Error(
    `memoryInjectionDefenseMode must be custom|off|fencing|quarantine|layered; got ${JSON.stringify(value)}`,
  );
}

function isOperatorAuthored(
  rawOperatorConfig: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return rawOperatorConfig !== undefined
    && rawOperatorConfig !== null
    && Object.prototype.hasOwnProperty.call(rawOperatorConfig, key)
    && (rawOperatorConfig as Record<string, unknown>)[key] !== undefined
    && (rawOperatorConfig as Record<string, unknown>)[key] !== null;
}

function resolveMemoryInjectionDefenseMode(
  value: unknown,
  rawOperatorConfig: Record<string, unknown> | null | undefined,
): MemoryInjectionDefenseMode {
  // Precedence: operator-authored config, then the environment, then a
  // host-materialized schema default. A host that fills in the manifest
  // default must not shadow an operator's environment override.
  if (isOperatorAuthored(rawOperatorConfig, "memoryInjectionDefenseMode")) {
    return validateDefenseMode(
      (rawOperatorConfig as Record<string, unknown>).memoryInjectionDefenseMode,
    );
  }
  const envValue = readEnvVar("REMNIC_MEMORY_INJECTION_DEFENSE_MODE");
  if (envValue !== undefined && rawOperatorConfig !== undefined) return validateDefenseMode(envValue);
  if (value !== undefined && value !== null) return validateDefenseMode(value);
  if (envValue !== undefined) return validateDefenseMode(envValue);
  return "custom";
}

function hasExplicitUntrustedOrigins(
  cfg: Record<string, unknown>,
  rawOperatorConfig: Record<string, unknown> | null | undefined,
): boolean {
  const configAuthored = rawOperatorConfig === undefined
    ? Object.prototype.hasOwnProperty.call(cfg, "untrustedOrigins")
    : rawOperatorConfig !== null
      && Object.prototype.hasOwnProperty.call(rawOperatorConfig, "untrustedOrigins");
  return configAuthored || readEnvVar("REMNIC_UNTRUSTED_ORIGINS") !== undefined;
}

export function parseSecurityConfig(
  cfg: Record<string, unknown>,
  rawOperatorConfig: Record<string, unknown> | null | undefined,
): {
  memoryInjectionDefenseMode: MemoryInjectionDefenseMode;
  originAuthorityEnabled: boolean;
  injectionScreenEnabled: boolean;
  injectionScreenProfile: InjectionScreenProfile;
  untrustedOrigins: string[];
} {
  const memoryInjectionDefenseMode = resolveMemoryInjectionDefenseMode(
    cfg.memoryInjectionDefenseMode,
    rawOperatorConfig,
  );
  const customOriginAuthority = resolveSecurityBooleanConfig(
    cfg.originAuthorityEnabled,
    rawOperatorConfig,
    "originAuthorityEnabled",
    "REMNIC_ORIGIN_AUTHORITY_ENABLED",
    false,
  );
  const customInjectionScreen = resolveSecurityBooleanConfig(
    cfg.injectionScreenEnabled,
    rawOperatorConfig,
    "injectionScreenEnabled",
    "REMNIC_INJECTION_SCREEN_ENABLED",
    true,
  );
  const flags = {
    custom: [customOriginAuthority, customInjectionScreen],
    off: [false, false],
    fencing: [true, false],
    quarantine: [false, true],
    layered: [true, true],
  } satisfies Record<MemoryInjectionDefenseMode, readonly [boolean, boolean]>;
  const [originAuthorityEnabled, injectionScreenEnabled] = flags[memoryInjectionDefenseMode];
  const injectionScreenProfile: InjectionScreenProfile =
    memoryInjectionDefenseMode === "custom" ? "default" : "hardened";
  const configuredOrigins = resolveUntrustedOrigins(cfg.untrustedOrigins, rawOperatorConfig);
  const untrustedOrigins =
    memoryInjectionDefenseMode !== "custom"
      && !hasExplicitUntrustedOrigins(cfg, rawOperatorConfig)
      ? [...HARDENED_UNTRUSTED_ORIGINS]
      : configuredOrigins;
  return {
    memoryInjectionDefenseMode,
    originAuthorityEnabled,
    injectionScreenEnabled,
    injectionScreenProfile,
    untrustedOrigins,
  };
}
