/**
 * Taxonomy types for the MECE knowledge directory.
 *
 * A taxonomy defines a set of categories that partition the knowledge
 * space so that every memory maps to exactly one category (Mutually
 * Exclusive, Collectively Exhaustive).
 */

/**
 * A single category in the taxonomy.
 *
 * @property id          - Slug: lowercase letters, digits, hyphens; max 32 chars.
 * @property name        - Human-readable display name.
 * @property description - What belongs in this category.
 * @property filingRules - Prose rules used by the resolver decision tree.
 * @property parentId    - Optional parent category for nesting.
 * @property priority    - Tie-breaker: lower number wins when a memory
 *                         could belong to multiple categories.
 * @property memoryCategories - Which MemoryCategory values map here.
 */
export interface TaxonomyCategory {
  id: string;
  name: string;
  description: string;
  filingRules: string[];
  parentId?: string;
  priority: number;
  memoryCategories: string[];
}

/**
 * A versioned taxonomy comprising an ordered list of categories.
 */
export interface Taxonomy {
  version: number;
  categories: TaxonomyCategory[];
}

/**
 * The output of the resolver: which category a piece of knowledge
 * belongs to, with confidence and alternatives.
 */
export interface ResolverDecision {
  categoryId: string;
  confidence: number;
  reason: string;
  alternatives: Array<{ categoryId: string; reason: string }>;
}
