
import { readEnvVar } from "./runtime/env.js";
import { hasLegacyConnectorEntries } from "./connectors/paths.js";

function coerceBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return undefined;
}

function coerceBooleanLikeOrThrow(label: string, value: unknown): boolean {
  const coerced = coerceBooleanLike(value);
  if (coerced === undefined) {
    throw new Error(
      `${label} must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

/**
 * Resolve the `emitLegacyTools` opt-out (issue #1427, defaults revised in
 * #1550). Precedence: operator-set raw config, then merged (post-defaults)
 * config, then the REMNIC_/ENGRAM_ env var, then a sticky-legacy default —
 * `true` only when existing legacy connector entries are present on disk
 * (`hasLegacyConnectorEntries`), `false` for fresh installs.
 */
export function resolveEmitLegacyTools(
  configValue: unknown,
  rawOperatorConfig: Record<string, unknown> | undefined | null,
  runtimeSet?: ReadonlySet<string>,
): boolean {
  if (rawOperatorConfig === null) rawOperatorConfig = {};
  const SCHEMA_DEFAULT = false;
  const runtimeAuthored = runtimeSet?.has("emitLegacyTools") ?? false;
  if (rawOperatorConfig !== undefined) {
    if (configValue !== undefined && configValue !== null) {
      const rawValue = (rawOperatorConfig as Record<string, unknown>).emitLegacyTools;
      const rawAuthored =
        "emitLegacyTools" in rawOperatorConfig &&
        rawValue !== null &&
        rawValue !== undefined;
      if (rawAuthored || configValue !== SCHEMA_DEFAULT) {
        return coerceBooleanLikeOrThrow("emitLegacyTools", configValue);
      }
    } else if ("emitLegacyTools" in rawOperatorConfig) {
      const rawValue = (rawOperatorConfig as Record<string, unknown>).emitLegacyTools;
      if (rawValue !== null && rawValue !== undefined) {
        return coerceBooleanLikeOrThrow("emitLegacyTools", rawValue);
      }
    }
  } else if (configValue !== undefined && configValue !== null) {
    return coerceBooleanLikeOrThrow("emitLegacyTools", configValue);
  }
  const envRaw =
    readEnvVar("REMNIC_EMIT_LEGACY_TOOLS") ?? readEnvVar("ENGRAM_EMIT_LEGACY_TOOLS");
  if (envRaw !== undefined) {
    return coerceBooleanLikeOrThrow("REMNIC_EMIT_LEGACY_TOOLS", envRaw);
  }
  return hasLegacyConnectorEntries();
}

/**
 * Resolve the `namespaceCatalogEnabled` opt-out (issue #1499). Same
 * raw-vs-effective split as `resolveEmitLegacyTools` — schema-default
 * hardening at the helper level so adding a `false` default later cannot
 * silently flip behavior on upgraded installs (#1550 class hardening).
 */
export function resolveNamespaceCatalogEnabled(
  configValue: unknown,
  rawOperatorConfig: Record<string, unknown> | undefined | null,
  runtimeSet?: ReadonlySet<string>,
): boolean {
  if (rawOperatorConfig === null) rawOperatorConfig = {};
  // Schema default is `true` (the catalog is opt-out).
  const SCHEMA_DEFAULT = true;
  const runtimeAuthored = runtimeSet?.has("namespaceCatalogEnabled") ?? false;
  if (rawOperatorConfig !== undefined) {
    if (configValue !== undefined && configValue !== null) {
      const rawValue = (rawOperatorConfig as Record<string, unknown>)
        .namespaceCatalogEnabled;
      const rawAuthored =
        "namespaceCatalogEnabled" in rawOperatorConfig &&
        rawValue !== null &&
        rawValue !== undefined;
      if (rawAuthored || configValue !== SCHEMA_DEFAULT) {
        return coerceBooleanLikeOrThrow("namespaceCatalogEnabled", configValue);
      }
    } else if ("namespaceCatalogEnabled" in rawOperatorConfig) {
      const rawValue = (rawOperatorConfig as Record<string, unknown>)
        .namespaceCatalogEnabled;
      if (rawValue !== null && rawValue !== undefined) {
        return coerceBooleanLikeOrThrow("namespaceCatalogEnabled", rawValue);
      }
    }
  } else if (configValue !== undefined && configValue !== null) {
    return coerceBooleanLikeOrThrow("namespaceCatalogEnabled", configValue);
  }
  return SCHEMA_DEFAULT;
}