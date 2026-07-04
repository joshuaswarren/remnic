/**
 * emit-legacy-tools — resolution cluster for the `emitLegacyTools` and
 * `namespaceCatalogEnabled` config gates (issues #1427, #1499, #1550).
 *
 * Extracted from packages/remnic-core/src/config.ts (PR #1593, round 6)
 * so the raw-vs-effective split, runtime-override precedence, and
 * fileConfig-null normalization logic specific to these two gates
 * stays out of the god-file `config.ts`. The export surface is exactly
 * the two resolvers plus the `coerceBooleanLikeOrThrow` helper that
 * wraps the local `coerceBooleanLike` — every other config gate in
 * `parseConfig` keeps using its own inline coercion or the
 * `coerceBooleanLike` already exported from
 * `packages/remnic-core/src/connectors/coerce.ts`.
 *
 * Precedence (PR #1593 rounds 1-4, plus the null/loader hardening from
 * rounds 3-5):
 *
 *   1. `configValue` (the first arg) is the MERGED config
 *      (runtime-over-file via the
 *      `{...fileConfig, ...api.pluginConfig}` spread in src/index.ts).
 *      If it's a real boolean, it represents what the operator wants,
 *      so honor it. We only fall through when it's the schema-default
 *      materialization with no operator authoring in raw.
 *   2. `rawOperatorConfig` (the second arg) is the operator-supplied
 *      config block BEFORE the OpenClaw manifest layer applies schema
 *      defaults — i.e. the file-backed `loadPluginConfigFromFile` output.
 *      When raw has the key with a non-null/undefined value, the file
 *      layer authored it. The merged `configValue` reflects the full
 *      operator intent (file + runtime), so `configValue` is still
 *      authoritative. raw presence is used only as the "operator
 *      authored this key" signal — if raw is missing AND configValue
 *      equals the schema default, only the schema layer materialized the
 *      key (no operator intent anywhere) and we fall through to env /
 *      sticky-legacy.
 *   3. Legacy callers (raw undefined): trust configValue as before to
 *      preserve the 121+ existing call sites that pass only one arg.
 *
 * Defensive normalization (PR #1593 round 3): JSON null on disk for the
 * operator config block surfaces as `null` in rawOperatorConfig. Both
 * resolvers normalize `null` to `{}` so the `"key" in rawOperatorConfig`
 * check never throws. The file loader
 * (`loadPluginConfigFromFile`) also normalizes null to undefined
 * before reaching here.
 */

import { readEnvVar } from "./runtime/env.js";
import { hasLegacyConnectorEntries } from "./connectors/paths.js";

/**
 * Coerce common string/number representations of a boolean to a real
 * boolean. Returns `undefined` when the value cannot be interpreted, so
 * callers can fail fast via `coerceBooleanLikeOrThrow`. Guards against
 * the "string `false` is truthy" footgun (CLAUDE.md gotcha #36) when
 * config values arrive from CLI/env/JSON sources where booleans are
 * sometimes string-typed.
 *
 * Local copy — the canonical implementation lives in
 * `packages/remnic-core/src/connectors/coerce.ts` but is private to that
 * module's `coerceBool` export; duplicating here keeps the god-file
 * contract clean (no cross-module pull) for the two gates that need
 * fail-fast rejection.
 */
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

/**
 * Coerce a present boolean-like gate value or fail fast. A PRESENT but
 * unrecognized value ("fales", 2) is REJECTED rather than silently
 * defaulting (CLAUDE.md rule #51) — shared by both resolvers below so
 * the rejection behavior cannot drift between them.
 */
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
  // Defensive null normalization — see file header for the rationale.
  if (rawOperatorConfig === null) rawOperatorConfig = {};
  // Schema default for `emitLegacyTools` is `false` (issue #1550).
  const SCHEMA_DEFAULT = false;
  // Round 8: `runtimeAuthored` is now informational only — the resolver
  // does not consult it (see the comment on the check below). Kept as a
  // local so the signature-bound `runtimeSet` parameter remains useful
  // for future refactors and tests can read this state if needed.
  const runtimeAuthored = runtimeSet?.has("emitLegacyTools") ?? false;
  if (rawOperatorConfig !== undefined) {
    if (configValue !== undefined && configValue !== null) {
      const rawValue = (rawOperatorConfig as Record<string, unknown>).emitLegacyTools;
      const rawAuthored =
        "emitLegacyTools" in rawOperatorConfig &&
        rawValue !== null &&
        rawValue !== undefined;
      // Round 8 (PR #1593): revert the runtimeAuthored gate. OpenClaw's
      // `applyDefaults: true` materialization means api.pluginConfig keys
      // can't reliably signal operator authorship; the schema-default
      // comparison alone is the right signal (chatgpt-codex-connector P1
      // on src/index.ts:1348, round 8).
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
    // Legacy caller (no rawOperatorConfig) — trust the merged value.
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
  // Defensive null normalization — see file header for the rationale.
  if (rawOperatorConfig === null) rawOperatorConfig = {};
  // Schema default is `true` (the catalog is opt-out).
  const SCHEMA_DEFAULT = true;
  // Round 8: same as the emit variant — `runtimeAuthored` is
  // informational only, the resolver does not consult it.
  const runtimeAuthored = runtimeSet?.has("namespaceCatalogEnabled") ?? false;
  if (rawOperatorConfig !== undefined) {
    if (configValue !== undefined && configValue !== null) {
      const rawValue = (rawOperatorConfig as Record<string, unknown>)
        .namespaceCatalogEnabled;
      const rawAuthored =
        "namespaceCatalogEnabled" in rawOperatorConfig &&
        rawValue !== null &&
        rawValue !== undefined;
      // Round 8: same rollback as resolveEmitLegacyTools.
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
    // Legacy caller (no rawOperatorConfig) — trust the merged value.
    return coerceBooleanLikeOrThrow("namespaceCatalogEnabled", configValue);
  }
  return SCHEMA_DEFAULT;
}