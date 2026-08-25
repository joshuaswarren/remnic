/**
 * Merged-content acceptance check (issue #2330).
 *
 * A judge-merged body that is blank, a runaway continuation, or text the
 * storage sanitizer would rewrite is refused so the write path can fall back
 * to create. `mergedContent` arrives from a model and gets a typed refusal;
 * non-string `incomingContent`/`targetContent` is a caller bug and throws.
 * Internal helper; wiring into the write path is a later slice.
 */

import { sanitizeMemoryContent } from "../sanitize.js";

export const MERGE_CONTENT_LENGTH_FACTOR = 4;
export type MergeContentCheck =
  | { ok: true; content: string }
  | { ok: false; reason: "empty" | "oversized" | "unsafe"; limit: number };

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
  // Storage persists `sanitizeMemoryContent(text).text`, so a merged body the
  // sanitizer would rewrite can never round-trip: the persist-side CAS and
  // provenance equality checks compare the RAW judge output, and a target
  // holding the sanitization placeholder reads back as a concurrent
  // replacement — the rollback then "succeeds" while the original body is
  // lost and the caller also creates the fact. Refusing here means the merge
  // decision becomes a create and no mutation ever runs. Checked before the
  // length limit: an injection-pattern body is refused as unsafe whatever its
  // length.
  if (!sanitizeMemoryContent(merged).clean) {
    return { ok: false, reason: "unsafe", limit };
  }
  if (merged.length > limit) {
    return { ok: false, reason: "oversized", limit };
  }
  return { ok: true, content: merged };
}
