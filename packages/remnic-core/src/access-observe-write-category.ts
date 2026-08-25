/**
 * Category-alias split + replay restamp for observe/write (#2829).
 * Extracted from access-observe-write-surface.ts to stay under the 1200-line cap.
 *
 * The wire schema already maps an alias to "fact". `rawCategory` is the
 * caller's spelling: it must not reach the write candidate or fingerprint,
 * and a replay must rebuild the note from THIS request's spelling.
 */
import {
  canonicalCategoryForAlias,
  categoryAliasCoercion,
  reapplyCategoryCoercion,
  type CategoryAliasCoercion,
  type MemoryCategoryAlias,
} from "./access-schema.js";

export { reapplyCategoryCoercion };
export { applyBriefingLocationContext } from "./location/tagging.js";

export function splitCanonicalWriteRequest<T extends { rawCategory?: string; category?: string }>(
  request: T,
): {
  canonical: Omit<T, "rawCategory">;
  categoryCoercion: CategoryAliasCoercion | undefined;
} {
  const { rawCategory, ...canonical } = request;
  // #2962: a direct service caller bypasses the wire schema, so an accepted
  // alias can still sit on `category`. Canonicalize it at the same boundary
  // the schema's transform covers for HTTP/MCP/CLI, minting the retained
  // spelling from the request itself. A schema-minted `rawCategory` always
  // wins (it names the spelling the transform actually canonicalized);
  // near-misses pass through untouched and reject at the write candidate
  // with the attempted category echoed.
  if (rawCategory === undefined && typeof canonical.category === "string") {
    const mapped = canonicalCategoryForAlias(canonical.category);
    if (mapped !== undefined) {
      const from = canonical.category as MemoryCategoryAlias;
      return {
        canonical: { ...canonical, category: mapped } as Omit<T, "rawCategory">,
        categoryCoercion: { from, to: mapped },
      };
    }
  }
  return { canonical, categoryCoercion: categoryAliasCoercion(rawCategory) };
}
