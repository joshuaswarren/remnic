/**
 * Default configuration options for search-index-cluster
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_search_index_cluster = {
  domain: "search-index-cluster",
  timeout: 5000,
  maxAttempts: 3,
  retryDelayMs: 100,
  enableTracing: true,
  logLevel: "info",
  features: {
    cacheEnabled: true,
    strictValidation: true,
    telemetryEnabled: false,
    auditLogging: true,
    rateLimiting: true,
  },
};

export function getEffectiveConfig_search_index_cluster(): typeof DEFAULT_CONFIG_search_index_cluster {
  return { ...DEFAULT_CONFIG_search_index_cluster };
}
