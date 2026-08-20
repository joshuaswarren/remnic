/**
 * Merged-content acceptance check (issue #2330).
 *
 * A judge-merged body that is blank or a runaway continuation is refused so
 * the write path can fall back to create. `mergedContent` arrives from a
 * model and gets a typed refusal; non-string `incomingContent`/
 * `targetContent` is a caller bug and throws. Internal helper; wiring into
 * the write path is a later slice.
 */
export const MERGE_CONTENT_LENGTH_FACTOR = 4;

export type MergeContentCheck =
  | { ok: true; content: string }
  | { ok: false; reason: "empty" | "oversized"; limit: number };

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`merge ${field} must be a string`);
  }
  return value;
}

export function checkMergedContent(input: {
  mergedContent: unknown;
  incomingContent: string;
  targetContent: string;
}): MergeContentCheck {
  const incoming = requireString(input.incomingContent, "incomingContent");
  const target = requireString(input.targetContent, "targetContent");
  const limit = MERGE_CONTENT_LENGTH_FACTOR * (incoming.length + target.length);

  const merged = input.mergedContent;
  if (typeof merged !== "string" || merged.trim() === "") {
    return { ok: false, reason: "empty", limit };
  }
  if (merged.length > limit) {
    return { ok: false, reason: "oversized", limit };
  }
  return { ok: true, content: merged };
}
