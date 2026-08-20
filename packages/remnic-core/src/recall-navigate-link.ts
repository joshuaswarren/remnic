/**
 * Recall navigation link-type parse (issue #1956).
 *
 * One allow-list covering BOTH vocabularies a traversal can meet:
 * the navigation set this module originally defined and the persisted
 * `MemoryLinkType` values (`follows | references | related`) that real
 * memory frontmatter carries. Review found the narrower list silently
 * dropped every persisted `follows`/`references`/`related` edge and
 * rejected `relation: "related"` as unknown — a traversal over actual
 * stored links would lose valid neighbors. Surfaces wait.
 */

const NAVIGATE_LINK_TYPES = [
  "supports",
  "contradicts",
  "elaborates",
  "causes",
  "caused_by",
  // Persisted MemoryLinkType values (types.ts) that real frontmatter carries.
  "follows",
  "references",
  "related",
  // The stepper's own navigation contract (recall-navigate.ts) accepts
  // supersedes; omitting it here would reject a relation that surface is
  // prepared to handle.
  "supersedes",
] as const;

export type NavigateLinkType = (typeof NAVIGATE_LINK_TYPES)[number];

export type ParseNavigateLinkTypeResult =
  | { ok: true; type: NavigateLinkType }
  | { ok: false; error: "unknown_link" };

export function parseNavigateLinkType(value: string): ParseNavigateLinkTypeResult {
  if ((NAVIGATE_LINK_TYPES as readonly string[]).includes(value)) {
    return { ok: true, type: value as NavigateLinkType };
  }
  return { ok: false, error: "unknown_link" };
}
