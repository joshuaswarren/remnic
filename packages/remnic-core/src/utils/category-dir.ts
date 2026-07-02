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

/**
 * Category directories whose files are NOT part of the recall memory corpus.
 *
 * `questions/` holds operational question-QUEUE items written by
 * `StorageManager.writeQuestion()` (frontmatter `{ id, created, priority,
 * resolved }`, body `<question>\n\n**Context:** ...`). They are read only via
 * `readQuestions()` and surfaced through the dedicated, disabled-by-default
 * `injectQuestions` recall-pipeline stage (`{"id":"questions","enabled":false}`)
 * — never as standard frontmatter-backed recall memories. The QMD primary
 * recall path treats them the same way (they are not part of the `memories`
 * corpus), so the filesystem fallback must not pull them into recall either.
 */
export const RECALL_NON_MEMORY_DIRS: ReadonlySet<string> = new Set(["questions"]);

/**
 * Category directories the filesystem-fallback recall scan should read.
 *
 * This is `ALL_CATEGORY_DIRS` minus the non-memory queue dirs in
 * `RECALL_NON_MEMORY_DIRS`. It is the single source of truth for the corpus the
 * QMD-unavailable fallback (`StorageManager.collectActiveMemoryPaths()`) treats
 * as recall memories — kept in parity with the QMD primary recall corpus.
 */
export const RECALL_FALLBACK_DIRS: string[] = ALL_CATEGORY_DIRS.filter(
  (dir) => !RECALL_NON_MEMORY_DIRS.has(dir),
);

/** All category keys (singular form) — used when iterating categories and calling getCategoryDir. */
export const ALL_CATEGORY_KEYS: string[] = [
  "fact",
  ...Object.keys(CATEGORY_DIR_MAP),
];

/**
 * Relative directory NAME for a category (e.g. "decisions"); "facts" for
 * unknown / `fact` / `entity`. Single source of truth shared by every write,
 * path-derivation, and tier-move site — never inline a category→dir ternary.
 */
export function categoryDirName(category: string): string {
  return Object.hasOwn(CATEGORY_DIR_MAP, category) ? CATEGORY_DIR_MAP[category] : "facts";
}

/**
 * Resolve a category name to its directory path under memoryDir.
 * Falls back to `facts/` for unknown categories.
 */
export function getCategoryDir(memoryDir: string, category: string): string {
  return path.join(memoryDir, categoryDirName(category));
}
