/**
 * Input validation for the `remnic why` command (issue #3033).
 *
 * Extracted from the CLI handlers so the validation paths are unit-testable
 * without booting an orchestrator — the same split `recall-xray-cli.ts`
 * uses. Every flag rejects a missing or unknown value with a listed-options
 * error instead of silently defaulting (Review Prevention Checklist #1 /
 * #39).
 */

import { parseRecallWhyFormat, type RecallWhyFormat } from "./recall-why-renderer.js";

export interface ParsedWhyCliOptions {
  format: RecallWhyFormat;
  /** Memory id or substring to trace, or undefined when not specified. */
  expect?: string;
  /** Trimmed namespace, or undefined when not specified. */
  namespace?: string;
  /** Trimmed session key, or undefined when not specified. */
  session?: string;
  /** Trimmed, tilde-unexpanded output path, or undefined when stdout. */
  outPath?: string;
}

export function parseWhyCliOptions(
  rawQuery: unknown,
  options: Record<string, unknown>
): { query: string } & ParsedWhyCliOptions {
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    throw new Error("why expects a non-empty query argument");
  }
  const format = parseRecallWhyFormat(Object.hasOwn(options, "format") ? options.format : undefined);
  return {
    query: rawQuery,
    format,
    ...maybeStringFlag(options, "expect"),
    ...maybeStringFlag(options, "namespace"),
    ...maybeStringFlag(options, "session"),
    ...maybeStringFlag(options, "out", "outPath"),
  };
}

/**
 * Read one optional string flag. `--flag` with no value arrives as `true`
 * from commander and must fail rather than be reinterpreted as "not
 * supplied"; a whitespace-only value is likewise a caller mistake, not a
 * request for the default.
 */
function maybeStringFlag(options: Record<string, unknown>, flag: string, key = flag): Record<string, string> {
  // `Object.hasOwn` + own-property enumeration: a value inherited from a
  // doctored prototype must never enable a flag (checklist #46).
  if (!Object.hasOwn(options, flag)) return {};
  const value = options[flag];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${flag} expects a non-empty value`);
  }
  return { [key]: value.trim() };
}
