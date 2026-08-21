/**
 * Loads and validates a user-customized taxonomy from disk, merging
 * with the built-in defaults.
 *
 * User taxonomies are stored at `<memoryDir>/.taxonomy/taxonomy.json`.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Taxonomy, TaxonomyCategory } from "./types.js";
import { DEFAULT_TAXONOMY } from "./default-taxonomy.js";

const TAXONOMY_DIR = ".taxonomy";
const TAXONOMY_FILE = "taxonomy.json";

/** Maximum allowed slug length */
const MAX_SLUG_LENGTH = 32;

/** Regex for valid slug: lowercase letters, digits, hyphens */
const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const VALID_MEMORY_CATEGORIES = new Set([
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
  "procedure",
  "reasoning_trace",
]);

/**
 * Validate a taxonomy category slug.
 * Throws if the slug is invalid.
 */
export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new Error("Taxonomy category ID must not be empty");
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `Taxonomy category ID "${slug}" exceeds ${MAX_SLUG_LENGTH} characters`,
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Taxonomy category ID "${slug}" is invalid: must be lowercase letters, digits, and hyphens, starting with a letter`,
    );
  }
}

/**
 * Validate an entire taxonomy for structural correctness.
 * Throws on the first error found.
 */
export function validateTaxonomy(taxonomy: Taxonomy): void {
  if (typeof taxonomy.version !== "number" || taxonomy.version < 1) {
    throw new Error("Taxonomy version must be a positive integer");
  }
  if (!Array.isArray(taxonomy.categories)) {
    throw new Error("Taxonomy categories must be an array");
  }

  const seenIds = new Set<string>();
  for (const cat of taxonomy.categories) {
    validateSlug(cat.id);
    if (seenIds.has(cat.id)) {
      throw new Error(`Duplicate taxonomy category ID: "${cat.id}"`);
    }
    seenIds.add(cat.id);

    if (typeof cat.name !== "string" || cat.name.trim().length === 0) {
      throw new Error(`Taxonomy category "${cat.id}" must have a non-empty name`);
    }
    if (typeof cat.description !== "string" || cat.description.trim().length === 0) {
      throw new Error(`Taxonomy category "${cat.id}" must have a non-empty description`);
    }
    if (!Array.isArray(cat.filingRules)) {
      throw new Error(`Taxonomy category "${cat.id}" filingRules must be an array`);
    }
    for (const [index, rule] of cat.filingRules.entries()) {
      if (typeof rule !== "string" || rule.trim().length === 0) {
        throw new Error(
          `Taxonomy category "${cat.id}" filingRules[${index}] must be a non-empty string`,
        );
      }
    }
    if (typeof cat.priority !== "number" || !Number.isFinite(cat.priority)) {
      throw new Error(`Taxonomy category "${cat.id}" must have a finite numeric priority`);
    }
    if (!Array.isArray(cat.memoryCategories)) {
      throw new Error(`Taxonomy category "${cat.id}" memoryCategories must be an array`);
    }
    for (const [index, memoryCategory] of cat.memoryCategories.entries()) {
      if (typeof memoryCategory !== "string" || memoryCategory.trim().length === 0) {
        throw new Error(
          `Taxonomy category "${cat.id}" memoryCategories[${index}] must be a non-empty string`,
        );
      }
      if (!VALID_MEMORY_CATEGORIES.has(memoryCategory)) {
        throw new Error(
          `Taxonomy category "${cat.id}" memoryCategories[${index}] is unknown: "${memoryCategory}"`,
        );
      }
    }
    if (cat.parentId !== undefined) {
      if (typeof cat.parentId !== "string") {
        throw new Error(`Taxonomy category "${cat.id}" parentId must be a string if set`);
      }
    }
  }

  // Validate parentId references
  for (const cat of taxonomy.categories) {
    if (cat.parentId !== undefined && !seenIds.has(cat.parentId)) {
      throw new Error(
        `Taxonomy category "${cat.id}" references unknown parentId "${cat.parentId}"`,
      );
    }
  }
}

/**
 * Load a taxonomy from the user's memory directory.
 *
 * If `<memoryDir>/.taxonomy/taxonomy.json` exists, loads it, validates
 * it, and merges with the defaults (user categories override defaults
 * by ID). If the file does not exist, returns the defaults.
 */
export async function loadTaxonomy(memoryDir: string): Promise<Taxonomy> {
  const taxonomyPath = path.join(memoryDir, TAXONOMY_DIR, TAXONOMY_FILE);
  let raw: string;
  try {
    raw = await readFile(taxonomyPath, "utf-8");
  } catch (err: unknown) {
    // Only fall back to defaults for missing file; rethrow permission / I/O errors
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULT_TAXONOMY);
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("taxonomy.json must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    throw new Error("taxonomy.json version must be a number");
  }
  if (!Array.isArray(obj.categories)) {
    throw new Error("taxonomy.json categories must be an array");
  }

  const userVersion = obj.version;
  const userCategories = obj.categories as TaxonomyCategory[];

  // Validate: reject duplicate IDs in user categories before merging.
  // Without this check, duplicates are silently collapsed with last-write-wins
  // semantics when inserted into the Map.
  const userIdCounts = new Map<string, number>();
  for (const cat of userCategories) {
    const id = typeof cat.id === "string" ? cat.id : String(cat.id);
    userIdCounts.set(id, (userIdCounts.get(id) ?? 0) + 1);
  }
  const duplicateIds = [...userIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Duplicate category IDs in taxonomy.json: ${duplicateIds.map((id) => `"${id}"`).join(", ")}`,
    );
  }

  // Merge: user categories override defaults by ID
  const mergedMap = new Map<string, TaxonomyCategory>();
  for (const cat of DEFAULT_TAXONOMY.categories) {
    mergedMap.set(cat.id, { ...cat });
  }
  for (const cat of userCategories) {
    mergedMap.set(cat.id, cat);
  }

  const merged: Taxonomy = {
    version: userVersion,
    categories: [...mergedMap.values()],
  };

  validateTaxonomy(merged);
  return merged;
}

/**
 * Save a taxonomy to the user's memory directory.
 */
export async function saveTaxonomy(
  memoryDir: string,
  taxonomy: Taxonomy,
): Promise<void> {
  validateTaxonomy(taxonomy);
  const dir = path.join(memoryDir, TAXONOMY_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, TAXONOMY_FILE);
  await writeFile(filePath, JSON.stringify(taxonomy, null, 2) + "\n", "utf-8");
}

/**
 * Get the taxonomy directory path for a given memory directory.
 */
export function getTaxonomyDir(memoryDir: string): string {
  return path.join(memoryDir, TAXONOMY_DIR);
}

/**
 * Get the taxonomy file path for a given memory directory.
 */
export function getTaxonomyFilePath(memoryDir: string): string {
  return path.join(memoryDir, TAXONOMY_DIR, TAXONOMY_FILE);
}
