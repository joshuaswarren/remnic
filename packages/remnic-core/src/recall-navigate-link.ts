
const NAVIGATE_LINK_TYPES = [
  "supports",
  "contradicts",
  "elaborates",
  "causes",
  "caused_by",
  "follows",
  "references",
  "related",
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
