/**
 * @remnic/core — Category Directory Map
 *
 * Shared mapping of memory category names to directory names.
 * Single source of truth — import from here instead of copy-pasting.
 */

import path from "node:path";

export const CATEGORY_DIR_MAP: Record<string, string> = {
  correction: "corrections",
  question: "questions",
  preference: "preferences",
  decision: "decisions",
  moment: "moments",
  commitment: "commitments",
  principle: "principles",
  rule: "rules",
  skill: "skills",
  relationship: "relationships",
  procedure: "procedures",
  reasoning_trace: "reasoning-traces",
};

/** All directory names derived from CATEGORY_DIR_MAP, plus "facts" (the default). */
export const ALL_CATEGORY_DIRS: string[] = [
  "facts",
  ...Object.values(CATEGORY_DIR_MAP),
];

/** All category keys (singular form) — used when iterating categories and calling getCategoryDir. */
export const ALL_CATEGORY_KEYS: string[] = [
  "fact",
  ...Object.keys(CATEGORY_DIR_MAP),
];

/**
 * Resolve a category name to its directory path under memoryDir.
 * Falls back to `facts/` for unknown categories.
 */
export function getCategoryDir(memoryDir: string, category: string): string {
  const dir = Object.hasOwn(CATEGORY_DIR_MAP, category)
    ? CATEGORY_DIR_MAP[category]
    : undefined;
  return dir ? path.join(memoryDir, dir) : path.join(memoryDir, "facts");
}
