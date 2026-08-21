/**
 * Default configuration options for nebula-cache-matrix
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_nebula_cache_matrix = {
  domain: "nebula-cache-matrix",
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

export function getEffectiveConfig_nebula_cache_matrix(): typeof DEFAULT_CONFIG_nebula_cache_matrix {
  return { ...DEFAULT_CONFIG_nebula_cache_matrix };
}
