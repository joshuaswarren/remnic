/**
 * Language sniffing — map a file path to a tier-1 CodingGraphLanguage by
 * its extension. Used when `ParseFileInput.language` is omitted.
 *
 * If the path doesn't match any tier-1 extension, returns `null` and the
 * engine emits a `parse_failed` result (rule 44 — no silent skip).
 */
import { TIER_1_LANGUAGES, type CodingGraphLanguage } from "@remnic/core";

/** Extension (lowercase, dot-prefixed) → language. Static table. */
const EXTENSION_MAP: Record<string, CodingGraphLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
};

/**
 * Sniff the tier-1 language from a file path's extension.
 * Returns `null` if the extension is not recognized.
 */
export function sniffLanguage(filePath: string): CodingGraphLanguage | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

/** Return true if `lang` is a valid tier-1 language. */
export function isTier1Language(lang: string): lang is CodingGraphLanguage {
  return (TIER_1_LANGUAGES as readonly string[]).includes(lang);
}
