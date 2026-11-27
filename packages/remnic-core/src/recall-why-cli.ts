
import { parseRecallWhyFormat, type RecallWhyFormat } from "./recall-why-renderer.js";

export interface ParsedWhyCliOptions {
  format: RecallWhyFormat;
  expect?: string;
  namespace?: string;
  session?: string;
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
  if (!Object.hasOwn(options, flag)) return {};
  const value = options[flag];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${flag} expects a non-empty value`);
  }
  return { [key]: value.trim() };
}
