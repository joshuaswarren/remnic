/**
 * Shared boolean coercion helpers.
 *
 * Extracted from connectors/index.ts so that both config.ts and
 * connectors/index.ts can import them without creating a circular dependency.
 */

import { isLoggerInitialized, log } from "../logger.js";

const BOOL_TOKENS: Record<string, boolean> = {
  true: true, "1": true, yes: true, on: true,
  false: false, "0": false, no: false, off: false,
};

/**
 * Surface a "present but unrecognized config value" diagnostic. Routes through
 * the installed logger when a host has called `initLogger`, and otherwise falls
 * back to `console.warn` so the standalone `@remnic/core` path (documented to
 * call `parseConfig()` without a logger) does not silently discard the warning
 * and re-introduce the fail-open default this whole change exists to prevent.
 */
export function warnUnrecognizedConfig(message: string): void {
  if (isLoggerInitialized()) {
    log.warn(message);
  } else {
    console.warn(`remnic: ${message}`);
  }
}

/**
 * Generic boolean coercion: converts string representations of booleans
 * (e.g. from CLI `--config someFlag=false`) to proper boolean values.
 * Accepts the same truthy/falsy strings that common shells and env vars use.
 *
 * Returns `undefined` when the value is neither a boolean nor a recognised
 * string, so callers can fall back to a default.
 *
 * A value that is PRESENT but unrecognised (a non-empty string like `"disabled"`
 * or a typo like `"fales"`) is logged at warn level before returning `undefined`,
 * so an operator typo does not silently take the caller's default — which is
 * frequently a fail-open `?? true`. Absent values (`undefined`/`null`/empty
 * string) fall through silently: absence legitimately means "use the default".
 * Pass `label` (the config key) to make the warning actionable.
 *
 * CLAUDE.md gotcha #36: String "false" is truthy in JavaScript.
 * CLAUDE.md gotcha #28: Coerce CLI values to expected types at input boundaries.
 * CLAUDE.md gotcha #51: Reject/flag present-but-unrecognized values; don't
 * silently default them.
 */
export function coerceBool(value: unknown, label?: string): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "") return undefined;
    if (Object.hasOwn(BOOL_TOKENS, v)) return BOOL_TOKENS[v];
    warnUnrecognizedConfig(
      `ignoring unrecognized boolean value ${JSON.stringify(value)}${label ? ` for ${label}` : ""}; ` +
        `expected true|false|1|0|yes|no|on|off — using default`,
    );
  }
  return undefined;
}

/**
 * Coerce the `installExtension` config value from a string (e.g. from CLI
 * `--config installExtension=false`) to a proper boolean.
 *
 * Delegates to the generic `coerceBool` helper. Kept for backward compatibility.
 */
export function coerceInstallExtension(value: unknown): boolean | undefined {
  return coerceBool(value, "installExtension");
}

/**
 * Generic numeric coercion: accepts a finite number or a string that
 * parses cleanly to one. Returns `undefined` otherwise so callers can
 * fall back to a default.
 *
 * Rules:
 * - number: returned as-is only if finite (NaN / ±Infinity → undefined).
 * - string: trimmed, parsed with `Number()`. Returns `undefined` on
 *   empty, NaN, or Infinity.
 *
 * A PRESENT but unparseable string (a non-empty value that is not a finite
 * number) is logged at warn level before returning `undefined`, for the same
 * reason as `coerceBool`: a typo must not silently take the caller's default.
 * Absent values (`undefined`/`null`/empty string) fall through silently.
 * Pass `label` (the config key) to make the warning actionable.
 *
 * CLAUDE.md gotcha #28: Coerce CLI values to expected types at input boundaries.
 * CLAUDE.md gotcha #51: Flag present-but-unrecognized values.
 */
export function coerceNumber(value: unknown, label?: string): number | undefined {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    warnUnrecognizedConfig(
      `ignoring non-finite numeric value ${JSON.stringify(value)}${label ? ` for ${label}` : ""}; ` +
        `expected a finite number — using default`,
    );
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
    warnUnrecognizedConfig(
      `ignoring unrecognized numeric value ${JSON.stringify(value)}${label ? ` for ${label}` : ""}; ` +
        `expected a finite number — using default`,
    );
  }
  return undefined;
}

/**
 * Config-layer boolean coercion. Adds numeric 1/0 handling on top of the
 * canonical `coerceBool` because config values can arrive as JSON numbers,
 * which `coerceBool` intentionally does not accept. Any other present-but-
 * unrecognized value (string typo or out-of-range number) warns and returns
 * `undefined` so a caller's fail-open `?? true` default is not taken silently.
 *
 * CLAUDE.md gotcha #36: string "false" is truthy in JavaScript.
 */
export function coerceBooleanLike(value: unknown, label?: string): boolean | undefined {
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    warnUnrecognizedConfig(
      `ignoring unrecognized boolean value ${JSON.stringify(value)}${label ? ` for ${label}` : ""}; ` +
        `expected true|false|1|0|yes|no|on|off — using default`,
    );
    return undefined;
  }
  return coerceBool(value, label);
}
