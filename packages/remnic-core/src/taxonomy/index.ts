/**
 * MECE Taxonomy — Knowledge directory with resolver decision tree.
 *
 * Re-exports all public types and functions from the taxonomy subsystem.
 */

export type {
  Taxonomy,
  TaxonomyCategory,
  ResolverDecision,
} from "./types.js";

export { DEFAULT_TAXONOMY } from "./default-taxonomy.js";

export { resolveCategory } from "./resolver.js";

export { generateResolverDocument } from "./resolver-doc-generator.js";

export {
  loadTaxonomy,
  saveTaxonomy,
  validateSlug,
  validateTaxonomy,
  getTaxonomyDir,
  getTaxonomyFilePath,
} from "./taxonomy-loader.js";
