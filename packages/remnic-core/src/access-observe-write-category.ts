/**
 * Category-alias split + replay restamp for observe/write (#2829).
 * Extracted from access-observe-write-surface.ts to stay under the 1200-line cap.
 *
 * The wire schema already maps an alias to "fact". `rawCategory` is the
 * caller's spelling: it must not reach the write candidate or fingerprint,
 * and a replay must rebuild the note from THIS request's spelling.
 */
import {
  categoryAliasCoercion,
  reapplyCategoryCoercion,
  type CategoryAliasCoercion,
} from "./access-schema.js";

export { reapplyCategoryCoercion };

export function splitCanonicalWriteRequest<T extends { rawCategory?: string }>(
  request: T,
): {
  canonical: Omit<T, "rawCategory">;
  categoryCoercion: CategoryAliasCoercion | undefined;
} {
  const { rawCategory, ...canonical } = request;
  return { canonical, categoryCoercion: categoryAliasCoercion(rawCategory) };
}
