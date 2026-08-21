/**
 * Enrichment pipeline barrel export (issue #365).
 */

export type {
  EnrichmentCandidate,
  EnrichmentCostTier,
  EnrichmentPipelineConfig,
  EnrichmentProvider,
  EnrichmentProviderConfig,
  EnrichmentResult,
  EntityEnrichmentInput,
} from "./types.js";

export { defaultEnrichmentPipelineConfig } from "./types.js";

export { EnrichmentProviderRegistry } from "./provider-registry.js";

export { WebSearchProvider, type WebSearchFn, type WebSearchProviderOptions } from "./web-search-provider.js";

export { runEnrichmentPipeline } from "./pipeline.js";

export {
  appendAuditEntry,
  readAuditLog,
  type EnrichmentAuditEntry,
} from "./audit.js";
